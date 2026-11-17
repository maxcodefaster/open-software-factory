import type { createDatabase } from "../../../../packages/db/src/client";
import type { AgentTurnTransaction } from "../agent/turn-store";

// Correlated predicate for the change/session/writer aliases in Delivery.
// Integrations keep their latest non-integration origin. Human submission is
// a fenced Workspace receipt, never proof that the retained Coding turn completed.
export function submittedCandidate(
  sql: ReturnType<typeof createDatabase>["client"] | AgentTurnTransaction,
) {
  return sql`(
    writer.state IN ('agent','unassigned') AND NOT writer.fence_required
    AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id
      AND state IN ('pending','dispatching','running','uncertain'))
    AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=change.id
      AND state NOT IN ('succeeded','failed'))
    AND NOT EXISTS(SELECT 1 FROM factory.workspace_shared_document document
      JOIN factory.development_workspace workspace ON workspace.id=document.workspace_id
      WHERE workspace.change_id=change.id AND (document.dirty OR document.conflict))
    AND EXISTS(
      SELECT 1 FROM factory.change_commit_operation submitted
      WHERE submitted.change_id=change.id AND submitted.state='succeeded'
        AND submitted.commit_sha=submitted.observed_remote_sha AND submitted.completed_at IS NOT NULL
        AND submitted.id=(SELECT id FROM factory.change_commit_operation
          WHERE change_id=change.id AND state='succeeded' AND source<>'integration'
          ORDER BY sequence DESC LIMIT 1)
        AND (
          (submitted.source='agent' AND submitted.id=session.active_turn_id
            AND EXISTS(SELECT 1 FROM factory.agent_turn
              WHERE id=submitted.id AND change_id=change.id AND state='completed'))
          OR (submitted.source='workspace' AND writer.state='unassigned'
            AND EXISTS(SELECT 1 FROM factory.workspace_submission submission
              JOIN factory.development_workspace workspace ON workspace.id=submission.workspace_id
              JOIN factory.runtime_attempt attempt ON attempt.id=submitted.runtime_attempt_id
                AND attempt.workspace_id=workspace.id AND attempt.change_id=change.id
              WHERE submission.id=submitted.id AND submission.writer_epoch=writer.epoch
                AND workspace.kind='ticket' AND workspace.change_id=change.id
                AND workspace.project_id=change.project_id
                AND NOT EXISTS(SELECT 1 FROM factory.agent_turn coding
                  WHERE coding.change_id=change.id AND coding.created_at>=submission.created_at
                    AND coding.authority->'review' IS NULL)))
        )
    )
  )`;
}
