import { and, eq, inArray, isNotNull, isNull, or, sql as query } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  auditEvent,
  authUser,
  changeAgentSession,
  changeWriter,
  operation,
  runtimeAttempt,
} from "#db/schema";
import { CommandError } from "../command-error";
import { projectDevelopmentAuthorityIn } from "./authority";
import { lockChangeWriterIn } from "./change-writer";
import type { WriterActivity } from "./writer-activity";
import {
  CHANGE_EDITING_DECISION_KIND,
  CHANGE_EDITING_REQUEST_KIND,
  changeEditingRequestActiveKey,
  changeEditingRequestKey,
  hasCollaborativeWorkspace,
  type WriterDatabase,
  type WriterView,
} from "./writer-decisions";

export async function readWriterView(
  database: WriterDatabase,
  activity: WriterActivity,
  changeID: string,
  userID: string,
): Promise<WriterView> {
  return database.client.begin(async (sql) => {
    const writer = await lockChangeWriterIn(sql, changeID);
    await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
    const db = drizzleTransaction(sql);
    const shared = await hasCollaborativeWorkspace(db, changeID);
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
              id: operation.id,
              userID: authUser.id,
              name: query<string>`left(${authUser.name},160)`,
              epoch: query<number>`(${operation.payload}->>'writerEpoch')::bigint::float8`,
            })
            .from(operation)
            .innerJoin(authUser, eq(authUser.id, operation.createdBy))
            .where(
              and(
                eq(operation.kind, CHANGE_EDITING_REQUEST_KIND),
                eq(operation.scopeType, "change"),
                eq(operation.scopeId, changeID),
                eq(query<string>`${operation.payload}->>'writerEpoch'`, writer.epoch),
                eq(operation.state, "requested"),
                or(
                  eq(query<string>`${operation.payload}->>'ownerId'`, userID),
                  eq(operation.createdBy, userID),
                ),
              ),
            )
            .orderBy(operation.createdAt, operation.id)
        : [];
    return {
      state: writer.state,
      epoch: Number(writer.epoch),
      canWrite:
        writer.available &&
        !stopPending &&
        writer.state === "human" &&
        (writer.userID === userID || shared),
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

export async function recordWriterActivity(
  database: WriterDatabase,
  activity: WriterActivity,
  changeID: string,
  userID: string,
  expectedEpoch: number,
  kind: "edit" | "heartbeat",
) {
  await database.client.begin(async (sql) => {
    const writer = await lockChangeWriterIn(sql, changeID);
    await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
    const shared = await hasCollaborativeWorkspace(drizzleTransaction(sql), changeID);
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
}

export async function requestChangeEditing(
  database: WriterDatabase,
  changeID: string,
  userID: string,
  commandID: string,
  expectedEpoch: number,
) {
  await database.client.begin(async (sql) => {
    const writer = await lockChangeWriterIn(sql, changeID);
    await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
    const db = drizzleTransaction(sql);
    const [previous] = await db
      .select({
        changeID: operation.scopeId,
        userID: query<string>`${operation.payload}->>'requesterId'`,
        epoch: query<string>`${operation.payload}->>'writerEpoch'`,
      })
      .from(operation)
      .where(and(eq(operation.id, commandID), eq(operation.kind, CHANGE_EDITING_REQUEST_KIND)));
    if (previous) {
      if (
        previous.changeID !== changeID ||
        previous.userID !== userID ||
        previous.epoch !== String(expectedEpoch)
      )
        throw new CommandError("conflict", "This editing request identity has different input.");
      return;
    }
    if (
      !writer.available ||
      writer.state !== "human" ||
      writer.userID === userID ||
      writer.epoch !== String(expectedEpoch) ||
      !writer.userID
    )
      throw new CommandError("conflict", "The writer changed. Check the current editing status.");
    await db
      .insert(operation)
      .values({
        id: commandID,
        kind: CHANGE_EDITING_REQUEST_KIND,
        scopeType: "change",
        scopeId: changeID,
        idempotencyKey: changeEditingRequestKey(commandID),
        activeKey: changeEditingRequestActiveKey(changeID, userID, writer.epoch),
        state: "requested",
        createdBy: userID,
        payload: {
          changeId: changeID,
          requesterId: userID,
          ownerId: writer.userID,
          writerEpoch: expectedEpoch,
          decidedBy: null,
          decidedAt: null,
        },
      })
      .onConflictDoNothing({ target: operation.activeKey });
  });
}

export async function findEditingRequestRequester(
  database: WriterDatabase,
  changeID: string,
  userID: string,
  requestID: string,
): Promise<string> {
  const [request] = await database.db
    .select({ requesterID: query<string>`${operation.payload}->>'requesterId'` })
    .from(operation)
    .where(
      and(
        eq(operation.id, requestID),
        eq(operation.kind, CHANGE_EDITING_REQUEST_KIND),
        eq(operation.scopeType, "change"),
        eq(operation.scopeId, changeID),
        eq(query<string>`${operation.payload}->>'ownerId'`, userID),
      ),
    );
  if (!request) throw new CommandError("not-found", "Editing request not found.");
  return request.requesterID;
}

export async function findPendingViewContinuation(
  database: WriterDatabase,
  changeID: string,
  userID: string,
): Promise<
  | { kind: "takeover"; commandID: string }
  | { kind: "release"; commandID: string; epoch: number }
  | null
> {
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
  if (pending?.commandID) return { kind: "takeover", commandID: pending.commandID };
  const [release] = await database.db
    .select({
      commandID: changeWriter.requestId,
      epoch: query<number>`(${auditEvent.payload}->>'fromEpoch')::bigint::float8`,
    })
    .from(changeWriter)
    .innerJoin(
      auditEvent,
      and(
        eq(auditEvent.id, changeWriter.requestId),
        eq(auditEvent.kind, CHANGE_EDITING_DECISION_KIND),
        eq(auditEvent.scopeType, "change"),
        eq(auditEvent.scopeId, query<string>`${changeWriter.changeId}::text`),
        eq(auditEvent.actorId, changeWriter.requestedBy),
        eq(query<string>`${auditEvent.payload}->>'kind'`, "release"),
        eq(query`(${auditEvent.payload}->>'fromEpoch')::bigint + 1`, changeWriter.epoch),
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
    return { kind: "release", commandID: release.commandID, epoch: release.epoch };
  return null;
}
