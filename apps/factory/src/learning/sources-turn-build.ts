import { and, asc, desc, eq, sql as typedSQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { verificationReviewReasons } from "#conversation-domain/verification";
import {
  auditEvent,
  changeCommitOperation,
  requirementRevision,
  reviewFeedback,
  verification,
} from "#db/schema";
import {
  type EvidenceCollector,
  type LearningDrizzle,
  type SourceOperation,
  uuidPattern,
} from "./sources-types";

/** Returns false when exact-commit Verification is still pending within its grace window. */
export async function collectTurnBuildEvidence(
  db: LearningDrizzle,
  operation: SourceOperation,
  turnId: string,
  authority: Record<string, unknown>,
  collector: EvidenceCollector,
): Promise<boolean> {
  const [commit] = await db
    .select({
      id: changeCommitOperation.id,
      sha: changeCommitOperation.commitSha,
      parent: changeCommitOperation.expectedParentSha,
      state: changeCommitOperation.state,
      changeId: changeCommitOperation.changeId,
    })
    .from(changeCommitOperation)
    .where(eq(changeCommitOperation.id, turnId));
  if (commit?.sha) {
    const checks = await db
      .select({
        id: verification.id,
        state: verification.state,
        summary: verification.summary,
        diagnosis: verification.diagnosis,
        completedAt: verification.completedAt,
      })
      .from(verification)
      .where(
        and(eq(verification.changeId, commit.changeId), eq(verification.commitSha, commit.sha)),
      )
      .orderBy(desc(verification.createdAt))
      .limit(1);
    if (
      operation.outcome === "completed" &&
      !checks[0]?.completedAt &&
      Date.now() - new Date(operation.settledAt).getTime() < 24 * 60 * 60_000
    )
      return false;
    collector.add(`commit:${commit.id}`, "artifact", commit, 1_000);
    for (const check of checks)
      collector.add(
        `verification:${check.id}`,
        "artifact",
        { commit: commit.sha, ...check },
        12_000,
      );
    const diagnosis = checks[0]?.diagnosis;
    collector.addReviewReasons(
      ...(checks[0] && checks[0].state !== "succeeded"
        ? ["verification-not-successful"]
        : verificationReviewReasons(
            diagnosis && typeof diagnosis === "object"
              ? (diagnosis as Record<string, unknown>)["receipt"]
              : null,
            commit.sha,
          )),
    );
  } else {
    collector.addReviewReasons("missing-verification-evidence");
  }

  const requirementId = authority["requirementRevisionId"];
  if (typeof requirementId === "string" && uuidPattern.test(requirementId)) {
    const [requirement] = await db
      .select({ content: requirementRevision.canonicalContent })
      .from(requirementRevision)
      .where(eq(requirementRevision.id, requirementId));
    if (requirement)
      collector.add(`requirements:${requirementId}`, "task", requirement.content, 3_000);
  }

  const feedbackMessage = alias(auditEvent, "feedback_message");
  const feedback = await db
    .select({
      id: feedbackMessage.id,
      body: typedSQL<string>`${feedbackMessage.payload}->>'body'`,
      commit: reviewFeedback.commitSha,
    })
    .from(auditEvent)
    .innerJoin(
      reviewFeedback,
      eq(reviewFeedback.id, typedSQL<string>`(${auditEvent.payload}->>'feedbackId')::uuid`),
    )
    .innerJoin(
      feedbackMessage,
      and(
        eq(feedbackMessage.kind, "review.feedback_message"),
        eq(feedbackMessage.scopeType, "review_feedback"),
        eq(feedbackMessage.scopeId, typedSQL<string>`${reviewFeedback.id}::text`),
      ),
    )
    .where(eq(auditEvent.dedupeKey, `review.feedback_turn:${turnId}`))
    .orderBy(asc(feedbackMessage.createdAt))
    .limit(3);
  for (const item of feedback) collector.add(`feedback:${item.id}`, "feedback", item, 2_000);
  return true;
}
