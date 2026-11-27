import { and, eq, gt, notExists, sql as typedSQL } from "drizzle-orm";
import type { Sql, TransactionSql } from "postgres";
import { learningReviewWindowMs } from "#conversation-domain/learning";
import { drizzleTransaction } from "#db/client";
import { auditEvent, learningReview } from "#db/schema";

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
  const projectId = typedSQL<string>`(${auditEvent.payload}->'input'->>'projectId')::uuid`;
  const ownerId = typedSQL<
    string | null
  >`case when ${auditEvent.payload}->'input'->>'scope'='personal' then ${auditEvent.actorId} end`;
  const developerOnly = typedSQL<boolean>`(${auditEvent.payload}->'input'->>'developerOnly')::boolean`;
  return db
    .select({
      id: auditEvent.id,
      actorId: auditEvent.actorId,
      projectId,
      ownerId,
      developerOnly,
      cases: typedSQL<number>`(${auditEvent.payload}->'input'->>'cases')::int`,
      requestedAt: auditEvent.createdAt,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.kind, "learning.command"),
        eq(auditEvent.scopeType, "learning"),
        scope ? eq(auditEvent.scopeId, scope.projectId) : undefined,
        eq(typedSQL<string>`${auditEvent.payload}->'input'->>'kind'`, "review-now"),
        gt(
          auditEvent.createdAt,
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
                gt(learningReview.createdAt, auditEvent.createdAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(auditEvent.createdAt)
    .limit(8);
}
