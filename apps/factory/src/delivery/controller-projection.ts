import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  isNotNull,
  ne,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import {
  candidateReview,
  changeCommitOperation,
  change as changeTable,
  project,
  reviewFeedback,
  runtimeAttempt,
  ticket,
  verification as verificationTable,
} from "#db/schema";
import { submittedCandidate } from "../agent/candidate-api";
import type { Database, DrizzleDB } from "./controller-types";

export async function countFailedCorrections(db: DrizzleDB, changeID: string) {
  const failedVerifications = db
    .select({ count: count() })
    .from(verificationTable)
    .where(
      and(
        eq(verificationTable.changeId, changeID),
        eq(verificationTable.state, "failed"),
        isNotNull(verificationTable.repairPromptedAt),
      ),
    );
  const failedReviews = db
    .select({ count: count() })
    .from(candidateReview)
    .where(
      and(
        eq(candidateReview.changeId, changeID),
        eq(candidateReview.state, "changes-requested"),
        isNotNull(candidateReview.repairPromptedAt),
      ),
    );
  const [row] = await db
    .select({
      count: query<number>`((${failedVerifications}) + (${failedReviews}))::integer`,
    })
    .from(changeTable)
    .where(eq(changeTable.id, changeID));
  return Number(row?.count ?? 0);
}

export async function readDeliveryChange(db: DrizzleDB, changeID: string) {
  const commit = db
    .select({
      commitSHA: changeCommitOperation.commitSha,
      integrationBaseSHA: changeCommitOperation.integrationBaseSha,
    })
    .from(changeCommitOperation)
    .where(
      and(
        eq(changeCommitOperation.changeId, changeTable.id),
        eq(changeCommitOperation.state, "succeeded"),
      ),
    )
    .orderBy(desc(changeCommitOperation.sequence))
    .limit(1)
    .as("commit");
  const rows = await db
    .select({
      id: changeTable.id,
      projectID: changeTable.projectId,
      ticketID: changeTable.ticketId,
      title: ticket.title,
      description: ticket.description,
      branchName: changeTable.branchName,
      baseSHA: query<string>`COALESCE(${commit.integrationBaseSHA},${changeTable.baseSha})`,
      state: changeTable.state,
      trashed: isNotNull(ticket.trashedAt),
      userID: changeTable.createdBy,
      repositoryURL: project.repositoryUrl,
      defaultBranch: project.defaultBranch,
      commitSHA: commit.commitSHA,
      runtimeAttemptID: changeTable.runtimeAttemptId,
      deliveryWaitingSHA: changeTable.deliveryWaitingSha,
      deliveryWaitingPolicyID: changeTable.deliveryWaitingPolicyId,
    })
    .from(changeTable)
    .innerJoin(ticket, eq(ticket.id, changeTable.ticketId))
    .innerJoin(project, eq(project.id, changeTable.projectId))
    .leftJoinLateral(commit, query`true`)
    .where(eq(changeTable.id, changeID));
  return rows[0] ?? null;
}

export type DeliveryChangeRow = NonNullable<Awaited<ReturnType<typeof readDeliveryChange>>>;

export async function isChangeBlockedForDelivery(
  database: Database,
  changeID: string,
  commitSHA: string,
) {
  const [blocked] =
    await database.client`SELECT session.change_id FROM factory.change_agent_session session
      JOIN factory.change_writer writer ON writer.change_id=session.change_id
      LEFT JOIN factory.agent_turn turn ON turn.id=session.active_turn_id
       WHERE session.change_id=${changeID} AND (session.stop_pending OR (session.state IN ('failed','stopped','waiting') AND NOT EXISTS(
         SELECT id FROM factory.change_commit_operation WHERE change_id=${changeID} AND source::text='workspace' AND state='succeeded'
           AND sequence=(SELECT max(sequence) FROM factory.change_commit_operation WHERE change_id=${changeID} AND state='succeeded')))
        OR (session.state IN ('starting','working') AND turn.authority->'review' IS NULL)
        OR writer.state IN ('human','handoff') OR EXISTS(
          SELECT 1 FROM factory.candidate_review review
          JOIN factory.verification verification ON verification.id=review.verification_id
          LEFT JOIN factory.agent_turn reviewer ON reviewer.id=review.turn_id
          WHERE review.change_id=${changeID} AND verification.commit_sha=${commitSHA}
            AND review.ordinal=(SELECT MAX(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
            AND (review.state='incomplete' OR reviewer.state IN ('failed','stopped','uncertain'))))`;
  return Boolean(blocked);
}

export async function hasOpenReviewThread(db: DrizzleDB, changeID: string) {
  const [feedback] = await db
    .select({
      open: exists(
        db
          .select({ id: reviewFeedback.id })
          .from(reviewFeedback)
          .where(
            and(
              eq(reviewFeedback.changeId, changeID),
              eq(reviewFeedback.kind, "thread"),
              ne(reviewFeedback.state, "resolved"),
            ),
          ),
      ),
    })
    .from(changeTable)
    .where(eq(changeTable.id, changeID));
  return Boolean(feedback?.open);
}

