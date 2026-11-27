import { and, asc, eq, inArray, isNotNull, isNull, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, changeAgentSession, change as changeTable, runtimeAttempt } from "#db/schema";
import { CommandError } from "../command-error";
import type { PendingWriterHandoff, SqlExecutor } from "./stop-state";

// A review has its own deterministic native Session. Until native confirmation
// is durable, Factory cannot submit its input. A captured stopped/failed Turn fences
// late confirmation and forwarding. Retained implementation history is not
// confirmation of this different Session, nor proof that compute is stopped.
// Keep this proof pure so controlled maintenance can use the same transaction.
export async function confirmUndispatchedReviewStopsIn(
  sql: DatabaseTransaction,
  target?: { changeID: string; stopID: string },
) {
  const db = drizzleTransaction(sql);
  const candidates = await db
    .select({
      changeID: changeAgentSession.changeId,
      stopID: query<string>`${changeAgentSession.stopId}`,
      workspaceID: query<string>`${runtimeAttempt.workspaceId}`,
    })
    .from(changeAgentSession)
    .innerJoin(
      changeTable,
      and(
        eq(changeTable.id, changeAgentSession.changeId),
        eq(changeTable.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
      ),
    )
    .innerJoin(
      runtimeAttempt,
      and(
        eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId),
        isNotNull(runtimeAttempt.workspaceId),
      ),
    )
    .innerJoin(agentTurn, eq(agentTurn.id, changeAgentSession.stopTurnId))
    .where(
      and(
        eq(changeAgentSession.state, "stopped"),
        eq(changeAgentSession.stopPending, true),
        isNotNull(changeAgentSession.stopId),
        isNull(changeAgentSession.nativeSessionConfirmedAt),
        inArray(agentTurn.state, ["stopped", "failed"]),
        query`${agentTurn.input}->>'kind'='change-review'`,
        target ? eq(changeTable.id, target.changeID) : undefined,
        target ? eq(changeAgentSession.stopId, target.stopID) : undefined,
      ),
    )
    .orderBy(asc(runtimeAttempt.workspaceId), asc(changeAgentSession.changeId));
  let count = 0;
  for (const candidate of candidates) {
    // Native metadata-worker admission uses this same Workspace lock. Never
    // wait on it while holding maintenance's admission fence, or use the
    // pre-lock snapshot to decide whether an outstanding worker exists.
    const [lock] = await sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${`runtime:${candidate.workspaceID}`})) AS acquired`;
    if (!lock?.acquired) continue;
    const confirmed = await sql<{ changeID: string }[]>`
    UPDATE factory.change_agent_session session SET stop_pending=false,
      stop_dispatched=false,last_error=NULL,updated_at=now()
    FROM factory.change change, factory.runtime_attempt attempt,
      factory.agent_turn turn, factory.change_agent_turn_intent intent,
      factory.candidate_review review
    WHERE session.change_id=change.id AND change.runtime_attempt_id=attempt.id
      AND attempt.id=session.runtime_attempt_id AND attempt.change_id=change.id
      AND attempt.project_id=change.project_id
      AND change.id=${candidate.changeID} AND session.stop_id=${candidate.stopID}
      AND attempt.workspace_id=${candidate.workspaceID}
      AND session.state='stopped' AND session.stop_pending AND NOT session.stop_dispatched
      AND session.stop_id IS NOT NULL AND session.active_turn_id=session.stop_turn_id
      AND session.native_session_confirmed_at IS NULL
      AND session.implementation_session_confirmed_at IS NOT NULL
      AND session.implementation_session_id IS NOT NULL
      AND session.implementation_session_id<>session.opencode_session_id
      AND turn.id=session.stop_turn_id AND turn.change_id=change.id AND turn.state IN ('stopped','failed')
      AND turn.project_id=change.project_id AND turn.ticket_id=change.ticket_id
      AND turn.input->>'kind'='change-review'
      AND intent.turn_id=turn.id AND intent.change_id=change.id AND intent.bootstrap
      AND intent.runtime_attempt_id=attempt.id AND intent.session_id=session.opencode_session_id
      AND review.id=turn.command_id AND review.turn_id=turn.id AND review.change_id=change.id
      AND (
        (turn.state='stopped' AND review.state='pending')
        OR (turn.state='failed' AND review.state IN ('pending','incomplete') AND review.result IS NULL
          AND turn.authority->>'mode'='build'
          AND turn.authority->'review'->>'verificationId'=review.verification_id::text
          AND turn.authority->'review'->>'commitSha'=review.commit_sha
          AND turn.authority->'review'->>'baseSha'=review.base_sha
          AND EXISTS(SELECT 1 FROM factory.requirement_approval approval
            WHERE approval.id=change.requirement_approval_id AND approval.ticket_id=change.ticket_id
              AND turn.authority->>'requirementRevisionId'=approval.requirement_revision_id::text))
      )
      AND turn.input->>'reviewId'=review.id::text
      AND turn.authority->'review'->>'reviewId'=review.id::text
      AND session.opencode_session_id='ses_factory_review_'||replace(review.id::text,'-','')
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn other WHERE other.change_id=change.id
        AND other.id<>turn.id AND other.state IN ('pending','dispatching','running','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM factory.operation worker
        WHERE worker.kind='runtime.input_stop' AND worker.scope_type='runtime_attempt'
          AND worker.scope_id=attempt.id::text AND worker.completed_at IS NULL)
    RETURNING session.change_id AS "changeID"`;
    count += confirmed.length;
  }
  return count;
}

// Read-only cleanup authority for the original Attempt, not permission to stop
// or dispatch the newly commissioned writer's unassigned input.
export async function requirePendingWriterHandoffIn(
  sql: SqlExecutor,
  attemptID: string,
  handoff: PendingWriterHandoff,
): Promise<void> {
  const [pending] = await sql`
    SELECT attempt.id FROM factory.runtime_attempt attempt
    JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      AND workspace.project_id=attempt.project_id AND workspace.change_id=attempt.change_id
      AND workspace.kind='ticket'
    JOIN factory.change change ON change.id=attempt.change_id AND change.runtime_attempt_id=attempt.id
      AND change.project_id=change.project_id
    JOIN factory.ticket ticket ON ticket.id=change.ticket_id AND ticket.id=workspace.ticket_id
      AND ticket.project_id=change.project_id
    JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
      AND approval.ticket_id=ticket.id
    JOIN factory.change_writer writer ON writer.change_id=change.id
    JOIN factory.agent_turn turn ON turn.id=writer.turn_id AND turn.change_id=change.id
      AND turn.project_id=change.project_id AND turn.ticket_id=ticket.id
    JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id AND intent.change_id=change.id
    WHERE attempt.id=${attemptID}
      AND change.state IN ('starting','active','failed') AND change.cancel_requested_at IS NULL
      AND ticket.trashed_at IS NULL
      AND writer.state='agent-preparing' AND writer.turn_id=${handoff.turnID}
      AND writer.epoch=${handoff.epoch}::bigint AND writer.fence_required
      AND writer.fence_attempt_id=attempt.id
      AND turn.state='pending' AND turn.owner_token IS NOT NULL
      AND turn.owner_expires_at>clock_timestamp() AND turn.authority->>'mode'='build'
      AND turn.authority->>'requirementRevisionId'=approval.requirement_revision_id::text
      AND approval.requirement_revision_id=(SELECT id FROM factory.requirement_revision
        WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1)
      AND intent.runtime_attempt_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=workspace.id AND newer.generation>attempt.generation)
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn active
        WHERE active.change_id=change.id AND active.id<>turn.id
          AND active.state IN ('pending','dispatching','running','uncertain'))`;
  if (!pending)
    throw new CommandError(
      "conflict",
      "Pending writer handoff no longer owns cleanup of the original Workspace.",
    );
}

// Substrate teardown must not turn a lost/queued OpenCode input into apparent
// cancellation. A fresh bootstrap whose native confirmation was fenced cannot
// have submitted input; every confirmed/reused Session needs actual settlement.
export async function requireStoppedAgentInputsIn(
  sql: SqlExecutor,
  attemptID: string,
  handoff?: PendingWriterHandoff,
) {
  if (handoff) await requirePendingWriterHandoffIn(sql, attemptID, handoff);
  const [unsettled] = await sql`
    SELECT attempt.id FROM factory.runtime_attempt attempt
    WHERE attempt.id=${attemptID} AND attempt.change_id IS NOT NULL AND (
      EXISTS(SELECT 1 FROM factory.agent_turn turn
        WHERE turn.change_id=attempt.change_id AND turn.state IN ('pending','dispatching','running','uncertain')
          AND turn.id IS DISTINCT FROM ${handoff?.turnID ?? null}::uuid)
      OR EXISTS(SELECT 1 FROM factory.change_agent_session session
        LEFT JOIN factory.change_agent_turn_intent intent ON intent.turn_id=session.stop_turn_id
        LEFT JOIN factory.agent_turn stopped ON stopped.id=session.stop_turn_id
        WHERE session.change_id=attempt.change_id AND session.runtime_attempt_id=attempt.id
          AND NOT COALESCE((
            (session.state IN ('committed','stopped') AND NOT session.stop_pending)
            OR (session.state='stopped' AND session.stop_pending
              AND session.native_session_confirmed_at IS NULL
              AND session.implementation_session_confirmed_at IS NULL
              AND intent.bootstrap AND intent.runtime_attempt_id=attempt.id
              AND intent.session_id=session.opencode_session_id AND stopped.state IN ('stopped','failed','completed'))
          ),false))
    )`;
  if (unsettled)
    throw new CommandError(
      "conflict",
      "Confirm the current Coding input and queued work before stopping compute. The original Actor and Source were retained.",
    );
}
