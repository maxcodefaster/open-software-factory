import {
  type AnyColumn,
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agentTurn,
  candidateReview,
  change,
  changeAgentSession,
  changeCommitOperation,
  changeWriter,
  deliveryApproval,
  requirementApproval,
  reviewFeedback,
  verification,
} from "#db/schema";
import type { AttentionCapability } from "#ticket-domain/attention";
import {
  type AttentionSource,
  type InboxQueryContext,
  type InboxTransactionDB,
  latestRequirementRevisionId,
} from "./attention-types";

type AgentTurnState = typeof agentTurn.$inferSelect.state;

function currentCommitForChange(db: InboxTransactionDB) {
  return db
    .select({ commitSha: changeCommitOperation.commitSha })
    .from(changeCommitOperation)
    .where(
      and(
        eq(changeCommitOperation.changeId, change.id),
        eq(changeCommitOperation.state, "succeeded"),
      ),
    )
    .orderBy(desc(changeCommitOperation.sequence))
    .limit(1);
}

function latestReviewOrdinal(db: InboxTransactionDB, verificationIdCol: AnyColumn) {
  const newestReview = alias(candidateReview, "newest_review");
  return db
    .select({ ordinal: max(newestReview.ordinal) })
    .from(newestReview)
    .where(eq(newestReview.verificationId, verificationIdCol));
}

function noActiveChangeTurn(db: InboxTransactionDB, states: AgentTurnState[]) {
  return notExists(
    db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(and(eq(agentTurn.changeId, change.id), inArray(agentTurn.state, states))),
  );
}

export async function collectDeliverySources(
  context: InboxQueryContext,
): Promise<AttentionSource[]> {
  const { db, projectIDs } = context;
  const sources: AttentionSource[] = [];

  // Exact current verification/review, settled writer and no open Threads.
  // The destination command still rechecks its complete immutable-candidate gate.
  const delivery = await db
    .select({
      id: sql<string>`'delivery:'||${candidateReview.id}::text`,
      eventId: candidateReview.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Review and approve Delivery'`,
      preview: sql<string>`coalesce(${candidateReview.result}->>'summary','Verification and independent review passed. Inspect the exact candidate before Delivery.')`,
      createdAt: sql<Date | string>`${candidateReview.completedAt}`,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'develop'`,
    })
    .from(change)
    .innerJoin(
      changeAgentSession,
      and(eq(changeAgentSession.changeId, change.id), eq(changeAgentSession.state, "committed")),
    )
    .innerJoin(
      verification,
      and(eq(verification.changeId, change.id), eq(verification.state, "succeeded")),
    )
    .innerJoin(
      candidateReview,
      and(eq(candidateReview.verificationId, verification.id), eq(candidateReview.state, "passed")),
    )
    .innerJoin(requirementApproval, eq(requirementApproval.id, change.requirementApprovalId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(change.state, "active"),
        isNull(change.cancelRequestedAt),
        eq(changeAgentSession.stopPending, false),
        eq(verification.commitSha, currentCommitForChange(db)),
        eq(candidateReview.ordinal, latestReviewOrdinal(db, verification.id)),
        eq(
          requirementApproval.requirementRevisionId,
          latestRequirementRevisionId(db, change.ticketId),
        ),
        notExists(
          db
            .select({ id: deliveryApproval.id })
            .from(deliveryApproval)
            .where(eq(deliveryApproval.verificationId, verification.id)),
        ),
        notExists(
          db
            .select({ id: reviewFeedback.id })
            .from(reviewFeedback)
            .where(
              and(
                eq(reviewFeedback.changeId, change.id),
                eq(reviewFeedback.kind, "thread"),
                ne(reviewFeedback.state, "resolved"),
              ),
            ),
        ),
        noActiveChangeTurn(db, ["pending", "dispatching", "running", "uncertain"]),
        notExists(
          db
            .select({ id: changeWriter.changeId })
            .from(changeWriter)
            .where(
              and(
                eq(changeWriter.changeId, change.id),
                notInArray(changeWriter.state, ["agent", "unassigned"]),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: changeCommitOperation.id })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, change.id),
                notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
              ),
            ),
        ),
      ),
    );
  sources.push(...delivery);

  const reviewFailures = await db
    .select({
      id: sql<string>`'review:'||${candidateReview.id}::text`,
      eventId: candidateReview.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Independent review needs attention'`,
      preview: sql<string>`coalesce(${candidateReview.result}->>'summary','Independent review is incomplete. Inspect its evidence before retrying.')`,
      createdAt: sql<
        Date | string
      >`coalesce(${candidateReview.completedAt},${candidateReview.createdAt})`,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(candidateReview)
    .innerJoin(change, eq(change.id, candidateReview.changeId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(change.state, "active"),
        eq(candidateReview.state, "incomplete"),
        eq(candidateReview.ordinal, latestReviewOrdinal(db, candidateReview.verificationId)),
        eq(candidateReview.commitSha, currentCommitForChange(db)),
        noActiveChangeTurn(db, ["pending", "dispatching", "running"]),
      ),
    );
  sources.push(...reviewFailures);

  const newerVerification = alias(verification, "newer_verification");
  const checks = await db
    .select({
      id: sql<string>`'verification:'||${verification.id}::text`,
      eventId: verification.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Verification needs attention'`,
      preview: sql<string>`coalesce(${verification.summary},'Verification failed after the correction attempt. Inspect the checks before continuing.')`,
      createdAt: verification.updatedAt,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'develop'`,
    })
    .from(verification)
    .innerJoin(change, eq(change.id, verification.changeId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(change.state, "active"),
        eq(verification.state, "failed"),
        isNotNull(verification.repairPromptedAt),
        eq(verification.commitSha, currentCommitForChange(db)),
        notExists(
          db
            .select({ id: newerVerification.id })
            .from(newerVerification)
            .where(
              and(
                eq(newerVerification.changeId, change.id),
                sql<boolean>`(${newerVerification.createdAt},${newerVerification.id})>(${verification.createdAt},${verification.id})`,
              ),
            ),
        ),
        noActiveChangeTurn(db, ["pending", "dispatching", "running"]),
      ),
    );
  sources.push(...checks);

  return sources;
}
