import { and, eq, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { auditEvent, change, changeWriter, monitoringIncident, operation } from "#db/schema";
import { forgeUsername } from "#forge/access";
import { CommandError } from "../command-error";
import { projectDevelopmentAuthorityIn } from "./authority";
import { lockChangeWriterIn } from "./change-writer";
import {
  beginWriterHandoff,
  CHANGE_EDITING_DECISION_KIND,
  CHANGE_EDITING_REQUEST_KIND,
  changeEditingDecisionDedupeKey,
  type HumanTransfer,
  recordEditingDecision,
  supersedeEditingRequests,
  type WriterContext,
  type WriterView,
  withExclusiveWriter,
} from "./writer-decisions";
import { fenceAgentForTakeover, isAgentSessionSettledIn } from "./writer-fencing";
import { readWriterView } from "./writer-views";

async function hasActiveDevelopmentAuthorityIn(
  sql: DatabaseTransaction,
  userID: string | null,
  projectID: string,
  missingMessage: string,
) {
  try {
    if (!userID) throw new Error(missingMessage);
    await projectDevelopmentAuthorityIn(sql, userID, projectID);
    return true;
  } catch (cause) {
    if (!(cause instanceof CommandError)) throw cause;
    return false;
  }
}

async function intendTakeoverIn(
  context: WriterContext,
  changeID: string,
  userID: string,
  commandID: string,
  completedEpoch?: string,
  humanTransfer?: HumanTransfer,
  observedEpoch?: number,
) {
  const { database, activity } = context;
  return database.client.begin(async (sql) => {
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
        .select({ commandID: auditEvent.id })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.kind, CHANGE_EDITING_DECISION_KIND),
            eq(auditEvent.dedupeKey, changeEditingDecisionDedupeKey(commandID)),
            eq(auditEvent.scopeType, "change"),
            eq(auditEvent.scopeId, changeID),
            eq(query<string | null>`${auditEvent.payload}->>'targetUserId'`, userID),
            eq(auditEvent.actorId, humanTransfer.approverID ?? userID),
            eq(
              query`(${auditEvent.payload}->>'fromEpoch')::bigint`,
              query`${humanTransfer.epoch}::bigint`,
            ),
            eq(
              query<string>`${auditEvent.payload}->>'kind'`,
              humanTransfer.approverID ? "approve" : "idle-takeover",
            ),
            query`(${auditEvent.payload}->>'requestId') IS NOT DISTINCT FROM ${humanTransfer.requestID ?? null}::text`,
          ),
        );
      if (!decision) throw new CommandError("conflict", "The editing decision changed input.");
    }
    if (completedEpoch) {
      const settled = await isAgentSessionSettledIn(db, changeID);
      if (writer.state !== "agent" || writer.epoch !== completedEpoch || !settled) return null;
    }
    if (!writer.available)
      throw new CommandError("conflict", "This implementation is no longer active");
    if (writer.state === "human") {
      if (writer.userID === userID) return null;
      let authorizedTransfer = false;
      if (humanTransfer && writer.epoch === String(humanTransfer.epoch) && writer.userID) {
        if (humanTransfer.approverID && humanTransfer.requestID) {
          await projectDevelopmentAuthorityIn(sql, humanTransfer.approverID, writer.projectID);
          const [request] = await db
            .select({ id: operation.id })
            .from(operation)
            .where(
              and(
                eq(operation.id, humanTransfer.requestID),
                eq(operation.kind, CHANGE_EDITING_REQUEST_KIND),
                eq(operation.scopeType, "change"),
                eq(operation.scopeId, changeID),
                eq(query<string>`${operation.payload}->>'requesterId'`, userID),
                eq(query<string>`${operation.payload}->>'ownerId'`, humanTransfer.approverID),
                eq(query<string>`${operation.payload}->>'ownerId'`, writer.userID),
                eq(query<string>`${operation.payload}->>'writerEpoch'`, writer.epoch),
                eq(operation.state, "requested"),
              ),
            )
            .for("update");
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
        await recordEditingDecision(db, {
          commandID,
          changeID,
          actorID: humanTransfer?.approverID ?? userID,
          kind: humanTransfer?.approverID ? "approve" : "idle-takeover",
          fromEpoch: Number(writer.epoch),
          targetUserID: userID,
          requestID: humanTransfer?.requestID ?? null,
        });
        if (humanTransfer?.requestID) {
          const decidedAt = new Date().toISOString();
          await db
            .update(operation)
            .set({
              state: "accepted",
              activeKey: null,
              payload: query`${operation.payload} || ${JSON.stringify({
                decidedBy: humanTransfer.approverID ?? userID,
                decidedAt,
              })}::jsonb`,
              completedAt: query`now()`,
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(operation.id, humanTransfer.requestID),
                eq(operation.kind, CHANGE_EDITING_REQUEST_KIND),
              ),
            );
        }
      }
      const holderActive = await hasActiveDevelopmentAuthorityIn(
        sql,
        writer.userID,
        writer.projectID,
        "Human writer identity is unavailable",
      );
      if (!holderActive) {
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
        throw new CommandError("conflict", "Another developer is editing this implementation");
    }
    if (writer.state === "handoff") {
      if (continuing) return writer;
      const requesterActive = await hasActiveDevelopmentAuthorityIn(
        sql,
        writer.requestedBy,
        writer.projectID,
        "Takeover identity is unavailable",
      );
      if (!requesterActive) {
        await recordEditingDecision(db, {
          commandID,
          changeID,
          actorID: userID,
          kind: "takeover",
          fromEpoch: Number(writer.epoch),
          targetUserID: userID,
          requestID: null,
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
    if (!humanTransfer) {
      await recordEditingDecision(db, {
        commandID,
        changeID,
        actorID: userID,
        kind: "takeover",
        fromEpoch: Number(writer.epoch),
        targetUserID: userID,
        requestID: null,
      });
    }
    await beginWriterHandoff(db, changeID, "takeover", userID, commandID);
    return lockChangeWriterIn(sql, changeID);
  });
}

async function confirmTakeoverIn(
  context: WriterContext,
  changeID: string,
  userID: string,
  commandID: string,
  expectedEpoch: string,
) {
  await context.database.client.begin(async (sql) => {
    const current = await lockChangeWriterIn(sql, changeID);
    await projectDevelopmentAuthorityIn(sql, userID, current.projectID);
    if (
      current.state !== "handoff" ||
      current.epoch !== expectedEpoch ||
      current.requestedBy !== userID ||
      current.requestID !== commandID ||
      !current.available
    )
      throw new CommandError("conflict", "Editing takeover changed before confirmation");
    // Keep the policy lock through external branch confirmation. No new Agent
    // admission or revocation may slip between the grant and publication.
    await context.protect(changeID, [forgeUsername(userID)]);
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
    await supersedeEditingRequests(db, changeID);
  });
}

export async function takeOverChangeWriter(
  context: WriterContext,
  changeID: string,
  userID: string,
  commandID: string,
  completedEpoch?: string,
  humanTransfer?: HumanTransfer,
  observedEpoch?: number,
): Promise<WriterView> {
  const { database, activity } = context;
  return withExclusiveWriter(database, changeID, async () => {
    const intended = await intendTakeoverIn(
      context,
      changeID,
      userID,
      commandID,
      completedEpoch,
      humanTransfer,
      observedEpoch,
    );
    if (!intended) return readWriterView(database, activity, changeID, userID);
    await context.fenceSource?.(changeID, intended.epoch, false);
    await database.client.begin(async (sql) => {
      const current = await lockChangeWriterIn(sql, changeID);
      if (
        current.state !== "handoff" ||
        current.epoch !== intended.epoch ||
        current.requestID !== commandID
      )
        throw new CommandError("conflict", "Editing takeover changed before fencing");
      await context.protect(changeID, []);
    });
    await fenceAgentForTakeover(context, changeID, intended.fenceAttemptID);
    await confirmTakeoverIn(context, changeID, userID, commandID, intended.epoch);
    return readWriterView(database, activity, changeID, userID);
  });
}
