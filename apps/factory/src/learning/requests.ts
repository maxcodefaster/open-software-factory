import { and, eq, gt, notExists, sql as typedSQL } from "drizzle-orm";
import type { Sql, TransactionSql } from "postgres";
import { learningReviewWindowMs } from "../../../../packages/conversation-domain/src/learning";
import { drizzleTransaction } from "../../../../packages/db/src/client";
import { learningCommand, learningReview } from "../../../../packages/db/src/schema";

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
  const db = drizzleTransaction(sql);
  const projectId = typedSQL<string>`(${learningCommand.input}->>'projectId')::uuid`;
  const ownerId = typedSQL<
    string | null
  >`case when ${learningCommand.input}->>'scope'='personal' then ${learningCommand.actorId} end`;
  const developerOnly = typedSQL<boolean>`(${learningCommand.input}->>'developerOnly')::boolean`;
  return db
    .select({
      id: learningCommand.id,
      actorId: learningCommand.actorId,
      projectId,
      ownerId,
      developerOnly,
      cases: typedSQL<number>`(${learningCommand.input}->>'cases')::int`,
      requestedAt: learningCommand.createdAt,
    })
    .from(learningCommand)
    .where(
      and(
        eq(typedSQL<string>`${learningCommand.input}->>'kind'`, "review-now"),
        gt(
          learningCommand.createdAt,
          typedSQL`now()-make_interval(secs=>${learningReviewWindowMs / 1000})`,
        ),
        scope ? eq(projectId, scope.projectId) : undefined,
        scope ? typedSQL`${ownerId} is not distinct from ${scope.ownerId}::uuid` : undefined,
        notExists(
          db
            .select({ id: learningReview.id })
            .from(learningReview)
            .where(
              and(
                eq(learningReview.kind, "work"),
                eq(learningReview.projectId, projectId),
                typedSQL`${learningReview.ownerId} is not distinct from ${ownerId}`,
                eq(learningReview.developerOnly, developerOnly),
                gt(learningReview.createdAt, learningCommand.createdAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(learningCommand.createdAt)
    .limit(8);
}
