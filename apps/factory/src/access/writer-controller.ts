import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  authUser,
  change,
  changeAgentSession,
  changeCommitOperation,
  changeEditingDecision,
  changeEditingRequest,
  changeWriter,
  developmentWorkspace,
  monitoringIncident,
  runtimeAttempt,
} from "../../../../packages/db/src/schema";
import { forgeUsername } from "../../../../packages/forge/src/access";
import type { PendingWriterHandoff } from "../agent/stop";
import { createAgentTurnStore } from "../agent/turn-store";
import { CommandError } from "../command-error";
import type { RuntimeAttemptView } from "../runtime/types";
import type { SourceRoleFence } from "../workspace/source-role-fence";
import { lockChangeWriterIn } from "./change-writer";
import { projectDevelopmentAuthorityIn } from "./controller";
import { type WriterActivity, writerActivity } from "./writer-activity";

type Database = ReturnType<typeof createDatabase>;
type WriterView = {
  state: string;
  epoch: number;
  canWrite: boolean;
  stopPending: boolean;
  yours: boolean;
  commandID: string | null;
  actor: {
    kind: "human" | "agent";
    user: { id: string; name: string } | null;
    delegated: boolean;
    workState: string | null;
  } | null;
  requester: { id: string; name: string } | null;
  presence: {
    idle: boolean;
    secondsSinceEdit: number | null;
    connected: boolean;
  } | null;
  handoffKind: "takeover" | "release";
  requests: { id: string; requester: { id: string; name: string }; epoch: number }[];
};
type RuntimeBoundary = {
  stop(attemptID: string, handoff?: PendingWriterHandoff): Promise<unknown>;
  get(attemptID: string): Promise<Pick<RuntimeAttemptView, "state" | "native"> | null>;
};
export function createChangeWriterController(options: {
  database: Database;
  runtime: RuntimeBoundary;
  stopAgent(changeID: string): Promise<unknown>;
  protect(changeID: string, writers: readonly string[]): Promise<void>;
  fenceSource?(
    changeID: string,
    epoch: string,
    writable: boolean,
    commission?: SourceRoleFence,
  ): Promise<void>;
  agentUsername: string;
  stopDeadlineMs?: number;
  activity?: WriterActivity;
}) {
  const { database } = options;
  const turns = createAgentTurnStore(database);
  const activity = options.activity ?? writerActivity;
  async function exclusive<T>(changeID: string, work: () => Promise<T>): Promise<T> {
    const connection = database.coordination();
    const key = `change-writer-operation:${changeID}`;
    try {
      await connection`SELECT pg_advisory_lock(hashtext(${key}))`;
      return await work();
    } finally {
      try {
        await connection`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        await connection.end({ timeout: 1 });
      }
    }
  }
  async function stopped(attemptID: string | null, handoff?: PendingWriterHandoff) {
    if (!attemptID) return true;
    await options.runtime.stop(attemptID, handoff);
    const deadline = performance.now() + (options.stopDeadlineMs ?? 45_000);
    for (;;) {
      const attempt = await options.runtime.get(attemptID);
      const state = attempt?.state;
      if (state === "stopped") return true;
      // Product native Stop retains the original Actor and private Docker data.
      // Only the independently observed durable ROOTFS + released Source owner
      // fences its compute; a generic paused row is not teardown evidence. Agent
      // queued-input settlement remains a separate prerequisite below.
      if (
        state === "paused" &&
        attempt?.native?.engine === "substrate" &&
        attempt.native.state === "ACTOR_STATE_SUSPENDED" &&
        attempt.native.sourceHandoff === "confirmed-same-node"
      )
        return true;
      if (performance.now() < deadline) {
        await Bun.sleep(100);
        continue;
      }
      if (state === "stop-intended" || state === "stopping") return false;
      throw new CommandError(
        "conflict",
        "Previous Workspace compute has not stopped. Check its cleanup status before retrying.",
      );
    }
  }
  async function readView(changeID: string, userID: string): Promise<WriterView> {
    return database.client.begin(async (sql) => {
      const writer = await lockChangeWriterIn(sql, changeID);
      await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
      const db = drizzleTransaction(sql);
      const [shared] = await db
        .select({ id: developmentWorkspace.id })
        .from(developmentWorkspace)
        .where(
          and(
            eq(developmentWorkspace.changeId, changeID),
            developmentWorkspace.collaborationEnabled,
          ),
        );
      const [actor] = await db
        .select({
          id: authUser.id,
          name: query<string>`left(${authUser.name},160)`,
          delegated: query<boolean>`COALESCE(${agentTurn.authority} ? 'monitoringIncidentId',false)`,
          workState: query<string | null>`${agentTurn.state}::text`,
        })
        .from(authUser)
        .leftJoin(agentTurn, eq(agentTurn.id, query`${writer.turnID}::uuid`))
        .where(eq(authUser.id, query`COALESCE(${writer.userID}::uuid,${agentTurn.createdBy})`));
      const [requester] = writer.requestedBy
        ? await db
            .select({ id: authUser.id, name: query<string>`left(${authUser.name},160)` })
            .from(authUser)
            .where(eq(authUser.id, writer.requestedBy))
        : [];
      const [agent] = await db
        .select({ stopPending: changeAgentSession.stopPending })
        .from(changeAgentSession)
        .where(eq(changeAgentSession.changeId, changeID));
      const stopPending = agent?.stopPending ?? false;
      const presence =
        writer.state === "human" && writer.userID
          ? activity.snapshot(changeID, writer.userID, writer.epoch)
          : null;
      if (writer.state !== "human") activity.clear(changeID);
      const requests =
        writer.state === "human"
          ? await db
              .select({
                id: changeEditingRequest.id,
                userID: authUser.id,
                name: query<string>`left(${authUser.name},160)`,
                epoch: query<number>`${changeEditingRequest.writerEpoch}::float8`,
              })
              .from(changeEditingRequest)
              .innerJoin(authUser, eq(authUser.id, changeEditingRequest.requesterId))
              .where(
                and(
                  eq(changeEditingRequest.changeId, changeID),
                  eq(changeEditingRequest.writerEpoch, query`${writer.epoch}::bigint`),
                  eq(changeEditingRequest.state, "requested"),
                  or(
                    eq(changeEditingRequest.ownerId, userID),
                    eq(changeEditingRequest.requesterId, userID),
                  ),
                ),
              )
              .orderBy(changeEditingRequest.createdAt, changeEditingRequest.id)
          : [];
      return {
        state: writer.state,
        epoch: Number(writer.epoch),
        canWrite:
          writer.available &&
          !stopPending &&
          writer.state === "human" &&
          (writer.userID === userID || Boolean(shared)),
        stopPending,
        yours: writer.userID === userID || writer.requestedBy === userID,
        commandID: writer.requestedBy === userID ? writer.requestID : null,
        actor: ["human", "agent", "agent-preparing"].includes(writer.state)
          ? {
              kind: writer.state === "human" ? "human" : "agent",
              user: actor ? { id: actor.id, name: actor.name } : null,
              delegated: actor?.delegated ?? false,
              workState: actor?.workState ?? null,
            }
          : null,
        requester: requester ?? null,
        presence,
        handoffKind: writer.handoffKind,
        requests: requests.map((request) => ({
          id: request.id,
          requester: { id: request.userID, name: request.name },
          epoch: request.epoch,
        })),
      };
    });
  }
  return {
    async activity(
      changeID: string,
      userID: string,
      expectedEpoch: number,
      kind: "edit" | "heartbeat",
    ) {
      await database.client.begin(async (sql) => {
        const writer = await lockChangeWriterIn(sql, changeID);
        await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
        const [shared] = await drizzleTransaction(sql)
          .select({ id: developmentWorkspace.id })
          .from(developmentWorkspace)
          .where(
            and(
              eq(developmentWorkspace.changeId, changeID),
              developmentWorkspace.collaborationEnabled,
            ),
          );
        if (
          !writer.available ||
          writer.state !== "human" ||
          (writer.userID !== userID && !shared) ||
          writer.epoch !== String(expectedEpoch)
        )
          throw new CommandError(
            "conflict",
            "Editing context changed. Keep your draft and check the current writer.",
          );
        activity.observe(changeID, shared ? (writer.userID ?? userID) : userID, writer.epoch, kind);
      });
    },
    /** Pure observation: opening the shared chat must never acquire editing. */
    async status(changeID: string, userID: string): Promise<WriterView> {
      return readView(changeID, userID);
    },
    async request(changeID: string, userID: string, commandID: string, expectedEpoch: number) {
      await database.client.begin(async (sql) => {
        const writer = await lockChangeWriterIn(sql, changeID);
        await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
        const db = drizzleTransaction(sql);
        const [previous] = await db
          .select({
            changeID: changeEditingRequest.changeId,
            userID: changeEditingRequest.requesterId,
            epoch: query<string>`${changeEditingRequest.writerEpoch}::text`,
          })
          .from(changeEditingRequest)
          .where(eq(changeEditingRequest.id, commandID));
        if (previous) {
          if (
            previous.changeID !== changeID ||
            previous.userID !== userID ||
            previous.epoch !== String(expectedEpoch)
          )
            throw new CommandError(
              "conflict",
              "This editing request identity has different input.",
            );
          return;
        }
        if (
          !writer.available ||
          writer.state !== "human" ||
          writer.userID === userID ||
          writer.epoch !== String(expectedEpoch) ||
          !writer.userID
        )
          throw new CommandError(
            "conflict",
            "The writer changed. Check the current editing status.",
          );
        await db
          .insert(changeEditingRequest)
          .values({
            id: commandID,
            changeId: changeID,
            requesterId: userID,
            ownerId: writer.userID,
            writerEpoch: query`${writer.epoch}::bigint`,
          })
          .onConflictDoNothing({
            target: [
              changeEditingRequest.changeId,
              changeEditingRequest.requesterId,
              changeEditingRequest.writerEpoch,
            ],
            where: query`${changeEditingRequest.state}='requested'`,
          });
      });
      return readView(changeID, userID);
    },
    async approve(
      changeID: string,
      userID: string,
      commandID: string,
      requestID: string,
      expectedEpoch: number,
    ) {
      const [request] = await database.db
        .select({ requesterID: changeEditingRequest.requesterId })
        .from(changeEditingRequest)
        .where(
          and(
            eq(changeEditingRequest.id, requestID),
            eq(changeEditingRequest.changeId, changeID),
            eq(changeEditingRequest.ownerId, userID),
          ),
        );
      if (!request) throw new CommandError("not-found", "Editing request not found.");
      await this.takeOver(changeID, request.requesterID, commandID, undefined, {
        epoch: expectedEpoch,
        approverID: userID,
        requestID,
      });
      return readView(changeID, userID);
    },
    async takeIdle(changeID: string, userID: string, commandID: string, expectedEpoch: number) {
      return this.takeOver(changeID, userID, commandID, undefined, { epoch: expectedEpoch });
    },
    async release(
      changeID: string,
      userID: string,
      commandID: string,
      expectedEpoch: number,
    ): Promise<WriterView> {
      return exclusive(changeID, async () => {
        const intended = await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
          const db = drizzleTransaction(sql);
          const [decision] = await db
            .select({
              actorID: changeEditingDecision.actorId,
              epoch: query<string>`${changeEditingDecision.writerEpoch}::text`,
              changeID: changeEditingDecision.changeId,
              kind: changeEditingDecision.kind,
            })
            .from(changeEditingDecision)
            .where(eq(changeEditingDecision.commandId, commandID));
          if (
            decision &&
            (decision.actorID !== userID ||
              decision.changeID !== changeID ||
              decision.epoch !== String(expectedEpoch) ||
              decision.kind !== "release")
          )
            throw new CommandError(
              "conflict",
              "This editing decision identity has different input.",
            );
          if (decision && writer.state !== "handoff") return null;
          if (
            writer.state === "handoff" &&
            writer.handoffKind === "release" &&
            writer.requestedBy === userID &&
            writer.requestID === commandID
          )
            return writer;
          if (
            !writer.available ||
            writer.state !== "human" ||
            writer.userID !== userID ||
            writer.epoch !== String(expectedEpoch)
          )
            throw new CommandError(
              "conflict",
              "The writer changed. Your files have not been discarded.",
            );
          await db.insert(changeEditingDecision).values({
            commandId: commandID,
            changeId: changeID,
            actorId: userID,
            writerEpoch: query`${writer.epoch}::bigint`,
            kind: "release",
          });
          await db
            .update(changeWriter)
            .set({
              state: "handoff",
              handoffKind: "release",
              epoch: query`${changeWriter.epoch}+1`,
              userId: null,
              turnId: null,
              requestedBy: userID,
              requestId: commandID,
              fenceRequired: true,
              fenceAttemptId: query`(${db.select({ id: change.runtimeAttemptId }).from(change).where(eq(change.id, changeID))})`,
              updatedAt: query`now()`,
            })
            .where(eq(changeWriter.changeId, changeID));
          return lockChangeWriterIn(sql, changeID);
        });
        if (!intended) return readView(changeID, userID);
        await options.fenceSource?.(changeID, intended.epoch, false);
        await options.protect(changeID, []);
        if (!(await stopped(intended.fenceAttemptID)))
          throw new CommandError(
            "conflict",
            "Release saved. Previous commands have not stopped yet. Check editing status to continue.",
          );
        await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          if (
            writer.state !== "handoff" ||
            writer.epoch !== intended.epoch ||
            writer.handoffKind !== "release" ||
            writer.requestID !== commandID
          )
            throw new CommandError("conflict", "Editing release changed before confirmation.");
          const db = drizzleTransaction(sql);
          await db
            .update(changeWriter)
            .set({
              state: "unassigned",
              epoch: query`${changeWriter.epoch}+1`,
              requestedBy: null,
              requestId: null,
              fenceRequired: false,
              updatedAt: query`now()`,
            })
            .where(eq(changeWriter.changeId, changeID));
          await db
            .update(changeEditingRequest)
            .set({ state: "superseded", decidedAt: query`now()` })
            .where(
              and(
                eq(changeEditingRequest.changeId, changeID),
                eq(changeEditingRequest.state, "requested"),
              ),
            );
        });
        activity.clear(changeID);
        return readView(changeID, userID);
      });
    },
    async view(changeID: string, userID: string): Promise<WriterView> {
      // An open editor keeps observing after Coding settles. That read must not
      // commission a human takeover and silently block exact-commit Verification.
      // Only already recorded human decisions may continue here.
      const [pending] = await database.db
        .select({ commandID: changeWriter.requestId })
        .from(changeWriter)
        .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeWriter.fenceAttemptId))
        .where(
          and(
            eq(changeWriter.changeId, changeID),
            eq(changeWriter.state, "handoff"),
            eq(changeWriter.handoffKind, "takeover"),
            eq(changeWriter.requestedBy, userID),
            isNotNull(changeWriter.requestId),
            or(
              isNull(changeWriter.fenceAttemptId),
              inArray(runtimeAttempt.state, ["stopped", "paused"]),
            ),
          ),
        );
      // Continue only the same person's recorded request. A native paused row
      // merely schedules observation; takeover still rechecks the exact durable
      // native result, permissions, Agent Stop, Source and branch fences.
      if (pending?.commandID) return this.takeOver(changeID, userID, pending.commandID);
      const [release] = await database.db
        .select({
          commandID: changeWriter.requestId,
          epoch: query<number>`${changeEditingDecision.writerEpoch}::float8`,
        })
        .from(changeWriter)
        .innerJoin(
          changeEditingDecision,
          and(
            eq(changeEditingDecision.commandId, changeWriter.requestId),
            eq(changeEditingDecision.changeId, changeWriter.changeId),
            eq(changeEditingDecision.actorId, changeWriter.requestedBy),
            eq(changeEditingDecision.kind, "release"),
            eq(query`${changeEditingDecision.writerEpoch}+1`, changeWriter.epoch),
          ),
        )
        .where(
          and(
            eq(changeWriter.changeId, changeID),
            eq(changeWriter.state, "handoff"),
            eq(changeWriter.handoffKind, "release"),
            eq(changeWriter.requestedBy, userID),
          ),
        );
      // Reconcile the already commissioned release, not a new editing command.
      // The exact decision rechecks authority and all fences after transport loss.
      if (release?.commandID)
        return this.release(changeID, userID, release.commandID, release.epoch);
      return readView(changeID, userID);
    },
    async prepareAgent(changeID: string, turnID: string, ownerToken?: string) {
      return exclusive(changeID, async () => {
        const writer = await database.client.begin((sql) => lockChangeWriterIn(sql, changeID));
        if (writer.turnID !== turnID || !["agent-preparing", "agent"].includes(writer.state))
          throw new CommandError("conflict", "Agent writing authority changed before execution");
        if (writer.state === "agent") return true;
        // An old interactive shell can retain child jobs, Docker execs and services.
        // Confirm full compute teardown rather than pretending shell-PID kill fences it.
        const prepare = async (sql: DatabaseTransaction) => {
          const current = await lockChangeWriterIn(sql, changeID);
          if (
            current.state !== "agent-preparing" ||
            current.epoch !== writer.epoch ||
            current.turnID !== turnID
          )
            throw new CommandError("conflict", "Agent writer changed before fencing");
          await options.fenceSource?.(
            changeID,
            current.epoch,
            false,
            ownerToken && !current.fenceRequired
              ? { mode: "initial-bootstrap", sql, turnID, ownerToken }
              : undefined,
          );
          await options.protect(changeID, []);
          if (
            ownerToken &&
            !current.fenceRequired &&
            !(await turns.validateExecutionIn(sql, turnID, ownerToken))
          )
            throw new CommandError("conflict", "Build authority changed during Source preparation");
        };
        if (ownerToken && !writer.fenceRequired) {
          // Take the operation lock before Turn/Change validation, then share
          // its SQL with Source. A nested Change lock would deadlock startup.
          if (!(await turns.validateExecution(turnID, ownerToken, prepare))) return false;
        } else await database.client.begin(prepare);
        if (
          writer.fenceRequired &&
          !(await stopped(writer.fenceAttemptID, { turnID, epoch: writer.epoch }))
        )
          return false;
        await database.client.begin(async (sql) => {
          const current = await lockChangeWriterIn(sql, changeID);
          if (
            current.state !== "agent-preparing" ||
            current.epoch !== writer.epoch ||
            current.turnID !== turnID ||
            !current.available
          )
            throw new CommandError(
              "conflict",
              "Agent writing authority changed during preparation",
            );
          await options.protect(changeID, [options.agentUsername]);
          await drizzleTransaction(sql)
            .update(changeWriter)
            .set({
              state: "agent",
              fenceRequired: false,
              updatedAt: query`now()`,
            })
            .where(eq(changeWriter.changeId, changeID));
        });
        return true;
      });
    },
    async confirmSource(
      changeID: string,
      turnID: string,
      ownerToken: string,
      attemptID: string,
      sessionID: string,
    ) {
      const fenceSource = options.fenceSource;
      if (!fenceSource)
        throw new CommandError("unavailable", "Source role confirmation is not configured");
      const confirmed = await turns.validateExecution(turnID, ownerToken, async (sql) => {
        const writer = await lockChangeWriterIn(sql, changeID);
        if (!writer.available || writer.state !== "agent" || writer.turnID !== turnID)
          throw new CommandError(
            "conflict",
            "Agent writing authority changed before Source confirmation",
          );
        await fenceSource(changeID, writer.epoch, false, {
          mode: "dispatch",
          sql,
          turnID,
          ownerToken,
          attemptID,
          sessionID,
        });
        // The real RPC can outlast the lease. Its read-only role change grants
        // no prompt authority; reject expiry before reporting confirmation.
        if (!(await turns.validateExecutionIn(sql, turnID, ownerToken)))
          throw new CommandError("conflict", "Build authority changed during Source confirmation");
      });
      if (!confirmed)
        throw new CommandError("conflict", "Build authority changed before Source confirmation");
    },
    async takeOver(
      changeID: string,
      userID: string,
      commandID: string,
      completedEpoch?: string,
      humanTransfer?: { epoch: number; approverID?: string; requestID?: string },
      observedEpoch?: number,
    ): Promise<WriterView> {
      return exclusive(changeID, async () => {
        const intended = await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
          const db = drizzleTransaction(sql);
          const continuing =
            writer.state === "handoff" &&
            writer.handoffKind === "takeover" &&
            writer.requestedBy === userID &&
            writer.requestID === commandID;
          if (observedEpoch !== undefined && writer.epoch !== String(observedEpoch) && !continuing)
            throw new CommandError(
              "conflict",
              "The writer changed. Check the current editing status before taking over.",
            );
          if (humanTransfer && writer.state !== "human" && !continuing)
            throw new CommandError(
              "conflict",
              "Idle takeover applies only to the observed human writer. Agent and unconfirmed work must use explicit Stop.",
            );
          if (humanTransfer && continuing) {
            const [decision] = await db
              .select({ commandID: changeEditingDecision.commandId })
              .from(changeEditingDecision)
              .where(
                and(
                  eq(changeEditingDecision.commandId, commandID),
                  eq(changeEditingDecision.changeId, changeID),
                  eq(changeEditingDecision.targetId, userID),
                  eq(changeEditingDecision.actorId, humanTransfer.approverID ?? userID),
                  eq(changeEditingDecision.writerEpoch, query`${humanTransfer.epoch}::bigint`),
                  eq(
                    changeEditingDecision.kind,
                    humanTransfer.approverID ? "approve" : "idle-takeover",
                  ),
                  query`${changeEditingDecision.requestId} IS NOT DISTINCT FROM ${humanTransfer.requestID ?? null}`,
                ),
              );
            if (!decision)
              throw new CommandError("conflict", "The editing decision changed input.");
          }
          if (completedEpoch) {
            const [settled] = await db
              .select({ changeID: changeAgentSession.changeId })
              .from(changeAgentSession)
              .where(
                and(
                  eq(changeAgentSession.changeId, changeID),
                  inArray(changeAgentSession.state, ["committed", "stopped"]),
                  eq(changeAgentSession.stopPending, false),
                  notExists(
                    db
                      .select({ id: agentTurn.id })
                      .from(agentTurn)
                      .where(
                        and(
                          eq(agentTurn.changeId, changeID),
                          inArray(agentTurn.state, [
                            "pending",
                            "dispatching",
                            "running",
                            "uncertain",
                          ]),
                        ),
                      ),
                  ),
                  notExists(
                    db
                      .select({ id: changeCommitOperation.id })
                      .from(changeCommitOperation)
                      .where(
                        and(
                          eq(changeCommitOperation.changeId, changeID),
                          notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                        ),
                      ),
                  ),
                ),
              );
            if (writer.state !== "agent" || writer.epoch !== completedEpoch || !settled)
              return null;
          }
          if (!writer.available)
            throw new CommandError("conflict", "This implementation is no longer active");
          if (writer.state === "human") {
            if (writer.userID === userID) return null;
            let authorizedTransfer = false;
            if (humanTransfer && writer.epoch === String(humanTransfer.epoch) && writer.userID) {
              if (humanTransfer.approverID && humanTransfer.requestID) {
                await projectDevelopmentAuthorityIn(
                  sql,
                  humanTransfer.approverID,
                  writer.projectID,
                );
                const [request] = await sql`SELECT id FROM factory.change_editing_request
                  WHERE id=${humanTransfer.requestID} AND change_id=${changeID}
                    AND requester_id=${userID} AND owner_id=${humanTransfer.approverID}
                    AND owner_id=${writer.userID} AND writer_epoch=${writer.epoch}::bigint AND state='requested'
                  FOR UPDATE`;
                if (!request)
                  throw new CommandError("conflict", "This editing request is no longer current.");
                authorizedTransfer = true;
              } else {
                authorizedTransfer = activity.snapshot(changeID, writer.userID, writer.epoch).idle;
              }
            }
            if (humanTransfer && !authorizedTransfer)
              throw new CommandError(
                "conflict",
                "The writer is active or changed. Request editing instead.",
              );
            if (authorizedTransfer) {
              const kind = humanTransfer?.approverID ? "approve" : "idle-takeover";
              await db.insert(changeEditingDecision).values({
                commandId: commandID,
                changeId: changeID,
                actorId: humanTransfer?.approverID ?? userID,
                targetId: userID,
                writerEpoch: query`${writer.epoch}::bigint`,
                kind,
                requestId: humanTransfer?.requestID ?? null,
              });
              if (humanTransfer?.requestID)
                await db
                  .update(changeEditingRequest)
                  .set({
                    state: "accepted",
                    decidedBy: humanTransfer.approverID ?? userID,
                    decidedAt: query`now()`,
                  })
                  .where(eq(changeEditingRequest.id, humanTransfer.requestID));
            }
            try {
              if (!writer.userID) throw new Error("Human writer identity is unavailable");
              await projectDevelopmentAuthorityIn(sql, writer.userID, writer.projectID);
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              // Revoked writers cannot strand retained Project work indefinitely.
              await db
                .update(changeWriter)
                .set({ state: "unassigned", userId: null })
                .where(eq(changeWriter.changeId, changeID));
            }
            const [current] = await db
              .select({ changeID: changeWriter.changeId })
              .from(changeWriter)
              .where(and(eq(changeWriter.changeId, changeID), eq(changeWriter.state, "human")));
            if (current && !authorizedTransfer)
              throw new CommandError(
                "conflict",
                "Another developer is editing this implementation",
              );
          }
          if (writer.state === "handoff") {
            if (
              writer.handoffKind === "takeover" &&
              writer.requestedBy === userID &&
              writer.requestID === commandID
            )
              return writer;
            try {
              if (!writer.requestedBy) throw new Error("Takeover identity is unavailable");
              await projectDevelopmentAuthorityIn(sql, writer.requestedBy, writer.projectID);
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              await db.insert(changeEditingDecision).values({
                commandId: commandID,
                changeId: changeID,
                actorId: userID,
                targetId: userID,
                writerEpoch: query`${writer.epoch}::bigint`,
                kind: "takeover",
              });
              await db
                .update(changeWriter)
                .set({
                  requestedBy: userID,
                  requestId: commandID,
                  handoffKind: "takeover",
                  epoch: query`${changeWriter.epoch}+1`,
                  updatedAt: query`now()`,
                })
                .where(eq(changeWriter.changeId, changeID));
              return lockChangeWriterIn(sql, changeID);
            }
            throw new CommandError("conflict", "An editing takeover is already in progress");
          }
          await db
            .update(monitoringIncident)
            .set({
              state: "blocked",
              reason: "A developer took over source editing. Automatic Delivery is disabled.",
              settledAt: query`now()`,
            })
            .from(change)
            .where(
              and(
                eq(change.id, changeID),
                eq(monitoringIncident.ticketId, change.ticketId),
                eq(monitoringIncident.state, "implementing"),
              ),
            );
          if (!humanTransfer)
            await db.insert(changeEditingDecision).values({
              commandId: commandID,
              changeId: changeID,
              actorId: userID,
              targetId: userID,
              writerEpoch: query`${writer.epoch}::bigint`,
              kind: "takeover",
            });
          await db
            .update(changeWriter)
            .set({
              state: "handoff",
              handoffKind: "takeover",
              userId: null,
              turnId: null,
              epoch: query`${changeWriter.epoch}+1`,
              requestedBy: userID,
              requestId: commandID,
              fenceRequired: true,
              fenceAttemptId: query`(${db.select({ id: change.runtimeAttemptId }).from(change).where(eq(change.id, changeID))})`,
              updatedAt: query`now()`,
            })
            .where(eq(changeWriter.changeId, changeID));
          return lockChangeWriterIn(sql, changeID);
        });
        if (!intended) return readView(changeID, userID);
        await options.fenceSource?.(changeID, intended.epoch, false);
        await database.client.begin(async (sql) => {
          const current = await lockChangeWriterIn(sql, changeID);
          if (
            current.state !== "handoff" ||
            current.epoch !== intended.epoch ||
            current.requestID !== commandID
          )
            throw new CommandError("conflict", "Editing takeover changed before fencing");
          await options.protect(changeID, []);
        });
        const [running] = await database.db
          .select({ changeID: changeAgentSession.changeId })
          .from(changeAgentSession)
          .where(
            and(
              eq(changeAgentSession.changeId, changeID),
              or(
                changeAgentSession.stopPending,
                inArray(changeAgentSession.state, ["starting", "working", "failed"]),
              ),
            ),
          )
          .unionAll(
            database.db
              .select({ changeID: query<string>`${agentTurn.changeId}` })
              .from(agentTurn)
              .where(
                and(
                  eq(agentTurn.changeId, changeID),
                  inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
                ),
              ),
          );
        if (running) await options.stopAgent(changeID);
        const [unsubmittedFailure] = await database.client`SELECT session.change_id
          FROM factory.change_agent_session session
          JOIN factory.change change ON change.id=session.change_id
          JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
          WHERE session.change_id=${changeID} AND session.state='stopped' AND session.stop_pending
            AND session.native_session_confirmed_at IS NULL
            AND session.implementation_session_confirmed_at IS NULL
            AND session.runtime_attempt_id=${intended.fenceAttemptID}
            AND change.runtime_attempt_id=session.runtime_attempt_id
            AND attempt.state IN ('failed','cleanup-failed')
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
              JOIN factory.agent_turn turn ON turn.id=intent.turn_id
              WHERE turn.change_id=session.change_id AND intent.runtime_attempt_id=session.runtime_attempt_id
                AND (intent.bootstrap IS DISTINCT FROM true
                  OR intent.session_id IS DISTINCT FROM session.opencode_session_id))
            AND NOT EXISTS(SELECT 1 FROM factory.agent_turn
              WHERE change_id=session.change_id AND state IN ('pending','dispatching','running','uncertain'))
            AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation
              WHERE change_id=session.change_id AND state NOT IN ('succeeded','failed'))`;
        if (unsubmittedFailure) {
          // Stop has already fenced late native confirmation and all prompts.
          // A failed bootstrap cannot supply live OpenCode history. Confirm
          // exact compute teardown first, then let the ordinary Stop verifier
          // settle it. Confirmed/reused Sessions never take this path.
          if (!(await stopped(intended.fenceAttemptID)))
            throw new CommandError(
              "conflict",
              "Stopping failed startup compute before editing takeover. Its original identity is retained.",
            );
          await options.stopAgent(changeID);
        }
        const [unsettled] = await database.db
          .select({ changeID: changeAgentSession.changeId })
          .from(changeAgentSession)
          .where(and(eq(changeAgentSession.changeId, changeID), changeAgentSession.stopPending))
          .unionAll(
            database.db
              .select({ changeID: query<string>`${agentTurn.changeId}` })
              .from(agentTurn)
              .where(
                and(
                  eq(agentTurn.changeId, changeID),
                  inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
                ),
              ),
          )
          .unionAll(
            database.db
              .select({ changeID: changeCommitOperation.changeId })
              .from(changeCommitOperation)
              .where(
                and(
                  eq(changeCommitOperation.changeId, changeID),
                  notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                ),
              ),
          );
        if (unsettled)
          throw new CommandError(
            "conflict",
            "Waiting for confirmed Agent Stop before editing takeover",
          );
        if (!(await stopped(intended.fenceAttemptID)))
          throw new CommandError(
            "conflict",
            "Stopping previous commands. Retry editing takeover when compute has stopped.",
          );
        await database.client.begin(async (sql) => {
          const current = await lockChangeWriterIn(sql, changeID);
          await projectDevelopmentAuthorityIn(sql, userID, current.projectID);
          if (
            current.state !== "handoff" ||
            current.epoch !== intended.epoch ||
            current.requestedBy !== userID ||
            current.requestID !== commandID ||
            !current.available
          )
            throw new CommandError("conflict", "Editing takeover changed before confirmation");
          // Keep the policy lock through external branch confirmation. No new Agent
          // admission or revocation may slip between the grant and publication.
          await options.protect(changeID, [forgeUsername(userID)]);
          // Persist the new human epoch before enabling source writes. The first
          // authorized save confirms it, including after a lost acknowledgement.
          const db = drizzleTransaction(sql);
          await db
            .update(changeWriter)
            .set({
              state: "human",
              epoch: query`${changeWriter.epoch}+1`,
              userId: userID,
              requestedBy: null,
              requestId: null,
              fenceRequired: false,
              updatedAt: query`now()`,
            })
            .where(eq(changeWriter.changeId, changeID));
          await db
            .update(changeEditingRequest)
            .set({ state: "superseded", decidedAt: query`now()` })
            .where(
              and(
                eq(changeEditingRequest.changeId, changeID),
                eq(changeEditingRequest.state, "requested"),
              ),
            );
        });
        return readView(changeID, userID);
      });
    },
  };
}
