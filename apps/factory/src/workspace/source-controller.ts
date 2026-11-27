import { and, eq, sql as expression, gt, ne, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  developmentWorkspace,
  project,
  runtimeAttempt,
  substrateSource,
  ticket,
  workspaceSharedDocument,
} from "#db/schema";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import type { WorkspaceSourceState } from "#workspace-domain/source";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { createAgentTurnStore } from "../agent/turns-api";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import { boundedSourceBody } from "./source-body";
import { admitInitialSource } from "./source-initialization";
import {
  initialSourceRoleIn,
  retainedSourcePreparationIn,
  type SourceRoleFence,
} from "./source-role-fence";
import type { createSubstrateSources } from "./substrate-source";

type Database = ReturnType<typeof createDatabase>;
type SourceSQL = Database["client"] | DatabaseTransaction;
export interface SourceWorkspaceView {
  readonly workspaceID: string;
  readonly label: string;
  readonly state: WorkspaceSourceState;
  readonly serviceID: string;
  readonly epoch: number;
  readonly failure: string | null;
}

// Source reads and saves use the canonical writer. Initial admission may create
// a Source-only Workspace, never compute or a second execution path.
export function createWorkspaceSourceController(
  database: Database,
  hub: Pick<RuntimeHub, "sourceConnected" | "parentConnected">,
  sources: ReturnType<typeof createSubstrateSources>,
  options?: {
    supportsInitialRole?(attemptID: string, sql: DatabaseTransaction): Promise<boolean>;
    // Await authenticated resume and this Actor's Source transport, not App health.
    wakeForAccess?(
      workspaceID: string,
      userID: string,
      signal?: AbortSignal,
      write?: boolean,
    ): Promise<void>;
  },
) {
  const streams = new Map<
    AbortController,
    { userID: string; projectID: string; workspaceID: string }
  >();
  const pendingWakes = new Set<AbortController>();
  let closed = false;
  async function nativeRow(workspaceID: string, sql: SourceSQL = database.client) {
    const db = drizzleTransaction(sql);
    const newer = alias(runtimeAttempt, "newer");
    const [current] = await db
      .select({
        workspaceID: developmentWorkspace.id,
        projectName: project.name,
        kind: developmentWorkspace.kind,
        ticketTitle: ticket.title,
        attemptID: runtimeAttempt.id,
        runtimeState: runtimeAttempt.state,
        generation: expression<string | null>`${runtimeAttempt.generation}::text`,
        ready: expression<boolean>`(${runtimeAttempt.state}='ready'
          AND ${runtimeAttempt.stopIntendedAt} IS NULL AND ${runtimeAttempt.actorUid} IS NOT NULL
          AND ${runtimeAttempt.deleteIntendedAt} IS NULL AND ${runtimeAttempt.deletedAt} IS NULL
          AND (${substrateSource.owner}='service' OR ${substrateSource.actorUid}=${runtimeAttempt.actorUid}))`,
        readable: expression<boolean>`(${runtimeAttempt.state} IN ('starting','ready')
          AND ${runtimeAttempt.stopIntendedAt} IS NULL AND ${runtimeAttempt.actorUid} IS NOT NULL
          AND ${runtimeAttempt.deleteIntendedAt} IS NULL AND ${runtimeAttempt.deletedAt} IS NULL
          AND ${substrateSource.actorUid}=${runtimeAttempt.actorUid})`,
        sourceOwner: substrateSource.owner,
        sourceWritable: substrateSource.writable,
        sourceEpoch: expression<string | null>`${substrateSource.writerEpoch}::text`,
      })
      .from(developmentWorkspace)
      .innerJoin(project, eq(project.id, developmentWorkspace.projectId))
      .leftJoin(ticket, eq(ticket.id, developmentWorkspace.ticketId))
      .leftJoin(
        runtimeAttempt,
        and(
          eq(runtimeAttempt.workspaceId, developmentWorkspace.id),
          notExists(
            db
              .select({ id: newer.id })
              .from(newer)
              .where(
                and(
                  eq(newer.workspaceId, developmentWorkspace.id),
                  gt(newer.generation, runtimeAttempt.generation),
                ),
              ),
          ),
        ),
      )
      .leftJoin(substrateSource, eq(substrateSource.workspaceId, developmentWorkspace.id))
      .where(eq(developmentWorkspace.id, workspaceID));
    return current ?? null;
  }
  async function view(
    current: NonNullable<Awaited<ReturnType<typeof nativeRow>>>,
  ): Promise<SourceWorkspaceView> {
    const ready = Boolean(
      current.sourceOwner === "service"
        ? await sources.available(current.workspaceID)
        : current.sourceWritable &&
            current.readable &&
            current.attemptID &&
            hub.sourceConnected(current.attemptID),
    );
    // An admitted cold start is still preparing, not evidence that Source was
    // frozen. Keep the editor's observation alive until its original Parent
    // connects; reads do not require Child readiness or admit a new writer.
    // The native Parent serves Source independently of Project preparation.
    const preparing =
      current.sourceWritable &&
      (current.runtimeState === "starting" || current.sourceOwner === "service");
    const paused =
      current.sourceOwner === "actor" &&
      current.sourceWritable &&
      current.runtimeState === "paused";
    return {
      workspaceID: current.workspaceID,
      label:
        current.kind === "personal"
          ? `Personal · ${current.projectName}`
          : `Ticket · ${current.ticketTitle ?? current.projectName}`,
      state: ready ? "ready" : paused ? "paused" : "preparing",
      serviceID: `source-${current.workspaceID.replaceAll("-", "")}`,
      epoch: Number(current.sourceEpoch ?? current.generation ?? 1),
      failure:
        ready || preparing || paused
          ? null
          : "The current Source owner is frozen or unavailable. Compute was not started; keep your editor buffer.",
    };
  }
  const authority = (workspaceID: string, userID: string, sql: DatabaseTransaction) =>
    workspaceAuthorityIn(sql, workspaceID, userID);
  function revokeWorkspace(workspaceID: string) {
    for (const [controller, stream] of streams)
      if (stream.workspaceID === workspaceID) controller.abort();
  }
  sources.onTransfer(revokeWorkspace);
  async function ensure(workspaceID: string, userID: string) {
    if (closed) throw new CommandError("unavailable", "Factory Source is stopping");
    await database.client.begin((sql) => authority(workspaceID, userID, sql));
    const current = await nativeRow(workspaceID);
    if (!current) throw new CommandError("not-found", "Native Workspace not found");
    const result = await view(current);
    await database.client.begin((sql) => authority(workspaceID, userID, sql));
    return result;
  }
  return {
    nativeRestore: (request: Request, attemptID: string) =>
      sources.restoreEndpoint(request, attemptID),
    ensure,
    get: ensure,
    async ensurePersonal(projectID: string, userID: string) {
      const workspaceID = await admitInitialSource(database, userID, { projectID });
      return ensure(workspaceID, userID);
    },
    async ensureChange(changeID: string, userID: string) {
      const workspaceID = await admitInitialSource(database, userID, { changeID });
      return ensure(workspaceID, userID);
    },
    async fenceChange(
      changeID: string,
      epoch: string,
      writable: boolean,
      commission?: SourceRoleFence,
    ) {
      if (commission?.mode === "retained-preparation") {
        const turns = createAgentTurnStore(database);
        const deadline = Date.now() + nativeLifecycleWindowMS;
        for (;;) {
          if (closed) throw new CommandError("unavailable", "Factory Source is stopping");
          const valid = await turns.validateExecution(
            commission.turnID,
            commission.ownerToken,
            async (sql) => {
              const retained = await retainedSourcePreparationIn(sql, commission.attemptID);
              if (
                writable ||
                retained?.changeID !== changeID ||
                retained.epoch !== epoch ||
                retained.turnID !== commission.turnID ||
                retained.ownerToken !== commission.ownerToken
              )
                throw new CommandError("conflict", "Retained Source preparation identity changed");
            },
          );
          if (!valid)
            throw new CommandError("conflict", "Build authority changed during Source preparation");
          if (
            hub.sourceConnected(commission.attemptID) &&
            hub.parentConnected(commission.attemptID)
          )
            return;
          if (Date.now() >= deadline)
            throw new CommandError("unavailable", "Retained Source transport is unconfirmed");
          // A cold Parent must finish restore and admission without these locks.
          await Bun.sleep(100);
        }
      }
      const fence = async (sql: DatabaseTransaction) => {
        const [workspace] = await drizzleTransaction(sql)
          .select({ id: developmentWorkspace.id })
          .from(developmentWorkspace)
          .where(eq(developmentWorkspace.changeId, changeID));
        if (!workspace) {
          if (commission?.mode === "dispatch")
            throw new CommandError("unavailable", "Current Source Workspace is unavailable");
          return;
        }
        // Handoff can hold Change elsewhere. Do not wait behind a save that is
        // itself waiting for that Change row.
        const [lock] = await sql<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${`source:${workspace.id}`})) AS acquired`;
        if (!lock?.acquired)
          throw new CommandError(
            "unavailable",
            "Source owner is busy; writing fence is unconfirmed",
          );
        const current = await nativeRow(workspace.id, sql);
        if (commission?.mode === "dispatch") {
          // One atomic admission predicate binds the live turn lease, writer,
          // OpenCode session and original native Source before fencing input.
          const [binding] = await sql`SELECT a.id FROM factory.runtime_attempt a
            JOIN factory.change change ON change.id=a.change_id AND change.runtime_attempt_id=a.id
              AND change.project_id=a.project_id
            JOIN factory.change_writer writer ON writer.change_id=change.id AND writer.state='agent'
              AND writer.turn_id=${commission.turnID} AND writer.epoch=${epoch}::bigint
            JOIN factory.agent_turn turn ON turn.id=writer.turn_id AND turn.state='pending'
              AND turn.change_id=change.id AND turn.project_id=a.project_id
              AND turn.owner_token=${commission.ownerToken} AND turn.owner_expires_at>clock_timestamp()
            JOIN factory.change_agent_turn_intent input ON input.turn_id=writer.turn_id
              AND input.change_id=change.id
              AND input.runtime_attempt_id=a.id AND input.session_id=${commission.sessionID}
            JOIN factory.change_agent_session session ON session.change_id=change.id
              AND session.runtime_attempt_id=a.id AND session.opencode_session_id=input.session_id
              AND session.active_turn_id=input.turn_id AND session.state='starting' AND NOT session.stop_pending
            JOIN factory.substrate_source source ON source.workspace_id=a.workspace_id
              AND source.actor_uid=a.actor_uid AND source.owner='actor' AND source.writable
            WHERE a.id=${commission.attemptID} AND a.workspace_id=${workspace.id}
              AND a.state='ready' AND a.stop_intended_at IS NULL
              AND a.actor_uid IS NOT NULL AND a.delete_intended_at IS NULL AND a.deleted_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
                WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)`;
          if (writable || !binding || current?.attemptID !== commission.attemptID || !current.ready)
            throw new CommandError("conflict", "Current Source dispatch identity changed");
          await sources.fence(workspace.id, commission.attemptID, epoch, false, sql, true);
          return;
        }
        if (
          commission?.mode === "initial-bootstrap" &&
          !writable &&
          current?.attemptID &&
          !hub.parentConnected(current.attemptID) &&
          !hub.sourceConnected(current.attemptID) &&
          (await initialSourceRoleIn(sql, workspace.id, current.attemptID, epoch, commission)) &&
          (await options?.supportsInitialRole?.(current.attemptID, sql))
        )
          // There was no admitted human Source writer or dispatched input.
          // Authenticated cold restore initializes the read-only API role.
          // This is not a real fence ACK: dispatch must confirm it separately.
          return;
        if (current?.attemptID)
          await sources.fence(workspace.id, current.attemptID, epoch, writable, sql);
      };
      if (commission) await fence(commission.sql);
      else await database.client.begin(fence);
    },
    async forward(
      workspaceID: string,
      userID: string,
      operation: string,
      request: Request,
      sharedSave = false,
      wakeCompute = true,
    ) {
      if (closed) throw new CommandError("unavailable", "Factory Source is stopping");
      if (operation === "events" ? request.method !== "GET" : request.method !== "POST")
        return new Response(null, { status: 405 });
      if (!/^(stat|list|read|write|mkdir|rename|delete|search|events)$/.test(operation))
        return new Response(null, { status: 404 });
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) controller.abort();
      let retained = false;
      try {
        // Slow body uploads must not hold membership or writer locks.
        const content =
          operation === "events" ? undefined : await boundedSourceBody(request, controller.signal);
        const admittedRequest = new Request(request.url, {
          method: operation === "events" ? "GET" : "POST",
          ...(content === undefined ? {} : { body: content }),
          signal: controller.signal,
        });
        const mutation = ["write", "mkdir", "rename", "delete"].includes(operation);
        let resumedAttemptID: string | undefined;
        if (operation !== "events") {
          controller.signal.throwIfAborted();
          const before = await database.client.begin(async (sql) => {
            if (mutation) await workspaceWriteAuthorityIn(sql, workspaceID, userID);
            else await authority(workspaceID, userID, sql);
            return nativeRow(workspaceID, sql);
          });
          if (
            before?.runtimeState === "pausing" ||
            (mutation && before?.runtimeState === "resuming")
          )
            throw new CommandError(
              "unavailable",
              "Compute is changing state. Keep your editor buffer and retry after it settles.",
            );
          if (
            (before?.runtimeState === "paused" || before?.runtimeState === "resuming") &&
            (mutation || before.sourceOwner === "actor")
          ) {
            if (!wakeCompute)
              throw new CommandError(
                "unavailable",
                "Workspace compute is paused. Resume compute to synchronize shared editing. Your buffer is retained.",
              );
            if (!before.attemptID || !options?.wakeForAccess)
              throw new CommandError(
                "unavailable",
                "Resume this Workspace to access its current files. Your editor buffer is retained.",
              );
            // The same native Actor retains Source. Hold neither Source nor
            // membership/writer locks while its authenticated wake connects.
            controller.signal.throwIfAborted();
            if (closed) throw new CommandError("unavailable", "Factory Source is stopping");
            pendingWakes.add(controller);
            try {
              await options.wakeForAccess(workspaceID, userID, controller.signal, mutation);
            } finally {
              pendingWakes.delete(controller);
            }
            resumedAttemptID = before.attemptID;
          }
          // Retired independent Source keeps its existing editing policy;
          // saving never replaces explicit Stop or starts a new Attempt.
          controller.signal.throwIfAborted();
          if (closed) throw new CommandError("unavailable", "Factory Source is stopping");
        }
        const result = await database.client.begin(async (sql) => {
          const [policy] = await sql<{ timeout: string }[]>`
            SELECT current_setting('lock_timeout') AS timeout`;
          await sql`SELECT set_config('lock_timeout','2000ms',true)`;
          try {
            await sql`SELECT pg_advisory_xact_lock(hashtext(${`source:${workspaceID}`}))`;
          } catch (cause) {
            if ((cause as { code?: string }).code !== "55P03") throw cause;
            throw new CommandError(
              "unavailable",
              "Native Source owner is busy. Keep your editor buffer and retry; compute was not started.",
            );
          }
          await sql`SELECT set_config('lock_timeout',${policy?.timeout ?? "0"},true)`;
          const workspace = await authority(workspaceID, userID, sql);
          if (!sharedSave && ["write", "rename", "delete"].includes(operation) && content) {
            const input = JSON.parse(new TextDecoder().decode(content)) as {
              path?: string;
              destination?: string;
            };
            if (typeof input.path === "string") {
              const paths = [
                input.path,
                ...(typeof input.destination === "string" ? [input.destination] : []),
              ];
              const [dirty] = await drizzleTransaction(sql)
                .select({ path: workspaceSharedDocument.path })
                .from(workspaceSharedDocument)
                .where(
                  and(
                    eq(workspaceSharedDocument.workspaceId, workspaceID),
                    ne(workspaceSharedDocument.syncState, "clean"),
                    or(
                      ...paths.map((path) =>
                        or(
                          eq(workspaceSharedDocument.path, path),
                          expression`starts_with(${workspaceSharedDocument.path},${path}||'/')`,
                        ),
                      ),
                    ),
                  ),
                )
                .limit(1);
              if (dirty)
                throw new CommandError(
                  "conflict",
                  "Shared unsaved edits are retained for this path. Save or resolve the shared document instead of overwriting it.",
                );
            }
          }
          const current = await nativeRow(workspaceID, sql);
          if (!current || (!current.attemptID && current.sourceOwner !== "service"))
            throw new CommandError(
              "unavailable",
              "Native Source is not initialized; compute was not started",
            );
          if (resumedAttemptID && current.attemptID !== resumedAttemptID)
            throw new CommandError(
              "conflict",
              "Workspace compute changed during file access. Your editor buffer was retained.",
            );
          if (current.sourceOwner !== "service" && !current.readable)
            throw new CommandError(
              "unavailable",
              "Actor Source is not ready; compute was not started",
            );
          if (mutation) {
            const writer = await workspaceWriteAuthorityIn(sql, workspaceID, userID);
            if (
              current.runtimeState === "paused" ||
              current.runtimeState === "pausing" ||
              current.runtimeState === "resuming"
            )
              throw new CommandError(
                "unavailable",
                "Compute is not resumed. Keep your editor buffer and retry after it settles.",
              );
            if (
              resumedAttemptID &&
              (current.attemptID !== resumedAttemptID ||
                !current.readable ||
                !hub.sourceConnected(resumedAttemptID) ||
                current.sourceOwner !== "actor")
            )
              throw new CommandError(
                "conflict",
                "Source resume is unconfirmed or Workspace compute changed. Keep your editor buffer.",
              );
            if (
              current.sourceOwner !== "service" &&
              (!current.readable || !current.attemptID || !hub.sourceConnected(current.attemptID))
            )
              throw new CommandError(
                "unavailable",
                "Current files are still connecting. Your editor buffer and writing authority are retained.",
              );
            admittedRequest.headers.set(
              "X-Factory-Writer-Epoch",
              writer.writerEpoch ?? current.sourceEpoch ?? "1",
            );
            controller.signal.throwIfAborted();
            if (closed) throw new CommandError("unavailable", "Factory Source is stopping");
          }
          streams.set(controller, { userID, workspaceID, projectID: workspace.projectID });
          return sources.forward(workspaceID, current.attemptID, operation, admittedRequest, sql);
        });
        if (operation !== "events" || !result.ok || !result.body) return result;
        const reader = result.body.getReader();
        retained = true;
        function finish() {
          streams.delete(controller);
          request.signal.removeEventListener("abort", onAbort);
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(target) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                target.close();
                finish();
                return;
              }
              target.enqueue(chunk.value);
            } catch {
              target.close();
              finish();
            }
          },
          async cancel() {
            controller.abort();
            await reader.cancel().catch(() => {});
            finish();
          },
        });
        return new Response(body, {
          status: result.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } finally {
        if (!retained) {
          streams.delete(controller);
          request.signal.removeEventListener("abort", onAbort);
        }
      }
    },
    async revokeMember(projectID: string, userID: string) {
      for (const [controller, stream] of streams)
        if (stream.userID === userID && stream.projectID === projectID) controller.abort();
    },
    revokeSharedMember(workspaceID: string, userID: string) {
      for (const [controller, stream] of streams)
        if (stream.userID === userID && stream.workspaceID === workspaceID) controller.abort();
    },
    revokeUser(userID: string) {
      for (const [controller, stream] of streams) if (stream.userID === userID) controller.abort();
    },
    async reconcileUserAccess(userID: string) {
      const allowed = new Map<string, boolean>();
      for (const [controller, stream] of streams) {
        if (stream.userID !== userID) continue;
        if (!allowed.has(stream.workspaceID)) {
          try {
            await database.client.begin((sql) => authority(stream.workspaceID, userID, sql));
            allowed.set(stream.workspaceID, true);
          } catch (cause) {
            if (
              !(cause instanceof CommandError) ||
              !["forbidden", "not-found"].includes(cause.code)
            )
              throw cause;
            allowed.set(stream.workspaceID, false);
          }
        }
        if (!allowed.get(stream.workspaceID)) controller.abort();
      }
    },
    async recover() {
      // The immutable native lease remains authoritative. Connection readiness
      // is observed on demand; restart never recreates Source or Actor intent.
    },
    async close() {
      closed = true;
      for (const controller of pendingWakes) controller.abort();
      for (const controller of streams.keys()) controller.abort();
      await sources.close();
    },
  };
}
