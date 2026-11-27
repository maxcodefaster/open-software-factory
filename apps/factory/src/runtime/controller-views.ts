import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { createDatabase } from "#db/client";
import {
  administrator,
  developmentWorkspace,
  operation as operationTable,
  projectMembership,
  runtimeAttempt,
  substrateProvision,
  workspaceShare,
} from "#db/schema";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { parseSystemContract } from "#system-contract/system-contract";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "./hub";
import type { RuntimeAttemptView } from "./types";

type Database = ReturnType<typeof createDatabase>;

const stagingPreview = alias(operationTable, "staging_preview");

// The public inventory uses the driver's existing text timestamps/bigints.
// Keep one projection for saved list state and explicit native get observation.
export const runtimeAttemptFields = {
  id: runtimeAttempt.id,
  projectId: runtimeAttempt.projectId,
  changeId: runtimeAttempt.changeId,
  workspaceId: runtimeAttempt.workspaceId,
  workspaceKind: developmentWorkspace.kind,
  ownerUserId: developmentWorkspace.ownerUserId,
  generation: query<string>`${runtimeAttempt.generation}::text`,
  revision: runtimeAttempt.revision,
  runtimeKind: query<
    RuntimeAttemptView["runtimeKind"]
  >`coalesce(${runtimeAttempt.isolatedKind}::text, ${developmentWorkspace.kind}::text)`,
  currentStaging: query<boolean>`coalesce((${stagingPreview.payload}->>'runtimeAttemptId') = ${runtimeAttempt.id}::text, false)`,
  state: runtimeAttempt.state,
  failure: runtimeAttempt.failure,
  createdAt: query<string>`${runtimeAttempt.createdAt}`,
  updatedAt: query<string>`${runtimeAttempt.updatedAt}`,
  readyAt: query<string | null>`${runtimeAttempt.readyAt}`,
  appReadyAt: query<Record<string, string>>`${runtimeAttempt.appReadyAt}`,
};

async function observeRuntimeAttempt<Native extends { state: string }>(
  database: Database,
  observeNative: (attemptID: string) => Promise<Native>,
  attempt: RuntimeAttemptView,
) {
  const observation = await observeNative(attempt.id);
  if (observation.state === "ACTOR_STATE_CRASHED") {
    const [recorded] = await database.db
      .select({
        state: runtimeAttempt.state,
        failure: runtimeAttempt.failure,
        updatedAt: runtimeAttemptFields.updatedAt,
      })
      .from(runtimeAttempt)
      .where(eq(runtimeAttempt.id, attempt.id));
    if (!recorded) throw new Error("Recorded runtime outcome is unavailable");
    return { ...attempt, ...recorded, native: observation };
  }
  return { ...attempt, native: observation };
}

export async function getRuntimeAttempt<Native extends { state: string }>(
  database: Database,
  observeNative: (attemptID: string) => Promise<Native>,
  attemptID: string,
) {
  const [attempt] = await database.db
    .select(runtimeAttemptFields)
    .from(runtimeAttempt)
    .leftJoin(developmentWorkspace, eq(developmentWorkspace.id, runtimeAttempt.workspaceId))
    .leftJoin(
      stagingPreview,
      and(
        eq(stagingPreview.kind, "delivery.staging_preview"),
        eq(stagingPreview.scopeType, "project"),
        eq(stagingPreview.scopeId, query<string>`${runtimeAttempt.projectId}::text`),
      ),
    )
    .where(eq(runtimeAttempt.id, attemptID));
  return attempt ? observeRuntimeAttempt(database, observeNative, attempt) : null;
}

