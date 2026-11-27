import {
  and,
  asc,
  eq,
  exists,
  gt,
  isNotNull,
  like,
  notExists,
  notInArray,
  notLike,
  or,
  sql as typedSQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  operation as operationRecord,
  learningCase as savedCase,
  usageOperation,
} from "#db/schema";
import type { LearningDrizzle, LearningSourceCursor, SourceOperation } from "./sources-types";

export async function queryDueOperations(db: LearningDrizzle, cursor: LearningSourceCursor | null) {
  const wikiGeneration = alias(operationRecord, "wiki_generation");
  const policyOperation = alias(operationRecord, "policy_op");
  const wikiID = typedSQL<string>`'wiki:'||${wikiGeneration.id}::text`;
  const due = db
    .select({
      id: usageOperation.id,
      projectId: usageOperation.projectId,
      userId: usageOperation.userId,
      purpose: usageOperation.purpose,
      outcome: usageOperation.outcome,
      settledAt: usageOperation.settledAt,
      cursorAt: typedSQL<string>`${usageOperation.settledAt}::text`.as("cursorAt"),
      wiki: typedSQL<boolean>`false`.as("wiki"),
    })
    .from(usageOperation)
    .where(
      and(
        isNotNull(usageOperation.settledAt),
        isNotNull(usageOperation.projectId),
        isNotNull(usageOperation.userId),
        notInArray(usageOperation.purpose, ["probe", "learning"]),
        notLike(usageOperation.id, "wiki:%"),
        notExists(
          db
            .select({ id: policyOperation.id })
            .from(policyOperation)
            .where(
              and(
                eq(policyOperation.kind, "learning.policy"),
                eq(policyOperation.scopeType, "project"),
                eq(
                  policyOperation.idempotencyKey,
                  typedSQL<string>`'learning.policy:'||${usageOperation.projectId}::text||':project'`,
                ),
                eq(policyOperation.state, "disabled"),
              ),
            ),
        ),
        cursor
          ? typedSQL`(${usageOperation.settledAt},${usageOperation.id}) >
      (${cursor.at}::timestamptz,${cursor.id})`
          : undefined,
        notExists(
          db
            .select({ id: savedCase.id })
            .from(savedCase)
            .where(eq(savedCase.id, usageOperation.id)),
        ),
      ),
    )
    .orderBy(asc(usageOperation.settledAt), asc(usageOperation.id))
    .limit(100)
    .unionAll(
      db
        .select({
          id: wikiID.as("id"),
          projectId: typedSQL<string | null>`(${wikiGeneration.scopeId})::uuid`.as("project_id"),
          userId: wikiGeneration.createdBy,
          purpose: typedSQL<"wiki">`'wiki'`.as("purpose"),
          outcome: typedSQL<SourceOperation["outcome"]>`'completed'`.as("outcome"),
          settledAt: wikiGeneration.completedAt,
          cursorAt: typedSQL<string>`${wikiGeneration.completedAt}::text`.as("cursorAt"),
          wiki: typedSQL<boolean>`true`.as("wiki"),
        })
        .from(wikiGeneration)
        .where(
          and(
            eq(wikiGeneration.kind, "knowledge.generation"),
            eq(wikiGeneration.scopeType, "project"),
            gt(wikiGeneration.completedAt, typedSQL`now()-interval '3 days'`),
            notExists(
              db
                .select({ id: policyOperation.id })
                .from(policyOperation)
                .where(
                  and(
                    eq(policyOperation.kind, "learning.policy"),
                    eq(policyOperation.scopeType, "project"),
                    eq(
                      policyOperation.idempotencyKey,
                      typedSQL<string>`'learning.policy:'||${wikiGeneration.scopeId}||':project'`,
                    ),
                    eq(policyOperation.state, "disabled"),
                  ),
                ),
            ),
            notExists(
              db
                .select({ id: savedCase.id })
                .from(savedCase)
                .where(or(eq(savedCase.id, wikiID), like(savedCase.id, typedSQL`${wikiID}||':%'`))),
            ),
            exists(
              db
                .select({ id: usageOperation.id })
                .from(usageOperation)
                .where(
                  and(
                    eq(usageOperation.purpose, "wiki"),
                    eq(typedSQL<string>`${usageOperation.projectId}::text`, wikiGeneration.scopeId),
                    isNotNull(usageOperation.settledAt),
                    like(usageOperation.id, typedSQL`${wikiID}||':%'`),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(wikiGeneration.completedAt), asc(wikiGeneration.id))
        .limit(20),
    )
    .as("due");
  return db.select().from(due).orderBy(asc(due.settledAt), asc(due.id));
}
