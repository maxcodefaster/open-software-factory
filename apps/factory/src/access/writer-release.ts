import { and, eq, sql as query } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { auditEvent, changeWriter } from "#db/schema";
import { CommandError } from "../command-error";
import { projectDevelopmentAuthorityIn } from "./authority";
import { lockChangeWriterIn } from "./change-writer";
import {
  beginWriterHandoff,
  CHANGE_EDITING_DECISION_KIND,
  changeEditingDecisionDedupeKey,
  recordEditingDecision,
  supersedeEditingRequests,
  type WriterContext,
  type WriterView,
  withExclusiveWriter,
} from "./writer-decisions";
import { awaitRuntimeStopped } from "./writer-fencing";
import { readWriterView } from "./writer-views";

export async function releaseChangeWriter(
  context: WriterContext,
  changeID: string,
  userID: string,
  commandID: string,
  expectedEpoch: number,
): Promise<WriterView> {
  const { database, activity } = context;
  return withExclusiveWriter(database, changeID, async () => {
    const intended = await database.client.begin(async (sql) => {
      const writer = await lockChangeWriterIn(sql, changeID);
      await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
      const db = drizzleTransaction(sql);
      const [decision] = await db
        .select({
          actorID: auditEvent.actorId,
          epoch: query<string>`${auditEvent.payload}->>'fromEpoch'`,
          changeID: auditEvent.scopeId,
          kind: query<string>`${auditEvent.payload}->>'kind'`,
        })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.kind, CHANGE_EDITING_DECISION_KIND),
            eq(auditEvent.dedupeKey, changeEditingDecisionDedupeKey(commandID)),
          ),
        );
      if (
        decision &&
        (decision.actorID !== userID ||
          decision.changeID !== changeID ||
          decision.epoch !== String(expectedEpoch) ||
          decision.kind !== "release")
      )
        throw new CommandError("conflict", "This editing decision identity has different input.");
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
      await recordEditingDecision(db, {
        commandID,
        changeID,
        actorID: userID,
        kind: "release",
        fromEpoch: Number(writer.epoch),
        targetUserID: null,
        requestID: null,
      });
      await beginWriterHandoff(db, changeID, "release", userID, commandID);
      return lockChangeWriterIn(sql, changeID);
    });
    if (!intended) return readWriterView(database, activity, changeID, userID);
    await context.fenceSource?.(changeID, intended.epoch, false);
    await context.protect(changeID, []);
    if (
      !(await awaitRuntimeStopped(context.runtime, context.stopDeadlineMs, intended.fenceAttemptID))
    )
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
      await supersedeEditingRequests(db, changeID);
    });
    activity.clear(changeID);
    return readWriterView(database, activity, changeID, userID);
  });
}
