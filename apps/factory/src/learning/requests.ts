import type { Sql, TransactionSql } from "postgres";
import { learningReviewWindowMs } from "../../../../packages/conversation-domain/src/learning";

export type ReviewRequest = {
  id: string;
  actorId: string;
  projectId: string;
  ownerId: string | null;
  developerOnly: boolean;
  cases: number;
  requestedAt: Date;
};

// A request is pending until its visibility group starts a work review after it, or an hour
// passes. Calibration never consumes it, so a request survives the judge's first check.
export function pendingReviewRequests(
  sql: Sql | TransactionSql,
  scope: { projectId: string; ownerId: string | null } | null = null,
) {
  return sql<ReviewRequest[]>`
    SELECT command.id,command.actor_id AS "actorId",(command.input->>'projectId')::uuid AS "projectId",
      CASE WHEN command.input->>'scope'='personal' THEN command.actor_id END AS "ownerId",
      (command.input->>'developerOnly')::boolean AS "developerOnly",(command.input->>'cases')::int AS cases,
      command.created_at AS "requestedAt"
    FROM factory.learning_command command
    WHERE command.input->>'kind'='review-now'
      AND command.created_at>now()-make_interval(secs=>${learningReviewWindowMs / 1000})
      AND (${scope?.projectId ?? null}::uuid IS NULL OR (command.input->>'projectId')::uuid=${scope?.projectId ?? null}::uuid)
      AND (${scope === null}::boolean OR (CASE WHEN command.input->>'scope'='personal' THEN command.actor_id END)
        IS NOT DISTINCT FROM ${scope?.ownerId ?? null}::uuid)
      AND NOT EXISTS(SELECT 1 FROM factory.learning_review review
        WHERE review.kind='work' AND review.project_id=(command.input->>'projectId')::uuid
          AND review.owner_id IS NOT DISTINCT FROM (CASE WHEN command.input->>'scope'='personal' THEN command.actor_id END)
          AND review.developer_only=(command.input->>'developerOnly')::boolean
          AND review.created_at>command.created_at)
    ORDER BY command.created_at LIMIT 8`;
}
