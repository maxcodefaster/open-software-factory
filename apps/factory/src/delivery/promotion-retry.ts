import { and, eq, isNull, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  auditEvent,
  change as changeTable,
  operation as operationTable,
  project,
  ticket,
} from "#db/schema";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";

// Persist a new Promotion, never reset the failed operation or repeat merge.
// The command's identity is also the new immutable Promotion identity.
export async function retryPromotion(
  database: ReturnType<typeof createDatabase>,
  changeID: string,
  userID: string,
  commandID: string,
  promotionID: string,
  defaultHead: (repositoryURL: string) => Promise<string>,
) {
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const lockedChange = alias(changeTable, "change");
    const lockedTicket = alias(ticket, "ticket");
    const [change] = await db
      .select({
        projectID: lockedChange.projectId,
        state: lockedChange.state,
        repositoryURL: project.repositoryUrl,
      })
      .from(lockedChange)
      .innerJoin(project, eq(project.id, lockedChange.projectId))
      .innerJoin(
        lockedTicket,
        and(eq(lockedTicket.id, lockedChange.ticketId), isNull(lockedTicket.trashedAt)),
      )
      .where(eq(lockedChange.id, changeID))
      .for("update", { of: [lockedChange, lockedTicket] });
    if (!change) throw new CommandError("not-found", "Change not found");
    await projectDevelopmentAuthorityIn(sql, userID, change.projectID);
    const scope = `promotion-retry:${changeID}`;
    const dedupeKey = `usage.policy_command:${commandID}`;
    const input = { changeID, promotionID };
    const [replay] = await db
      .select({
        scope: auditEvent.scopeId,
        actor: auditEvent.actorId,
        input: query<typeof input>`${auditEvent.payload}->'input'`,
      })
      .from(auditEvent)
      .where(eq(auditEvent.dedupeKey, dedupeKey));
    if (replay) {
      if (
        replay.scope !== scope ||
        replay.actor !== userID ||
        replay.input.changeID !== changeID ||
        replay.input.promotionID !== promotionID
      )
        throw new CommandError("conflict", "Promotion retry changed target");
      return false;
    }
    const [previous] = await sql<
      {
        id: string;
        ordinal: number;
        state: string;
        commitSHA: string;
        previousAttemptID: string | null;
        replacementAttemptID: string | null;
        replacementState: string | null;
        released: boolean;
        merged: boolean;
      }[]
    >`SELECT promotion.id,promotion.ordinal,promotion.state,promotion.commit_sha AS "commitSHA",
      promotion.previous_runtime_attempt_id AS "previousAttemptID",
      promotion.replacement_runtime_attempt_id AS "replacementAttemptID",
      runtime.state AS "replacementState",
      (runtime.id IS NULL OR runtime.deleted_at IS NOT NULL) AS released,
      EXISTS(SELECT 1 FROM factory.operation merge
        WHERE merge.kind='delivery.merge' AND merge.scope_type='change'
          AND merge.scope_id=promotion.change_id::text AND merge.state='succeeded'
          AND merge.payload->>'commitSha'=promotion.commit_sha
          AND merge.result->>'mergeSha'=promotion.commit_sha) AS merged
      FROM factory.current_promotion promotion
      LEFT JOIN factory.runtime_attempt runtime ON runtime.id=promotion.replacement_runtime_attempt_id
      WHERE promotion.change_id=${changeID}`;
    if (!previous || previous.id !== promotionID)
      throw new CommandError(
        "conflict",
        "Promotion changed. Refresh before retrying Main Preview.",
      );
    if (
      change.state !== "delivering" ||
      previous.state !== "failed" ||
      !previous.merged ||
      !previous.replacementAttemptID ||
      !["failed", "stopped"].includes(previous.replacementState ?? "") ||
      !previous.released
    )
      throw new CommandError(
        "conflict",
        "Retry Main Preview only after its failed replacement and owned cleanup are confirmed.",
      );
    const [staging] = await db
      .select({
        attemptID: query<string | null>`${operationTable.payload}->>'runtimeAttemptId'`,
      })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, "delivery.staging_preview"),
          eq(operationTable.scopeType, "project"),
          eq(operationTable.scopeId, change.projectID),
          eq(operationTable.idempotencyKey, `delivery.staging_preview:${change.projectID}`),
        ),
      )
      .for("update");
    if ((staging?.attemptID ?? null) !== previous.previousAttemptID)
      throw new CommandError(
        "conflict",
        "The current Main Preview changed. Its identity was retained.",
      );
    if ((await defaultHead(change.repositoryURL)) !== previous.commitSHA)
      throw new CommandError("conflict", "The default branch changed after this merge.");
    const result = { promotionID: commandID };
    await db.insert(auditEvent).values({
      id: commandID,
      kind: "usage.policy_command",
      scopeType: "execution_policy",
      scopeId: scope,
      actorId: userID,
      dedupeKey,
      payload: {
        commandId: commandID,
        scope,
        actorId: userID,
        input,
        result,
      },
    });
    const nextOrdinal = previous.ordinal + 1;
    await db.insert(operationTable).values({
      id: commandID,
      kind: "delivery.promotion",
      scopeType: "change",
      scopeId: changeID,
      idempotencyKey: `delivery.promotion:${changeID}:${nextOrdinal}`,
      activeKey: `delivery.promotion:${change.projectID}`,
      state: "pending",
      payload: {
        changeId: changeID,
        projectId: change.projectID,
        commitSha: previous.commitSHA,
        previousRuntimeAttemptId: previous.previousAttemptID,
        replacementRuntimeAttemptId: null,
        ordinal: nextOrdinal,
        supersedesId: previous.id,
        retryCommandId: commandID,
      },
      createdBy: userID,
    });
    return true;
  });
}
