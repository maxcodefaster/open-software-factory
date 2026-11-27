import { and, eq, sql as expression, notExists } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, change, changeWriter, operation, ticket, ticketConversation } from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { lockChangeWriterIn } from "../access/change-writer";
import { CommandError } from "../command-error";
import { lockConversation } from "../conversations/api";
import { monitoringChangeAuthorityIn } from "../monitoring/authority";
import type { AgentTurnRecord } from "./turn-record";
import {
  type BuildTurnAuthority,
  type BuildTurnCommand,
  CODING_PAUSE_KIND,
  type CodingPauseReason,
  type CodingPauseState,
  classifyTurnScope,
  type Database,
  unresumedCodingPauseWhere,
} from "./turn-store-types";

export async function lockTurnChangeIn(sql: DatabaseTransaction, id: string) {
  const [scope] = await drizzleTransaction(sql)
    .select({ changeID: agentTurn.changeId })
    .from(agentTurn)
    .where(eq(agentTurn.id, id));
  // The immutable linkage selects a lock, never execution authority. Writer
  // transitions already hold Change before Turn; renewal and validation must
  // follow that order too. The owned row and current authority are read below
  // after this wait, including a fresh lease-expiry check.
  if (scope?.changeID) await lockChangeWriterIn(sql, scope.changeID);
}

async function validateReviewAuthorityIn(
  sql: DatabaseTransaction,
  turnID: string,
  changeID: string,
  review: NonNullable<BuildTurnAuthority["review"]>,
) {
  const [candidate] = await sql`
    SELECT review.id FROM factory.candidate_review review
    JOIN factory.verification verification ON verification.id=review.verification_id
    JOIN factory.change change ON change.id=review.change_id
    WHERE review.id=${review.reviewId} AND review.turn_id=${turnID}
      AND review.change_id=${changeID} AND review.verification_id=${review.verificationId}
      AND review.commit_sha=${review.commitSha} AND review.base_sha=${review.baseSha}
      AND COALESCE((SELECT integration_base_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1),change.base_sha)=review.base_sha
      AND verification.state='succeeded'
      AND verification.runner_id IS NULL
      AND (verification.runtime_attempt_id IS NULL OR EXISTS(
        SELECT 1 FROM factory.runtime_attempt execution
        WHERE execution.id=verification.runtime_attempt_id AND execution.state='stopped'
          AND execution.deleted_at IS NOT NULL
      ))
      AND review.state IN ('pending','running')
      AND review.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)`;
  return Boolean(candidate);
}

async function hasBlockingStopIn(
  sql: DatabaseTransaction,
  changeID: string,
  record: AgentTurnRecord,
  renewingPreparation: boolean,
) {
  const stopping = await sql<Array<{ id: string }>>`
    SELECT session.change_id AS id FROM factory.change_agent_session session
      WHERE session.change_id = ${changeID} AND session.stop_pending
        AND NOT (${renewingPreparation && record.state === "pending"}
          AND session.stop_turn_id IS DISTINCT FROM ${record.id}::uuid
          AND EXISTS(
            SELECT 1 FROM factory.change_writer writer
            JOIN factory.change change ON change.id=writer.change_id
              AND change.runtime_attempt_id=session.runtime_attempt_id
            JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
              AND attempt.change_id=change.id
            JOIN factory.change_agent_turn_intent intent ON intent.turn_id=writer.turn_id
              AND intent.change_id=change.id AND intent.runtime_attempt_id IS NULL
            WHERE writer.change_id=change.id AND writer.turn_id=${record.id}
              AND writer.state='agent-preparing' AND writer.fence_required
              AND writer.fence_attempt_id=attempt.id))`;
  return Boolean(stopping[0]);
}

async function validateBuildAuthorityIn(
  sql: DatabaseTransaction,
  record: AgentTurnRecord,
  command: BuildTurnCommand,
  authority: BuildTurnAuthority,
  renewingPreparation: boolean,
) {
  const db = drizzleTransaction(sql);
  const locked = await db
    .select({ id: change.id })
    .from(change)
    .innerJoin(ticket, eq(ticket.id, change.ticketId))
    .where(
      and(
        eq(change.id, command.changeId),
        eq(change.ticketId, command.ticketId),
        eq(change.projectId, command.projectId),
      ),
    )
    .for("update");
  if (!locked[0]) return false;
  const [writer] = await db
    .select({ state: changeWriter.state, turnID: changeWriter.turnId })
    .from(changeWriter)
    .where(eq(changeWriter.changeId, command.changeId));
  if (
    writer &&
    (["human", "handoff"].includes(writer.state) ||
      (["agent", "agent-preparing"].includes(writer.state) && writer.turnID !== record.id))
  ) {
    return false;
  }
  // This fresh read occurs after any lock wait; approval/revision reads from an
  // earlier statement's snapshot cannot authorize newly changed Requirements.
  const approved = await sql<Array<{ id: string }>>`
    SELECT change.id FROM factory.change change
      JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
      WHERE change.id = ${command.changeId} AND change.state IN ('starting', 'active')
        AND NOT EXISTS(SELECT 1 FROM factory.ticket WHERE id = ${command.ticketId} AND trashed_at IS NOT NULL)
        AND approval.requirement_revision_id = ${authority.requirementRevisionId}
        AND approval.requirement_revision_id = (SELECT id FROM factory.requirement_revision
          WHERE ticket_id = ${command.ticketId} ORDER BY ordinal DESC LIMIT 1)`;
  if (!approved[0]) return false;
  if (
    authority.review &&
    !(await validateReviewAuthorityIn(sql, record.id, command.changeId, authority.review))
  ) {
    return false;
  }
  if (await hasBlockingStopIn(sql, command.changeId, record, renewingPreparation)) return false;
  const conversations = await db
    .select({
      id: ticketConversation.id,
      mode: ticketConversation.mode,
      version: ticketConversation.version,
      contextID: ticketConversation.activeCodingContextId,
    })
    .from(ticketConversation)
    .where(eq(ticketConversation.ticketId, command.ticketId))
    .for("update");
  if (command.conversationId === null) {
    return conversations.length === 0 && authority.conversationVersion === null;
  }
  return (
    conversations[0]?.id === command.conversationId &&
    (conversations[0].contextID ?? undefined) === command.contextId &&
    conversations[0].mode === "build" &&
    conversations[0].version === authority.conversationVersion
  );
}