export async function listRuntimeAttempts(
  database: Database,
  projectID: string | undefined,
  userID: string,
) {
  const history = alias(runtimeAttempt, "history_attempt");
  const historyOwner = query`coalesce(${history.workspaceId}::text, ${history.isolatedKind}::text || ':' || coalesce(${history.changeId}::text, ${history.projectId}::text))`;
  const attempts = await database.db
    .select(runtimeAttemptFields)
    .from(runtimeAttempt)
    .leftJoin(developmentWorkspace, eq(developmentWorkspace.id, runtimeAttempt.workspaceId))
    .leftJoin(
      stagingPreview,
      and(
        eq(stagingPreview.kind, "delivery.staging_preview"),
        eq(stagingPreview.scopeType, "project"),
        eq(stagingPreview.scopeId, query<string>`${runtimeAttempt.projectId}::text`),
      ),
    )
    .where(
      and(
        projectID === undefined ? undefined : eq(runtimeAttempt.projectId, projectID),
        or(
          query`${developmentWorkspace.kind} IS DISTINCT FROM 'personal'`,
          eq(developmentWorkspace.ownerUserId, userID),
          exists(
            database.db
              .select({ id: workspaceShare.workspaceId })
              .from(workspaceShare)
              .where(
                and(
                  eq(workspaceShare.workspaceId, developmentWorkspace.id),
                  eq(workspaceShare.userId, userID),
                  isNull(workspaceShare.revokedAt),
                  exists(
                    database.db
                      .select({ id: projectMembership.projectId })
                      .from(projectMembership)
                      .where(
                        and(
                          eq(projectMembership.projectId, runtimeAttempt.projectId),
                          eq(projectMembership.userId, userID),
                          eq(projectMembership.role, "developer"),
                        ),
                      ),
                  ),
                ),
              ),
          ),
        ),
        or(
          exists(
            database.db
              .select({ id: administrator.userId })
              .from(administrator)
              .where(eq(administrator.userId, userID)),
          ),
          exists(
            database.db
              .select({ id: projectMembership.projectId })
              .from(projectMembership)
              .where(
                and(
                  eq(projectMembership.projectId, runtimeAttempt.projectId),
                  eq(projectMembership.userId, userID),
                ),
              ),
          ),
        ),
        projectID === undefined
          ? undefined
          : or(
              notInArray(runtimeAttempt.state, ["stopped", "failed"]),
              eq(
                query<string>`${stagingPreview.payload}->>'runtimeAttemptId'`,
                query<string>`${runtimeAttempt.id}::text`,
              ),
              inArray(
                runtimeAttempt.id,
                database.db
                  .selectDistinctOn([historyOwner], { id: history.id })
                  .from(history)
                  .where(eq(history.projectId, projectID))
                  .orderBy(historyOwner, desc(history.generation), desc(history.createdAt)),
              ),
            ),
      ),
    )
    .orderBy(desc(runtimeAttempt.createdAt));
  // Inventory reports saved Factory state, not current Actor liveness.
  // Keep it readable while the native API is unavailable. Explicit get()
  // and lifecycle commands still require the original native owner and
  // its live observation; recorded ready never supplies that authority.
  return [...attempts];
}

export async function readProcessOutput(database: Database, hub: RuntimeHub, attemptID: string) {
  const [attempt] = await database.db
    .select({ state: runtimeAttempt.state })
    .from(runtimeAttempt)
    .where(eq(runtimeAttempt.id, attemptID));
  if (!attempt) throw new CommandError("not-found", "Runtime Attempt not found");
  if (!["starting", "ready"].includes(attempt.state))
    return { processes: [{ name: "app", state: attempt.state, output: "" }] };
  const processes = hub.processes(attemptID);
  return {
    processes: processes.length
      ? processes
      : [
          {
            name: "app",
            state: attempt.state === "ready" ? "running" : "starting",
            output: "",
          },
        ],
  };
}