export async function listReconcilableChanges(db: DrizzleDB) {
  // The native view remains the owner of current-promotion selection.
  const promotion = db
    .select({
      changeId: query<string>`promotion.change_id`.as("change_id"),
      lastError: query<string | null>`promotion.last_error`.as("last_error"),
    })
    .from(query`factory.current_promotion promotion`)
    .as("promotion");
  return db
    .selectDistinct({
      id: changeTable.id,
      projectID: changeTable.projectId,
      createdAt: query<string>`${changeTable.createdAt}`,
    })
    .from(changeTable)
    .innerJoin(changeCommitOperation, eq(changeCommitOperation.changeId, changeTable.id))
    .leftJoin(promotion, eq(query<string>`"promotion"."change_id"`, changeTable.id))
    .where(
      and(
        eq(changeCommitOperation.state, "succeeded"),
        or(
          ne(changeTable.state, "cancelled"),
          exists(
            db
              .select({ id: verificationTable.id })
              .from(verificationTable)
              .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, verificationTable.runtimeAttemptId))
              .where(
                and(
                  eq(verificationTable.changeId, changeTable.id),
                  or(
                    isNotNull(verificationTable.runnerId),
                    notInArray(runtimeAttempt.state, ["stopped", "failed"]),
                  ),
                ),
              ),
          ),
        ),
        or(
          ne(changeTable.state, "delivered"),
          isNotNull(query<string | null>`"promotion"."last_error"`),
        ),
      ),
    )
    .orderBy(asc(changeTable.createdAt), asc(changeTable.id));
}

