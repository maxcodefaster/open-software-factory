import { and, count, eq, exists, isNull, ne, or, sql as typedSQL } from "drizzle-orm";
import {
  learningPolicyCommand,
  learningReviewNowCommand,
  legacyWikiCallPattern,
} from "#conversation-domain/learning";
import { drizzleTransaction } from "#db/client";
import {
  administrator,
  learningCase as caseRecord,
  learningReview,
  operation,
  projectMembership,
} from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import {
  advisoryLock,
  type LearningDatabase,
  ownerPredicate,
  policyIdempotencyKey,
  policyScopeKey,
  recordLearningCommand,
  replayLearningCommand,
} from "./command-ledger";
import { pendingReviewRequests } from "./requests";

export async function setLearningPolicy(database: LearningDatabase, userId: string, raw: unknown) {
  const input = learningPolicyCommand.parse(raw);
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await projectAuthorityIn(sql, userId, input.projectId, input.scope === "project");
    const existing = await replayLearningCommand(sql, input.commandId, userId, input);
    if (existing) return existing.result;
    const ownerId = input.scope === "personal" ? userId : null;
    const key = policyScopeKey(input.projectId, ownerId);
    await advisoryLock(db, `learning-policy:${key}`);
    const policyKey = policyIdempotencyKey(input.projectId, ownerId);
    const [current] = await db
      .select({ version: typedSQL<number>`(${operation.payload}->>'version')::int` })
      .from(operation)
      .where(and(eq(operation.kind, "learning.policy"), eq(operation.idempotencyKey, policyKey)));
    if ((current?.version ?? 0) !== input.expectedVersion)
      throw new CommandError("conflict", "Learning settings changed. Reload before saving.");
    const values = {
      scopeKey: key,
      projectId: input.projectId,
      ownerId,
      enabled: input.enabled,
      automaticSkills: input.automaticSkills,
      version: input.expectedVersion + 1,
      updatedBy: userId,
    };
    const state = input.enabled ? "enabled" : "disabled";
    await db
      .insert(operation)
      .values({
        id: crypto.randomUUID(),
        kind: "learning.policy",
        scopeType: "project",
        scopeId: input.projectId,
        idempotencyKey: policyKey,
        activeKey: null,
        state,
        createdBy: userId,
        payload: values,
      })
      .onConflictDoUpdate({
        target: operation.idempotencyKey,
        set: {
          state,
          createdBy: userId,
          payload: values,
          updatedAt: typedSQL`now()`,
        },
      });
    const result = { version: input.expectedVersion + 1 };
    await recordLearningCommand(db, input.commandId, input.projectId, userId, input, result);
    return result;
  });
}

export async function requestReviewNow(database: LearningDatabase, userId: string, raw: unknown) {
  const input = learningReviewNowCommand.parse(raw);
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const ownerId = input.scope === "personal" ? userId : null;
    const group = { projectId: input.projectId, ownerId, developerOnly: input.developerOnly };
    // Spending Planning-model calls on shared work needs the same current Project manager
    // as pausing it. Private work needs only its owner, plus Developer access when required.
    await learningAuthorityIn(sql, userId, {
      ...group,
      managerOnly: input.scope === "project",
    });
    const existing = await replayLearningCommand(sql, input.commandId, userId, input);
    if (existing) return existing.result;
    await advisoryLock(
      db,
      `learning:${input.projectId}:${ownerId ?? "project"}:${input.developerOnly}`,
    );
    if (!(await learningEnabledIn(sql, input.projectId, ownerId)))
      throw new CommandError("forbidden", "Learning is paused. Resume it to review now.");
    const [busy] = await db
      .select({ id: learningReview.id })
      .from(learningReview)
      .where(
        and(
          eq(learningReview.projectId, input.projectId),
          ownerPredicate(learningReview.ownerId, ownerId),
          eq(learningReview.developerOnly, input.developerOnly),
          eq(learningReview.state, "running"),
        ),
      );
    if (busy) throw new CommandError("conflict", "A review of this work is already running.");
    if (
      (await pendingReviewRequests(sql, { projectId: input.projectId, ownerId })).some(
        (item) => item.developerOnly === input.developerOnly,
      )
    )
      throw new CommandError("conflict", "A review of this work is already requested.");
    const limited = db
      .select({ id: caseRecord.id })
      .from(caseRecord)
      .where(
        and(
          eq(caseRecord.projectId, input.projectId),
          ownerPredicate(caseRecord.ownerId, ownerId),
          eq(caseRecord.developerOnly, input.developerOnly),
          eq(caseRecord.selected, true),
          isNull(caseRecord.batchId),
          typedSQL`NOT(${caseRecord.activity}='wiki' AND ${caseRecord.id} ~ ${legacyWikiCallPattern})`,
          or(
            ne(caseRecord.activity, "setup"),
            exists(
              db
                .select({ userId: projectMembership.userId })
                .from(projectMembership)
                .where(
                  and(
                    eq(projectMembership.projectId, caseRecord.projectId),
                    eq(projectMembership.userId, caseRecord.reviewerId),
                    eq(projectMembership.manageProject, true),
                  ),
                ),
            ),
            exists(
              db
                .select({ userId: administrator.userId })
                .from(administrator)
                .where(eq(administrator.userId, caseRecord.reviewerId)),
            ),
          ),
        ),
      )
      .limit(input.cases)
      .as("limited");
    const [eligible] = await db.select({ count: count() }).from(limited);
    if (!eligible?.count)
      throw new CommandError("conflict", "No selected case is waiting for a review.");
    const result = { cases: Math.min(eligible.count, input.cases) };
    await recordLearningCommand(db, input.commandId, input.projectId, userId, input, result);
    return result;
  });
}