export async function currentAuthorityIn(
  database: Database,
  sql: DatabaseTransaction,
  record: AgentTurnRecord,
  renewingPreparation = false,
) {
  const scope = classifyTurnScope(record);
  const { command, authority } = record;
  const db = drizzleTransaction(sql);
  if (scope?.kind === "build") {
    // Writer transitions take Change before membership. Agent validation must
    // keep this order rather than deadlocking a concurrent human save/handoff.
    await lockChangeWriterIn(sql, scope.command.changeId);
  } else if (command.ticketId) {
    const [currentTicket] = await db
      .select({
        trashed: expression<boolean>`${ticket.trashedAt} IS NOT NULL OR ${ticket.convertedToEpicId} IS NOT NULL`,
      })
      .from(ticket)
      .where(eq(ticket.id, command.ticketId))
      .for("share");
    if (!currentTicket || currentTicket.trashed) return false;
  }
  try {
    await projectAuthorityIn(sql, command.createdBy, command.projectId);
    if (scope?.kind === "build" && scope.authority.monitoringIncidentId) {
      const delegated = await monitoringChangeAuthorityIn(
        database,
        sql,
        scope.command.changeId,
        scope.authority.monitoringIncidentId,
      );
      if (delegated.userId !== command.createdBy) return false;
    }
  } catch (cause) {
    if (cause instanceof CommandError) return false;
    throw cause;
  }
  if (!scope) return false;
  if (scope.kind === "project") {
    const current = scope.command.conversationId
      ? await lockConversation(sql, scope.command.conversationId, scope.command.contextId)
      : undefined;
    return current?.mode === authority.mode && current.version === authority.conversationVersion;
  }
  return validateBuildAuthorityIn(sql, record, scope.command, scope.authority, renewingPreparation);
}

export async function pauseCodingTurnIn(
  db: ReturnType<typeof drizzleTransaction>,
  turnID: string,
  reason: CodingPauseReason,
): Promise<Extract<CodingPauseState, { kind: "paused" }>> {
  const payload = { turnId: turnID, reason, resumedByTurnId: null };
  await db
    .insert(operation)
    .values({
      id: crypto.randomUUID(),
      kind: CODING_PAUSE_KIND,
      scopeType: "agent_turn",
      scopeId: turnID,
      idempotencyKey: `${CODING_PAUSE_KIND}:${turnID}`,
      activeKey: null,
      state: "paused",
      payload,
    })
    .onConflictDoUpdate({
      target: operation.idempotencyKey,
      set: {
        state: "paused",
        payload,
        createdAt: expression`now()`,
        updatedAt: expression`now()`,
        completedAt: null,
      },
    });
  await db
    .update(agentTurn)
    .set({ ownerToken: null, ownerExpiresAt: null, updatedAt: expression`now()` })
    .where(eq(agentTurn.id, turnID));
  return { kind: "paused", ...payload };
}

export async function resumeCodingTurnIn(
  db: ReturnType<typeof drizzleTransaction>,
  turnID: string,
): Promise<Extract<CodingPauseState, { kind: "resumed" }>> {
  await db
    .update(operation)
    .set({
      state: "resumed",
      payload: expression`${operation.payload} || ${JSON.stringify({ resumedByTurnId: turnID })}::jsonb`,
      updatedAt: expression`now()`,
      completedAt: expression`now()`,
    })
    .where(unresumedCodingPauseWhere(turnID));
  return { kind: "resumed", turnId: turnID, resumedByTurnId: turnID };
}

export function notPausedCodingTurn(database: Database, turnID: string) {
  return notExists(
    database.db
      .select({ id: operation.id })
      .from(operation)
      .where(unresumedCodingPauseWhere(turnID)),
  );
}