export async function getDeliveryView(database: Database, changeID: string) {
  const rows = await database.client<Array<Record<string, unknown>>>`
    SELECT (pr.result->>'number')::bigint AS "pullRequestNumber",
      verification.id AS "verificationId",
      CASE WHEN session.state='stopped' AND NOT session.stop_pending
        AND writer.state IN ('agent','unassigned') AND change.cancel_requested_at IS NULL
        AND ${submittedCandidate(database.client)}
        AND EXISTS(SELECT 1 FROM factory.ticket WHERE id=change.ticket_id AND trashed_at IS NULL)
        AND verification.state<>'cancelled' AND change.state='active'
        THEN session.stop_id END AS "checksStopId",
      CASE WHEN verification.state='failed' AND change.state='active'
        AND change.cancel_requested_at IS NULL
        AND (session.change_id IS NULL OR (session.state='committed' AND NOT session.stop_pending))
        AND writer.state IN ('agent','unassigned')
        AND verification.runner_id IS NULL AND verification.action_run_id IS NOT NULL
        AND verification.completed_at IS NOT NULL AND verification.repair_prompted_at IS NULL
        AND verification_runtime.state='stopped' AND verification_runtime.verification_id=verification.id
        AND verification.diagnosis->>'kind'='execution-failed'
        AND verification.diagnosis->>'runtimeAttemptId'=verification_runtime.id::text
        AND verification.diagnosis->'jobs'='[]'::jsonb
        AND ${submittedCandidate(database.client)}
        AND verification_runtime.deleted_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM factory.review_feedback WHERE change_id=change.id
          AND kind='thread' AND state<>'resolved')
        AND EXISTS(SELECT 1 FROM factory.ticket WHERE id=change.ticket_id AND trashed_at IS NULL)
        THEN verification_runtime.id END AS "checksRetryAttemptId",
      review.id AS "reviewId",
      pr.result->>'url' AS "pullRequestUrl", pr.state AS "pullRequestState",
      verification.commit_sha AS "verificationCommitSha",
      CASE WHEN failed_verification.id IS NOT NULL THEN 'failed'
        ELSE verification.state::text END AS "verificationState",
      CASE WHEN failed_verification.id IS NOT NULL THEN
        COALESCE(left(failed_verification.failure,1000),'Verification compute failed before checks completed.')
        ELSE verification.summary END AS "verificationSummary",
      CASE WHEN verification.state IN ('pending','runner-starting')
        AND verification_runtime.state IN ('create-intended','starting')
        THEN left(nullif(verification_runtime.failure,''),1000) END AS "verificationPreparationFailure",
      EXISTS(SELECT 1 FROM factory.operation waiting
        WHERE waiting.kind='runtime.compute_wait' AND waiting.scope_type='runtime_attempt'
          AND waiting.scope_id=verification_runtime.id::text
          AND waiting.idempotency_key='runtime.compute_wait:' || verification_runtime.id::text
          AND waiting.payload->>'reason'='compute-capacity'
          AND verification_runtime.verification_id=verification.id
          AND verification_runtime.state='starting' AND nullif(verification_runtime.failure,'') IS NULL
          AND verification_runtime.ready_at IS NULL AND verification_runtime.stop_intended_at IS NULL
          AND verification.state IN ('pending','runner-starting')
          AND change.state='active' AND change.cancel_requested_at IS NULL
          AND session.state='committed' AND NOT session.stop_pending
          AND writer.state IN ('agent','unassigned')
          AND EXISTS(SELECT 1 FROM auth."user" principal
            JOIN factory.account_access access ON access.user_id=principal.id
            WHERE principal.id=verification.created_by
              AND access.disabled_at IS NULL AND access.directory_disabled_at IS NULL
              AND (EXISTS(SELECT 1 FROM factory.project_membership membership
                WHERE membership.project_id=change.project_id AND membership.user_id=principal.id)
                OR EXISTS(SELECT 1 FROM factory.administrator administrator
                  WHERE administrator.user_id=principal.id)))
          AND EXISTS(SELECT 1 FROM factory.ticket WHERE id=change.ticket_id
            AND state<>'cancelled' AND trashed_at IS NULL)) AS "verificationComputeWait",
      CASE WHEN failed_verification.id IS NOT NULL THEN 'execution-failed'
        WHEN verification.state='failed' THEN verification.diagnosis->>'kind' END AS "verificationFailureKind",
      CASE WHEN latest_turn.input->>'kind'='change-repair' THEN latest_turn.state::text END AS "correctionState",
      verification.action_run_url AS "actionRunUrl",
      CASE WHEN review.state IN ('pending','running') AND review_turn.state IN ('failed','stopped','uncertain')
        THEN review_turn.state::text ELSE review.state END AS "reviewState",
      (review.turn_id IS NOT NULL AND review.turn_id=(SELECT id FROM factory.agent_turn
        WHERE change_id=change.id ORDER BY created_at DESC,id DESC LIMIT 1)) AS "reviewCurrent",
      COALESCE(review.result->>'summary',review_turn.outcome_summary) AS "reviewSummary",
      review.result->'findings' AS "reviewFindings",
      (SELECT count(*)::int FROM factory.review_feedback
        WHERE change_id=change.id AND kind='thread' AND state<>'resolved') AS "openReviewThreads",
      approval.approved_at AS "approvedAt",
      approval.monitoring_policy_id AS "monitoringPolicyId",
      approval.delivery_policy_id AS "deliveryPolicyId",
      autofix.id AS "monitoringIncidentId",autofix.state AS "monitoringState",
      autofix.reason AS "monitoringReason",
      merge.state AS "mergeState", merge.result->>'mergeSha' AS "mergedCommitSha",
      promotion.id AS "promotionId",promotion.state AS "promotionState",
      promotion.last_error AS "cleanupError",
      promotion.replacement_runtime_attempt_id AS "replacementRuntimeAttemptId",
      replacement.state AS "replacementRuntimeState",
      left(replacement.failure,2000) AS "promotionFailure"
    FROM factory.change change
    LEFT JOIN factory.monitoring_incident autofix ON autofix.ticket_id=change.ticket_id
    LEFT JOIN factory.change_agent_session session ON session.change_id=change.id
    LEFT JOIN factory.change_writer writer ON writer.change_id=change.id
    LEFT JOIN LATERAL (
      SELECT input,state FROM factory.agent_turn WHERE change_id=change.id
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) latest_turn ON true
    LEFT JOIN LATERAL (
      SELECT state, result FROM factory.operation
      WHERE kind='delivery.pull_request' AND scope_type='change' AND scope_id=change.id::text
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) pr ON true
    LEFT JOIN LATERAL (
      SELECT * FROM factory.verification WHERE change_id = change.id
        AND commit_sha = (SELECT commit_sha FROM factory.change_commit_operation
          WHERE change_id = change.id AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1)
      ORDER BY created_at DESC LIMIT 1
    ) verification ON true
    LEFT JOIN factory.runtime_attempt verification_runtime ON verification_runtime.id=verification.runtime_attempt_id
    LEFT JOIN factory.runtime_attempt failed_verification ON failed_verification.id=verification.runtime_attempt_id
      AND verification.state IN ('pending','runner-starting','running')
      AND (failed_verification.state IN ('failed','cleanup-failed')
        OR (failed_verification.state='stopped' AND failed_verification.failure IS NOT NULL))
    LEFT JOIN LATERAL (
      SELECT * FROM factory.candidate_review WHERE verification_id=verification.id ORDER BY ordinal DESC LIMIT 1
    ) review ON true
    LEFT JOIN factory.agent_turn review_turn ON review_turn.id=review.turn_id
    LEFT JOIN LATERAL (
      SELECT id, state, payload, result, created_at FROM factory.operation
      WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=change.id::text
        AND payload->>'commitSha'=verification.commit_sha
      ORDER BY (state<>'failed') DESC, created_at DESC, id DESC LIMIT 1
    ) merge ON true
    LEFT JOIN LATERAL (
      SELECT * FROM factory.delivery_approval WHERE verification_id=verification.id
        AND ((merge.payload->>'approvalId') IS NULL OR id=(merge.payload->>'approvalId')::uuid)
      ORDER BY approved_at DESC,id DESC LIMIT 1
    ) approval ON true
    LEFT JOIN factory.current_promotion promotion ON promotion.change_id = change.id
    LEFT JOIN factory.runtime_attempt replacement
      ON replacement.id = promotion.replacement_runtime_attempt_id
    WHERE change.id = ${changeID}
  `;
  return rows[0] ?? null;
}