export async function runProcessAction(
  database: Database,
  hub: RuntimeHub,
  attemptID: string,
  process: string,
  action: "start" | "stop" | "restart",
  options?: {
    beforeSend?: (send: () => void) => Promise<void>;
    waitForReady?: boolean;
    signal?: AbortSignal;
  },
) {
  const [attempt] = await database.db
    .select({
      ready: query<boolean>`${runtimeAttempt.state} = 'ready' AND ${runtimeAttempt.stopIntendedAt} IS NULL`,
      development: isNotNull(runtimeAttempt.workspaceId),
      contract: query<unknown>`${substrateProvision.intent}->'systemContract'`,
    })
    .from(runtimeAttempt)
    .leftJoin(
      substrateProvision,
      and(
        eq(substrateProvision.ownerId, runtimeAttempt.workspaceId),
        eq(substrateProvision.kind, "workspace"),
        eq(substrateProvision.generation, runtimeAttempt.generation),
      ),
    )
    .where(eq(runtimeAttempt.id, attemptID));
  if (!attempt?.ready || !attempt.development)
    throw new Error("Development Workspace is not ready");
  if (!hub.hasAppChannel(attemptID, process))
    throw new Error("Declared App process does not exist");
  const app =
    options?.waitForReady && action !== "stop"
      ? (() => {
          const contract = parseSystemContract(JSON.stringify(attempt.contract));
          const matched = contract.apps.find(
            (item) => (item.id === contract.primaryApp ? "app" : `app-${item.id}`) === process,
          );
          if (!matched) throw new Error("Declared App readiness is unavailable");
          return matched;
        })()
      : undefined;
  options?.signal?.throwIfAborted();
  await hub.childRequest(
    attemptID,
    { operationId: crypto.randomUUID(), action: `process-${action}`, process },
    options
      ? async (send) => {
          const forward = () => {
            options.signal?.throwIfAborted();
            send();
          };
          if (options.beforeSend) await options.beforeSend(forward);
          else forward();
        }
      : undefined,
  );
  if (app) {
    // Use the original admitted channel and Connector readiness semantics:
    // declared health path, elapsed lifecycle window and read-only retries.
    // A running process or an old app_ready_at projection is not HTTP health.
    const deadline = performance.now() + nativeLifecycleWindowMS;
    for (;;) {
      options?.signal?.throwIfAborted();
      if (!hub.hasAppChannel(attemptID, process) || !hub.connected(attemptID))
        throw new CommandError("unavailable", "App readiness lost its Runtime Attempt");
      if (
        hub
          .processes(attemptID)
          .some((item) => item.name === process && ["failed", "stopped"].includes(item.state))
      )
        throw new CommandError("unavailable", "Declared App stopped before readiness");
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new CommandError("unavailable", "Declared App did not become ready");
      const timeout = AbortSignal.timeout(Math.min(2_000, Math.ceil(remaining)));
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await hub.request(
          attemptID,
          process,
          new Request(`http://factory-runtime.internal${app.healthPath}`, { signal }),
          app.healthPath,
          options?.beforeSend,
        );
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) break;
      } catch (cause) {
        options?.signal?.throwIfAborted();
        if (cause instanceof CommandError) throw cause;
        // Only health reads repeat. An unknown process-operation result
        // exits above, without dispatching another restart.
      }
      await Bun.sleep(Math.min(250, Math.max(0, deadline - performance.now())));
    }
  }
  return readProcessOutput(database, hub, attemptID);
}

export async function closeWorkspaceTerminal(
  database: Database,
  hub: RuntimeHub,
  attemptID: string,
  terminalID: string,
) {
  const [attempt] = await database.db
    .select({
      ready: eq(runtimeAttempt.state, "ready"),
      development: isNotNull(runtimeAttempt.workspaceId),
    })
    .from(runtimeAttempt)
    .where(eq(runtimeAttempt.id, attemptID));
  if (!attempt?.ready || !attempt.development)
    throw new Error("Development Workspace is not ready");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalID)) throw new Error("Terminal session is invalid");
  await hub.childOperation(attemptID, {
    operationId: crypto.randomUUID(),
    action: "terminal-close",
    terminalId: terminalID,
  });
  return { closed: true };
}
