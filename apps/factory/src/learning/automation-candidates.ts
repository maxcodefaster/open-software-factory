import {
  and,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql as typedSQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { LearningEdit } from "#conversation-domain/learning";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  type LearningTrialStepRecord,
  learningReview,
  operation,
  learningProposal as proposalTable,
} from "#db/schema";
import { CommandError } from "../command-error";
import { createUsageJournal } from "../usage/journal-api";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import {
  type Candidate,
  currentTarget,
  type LearningDatabase,
  type LearningTargets,
  type RawCandidateRow,
} from "./automation-types";

export async function grantIn(sql: DatabaseTransaction, row: Candidate) {
  await learningAuthorityIn(sql, row.actorId, row);
  if (!(await learningEnabledIn(sql, row.projectId, row.ownerId)))
    throw new CommandError("forbidden", "Learning is paused");
  const policyKey = `learning.policy:${row.projectId}:${row.ownerId ?? "project"}`;
  const [policy] = await drizzleTransaction(sql)
    .select({ id: operation.id })
    .from(operation)
    .where(
      and(
        eq(operation.kind, "learning.policy"),
        eq(operation.scopeType, "project"),
        eq(operation.scopeId, row.projectId),
        eq(operation.idempotencyKey, policyKey),
        eq(typedSQL<boolean>`(${operation.payload}->>'automaticSkills')::boolean`, true),
        eq(typedSQL<number>`(${operation.payload}->>'version')::int`, row.policyVersion),
        eq(typedSQL<string>`${operation.payload}->>'updatedBy'`, row.actorId),
      ),
    );
  if (!policy) throw new CommandError("forbidden", "Automatic Skill permission changed");
}

export async function loadedIn(
  sql: DatabaseTransaction,
  targets: LearningTargets,
  row: Candidate,
  edit: LearningEdit,
  choiceVersion?: number,
) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
  const db = drizzleTransaction(sql);
  const target = currentTarget(row, edit);
  const loaded = await targets.current(sql, target, row.actorId, row.projectId);
  const content = loaded.content;
  if (
    target.kind !== "skill" ||
    target.field !== "instructions" ||
    loaded.scope.scope !== (row.ownerId ? "personal" : "project") ||
    !content ||
    content.roles.length !== 1 ||
    content.roles[0] !== "planning" ||
    content.references.length ||
    content.files?.length ||
    content.sourceSkill ||
    content.origin ||
    content.manualOnly ||
    loaded.choices.length !== 1 ||
    loaded.choices.some((choice) => choice.role !== "planning" || choice.state !== "enable")
  )
    throw new CommandError(
      "conflict",
      "Only enabled, owning-scope, plain Planning Skill instructions qualify",
    );
  if (choiceVersion !== undefined && loaded.choices[0]?.version !== choiceVersion)
    throw new CommandError("conflict", "Skill activation changed during comparison");
  if (row.phase === "recover") {
    const [application] = await db
      .select({ id: proposalTable.id })
      .from(proposalTable)
      .where(
        and(
          eq(proposalTable.id, row.proposalId),
          isNotNull(proposalTable.application),
          eq(
            typedSQL<string>`${proposalTable.application}->>'id'`,
            typedSQL`${row.applicationId}::text`,
          ),
          eq(typedSQL<string>`${proposalTable.application}->>'state'`, "applied"),
          typedSQL<boolean>`(${proposalTable.application}->>'comparisonId') IS NOT NULL`,
          eq(
            typedSQL<string>`${proposalTable.application}->>'appliedRevisionId'`,
            typedSQL`${row.appliedRevisionId}::text`,
          ),
        ),
      );
    if (!application) throw new CommandError("conflict", "Applied guidance changed");
    if (
      row.activation.length !== 1 ||
      row.activation[0]?.afterVersion !== loaded.choices[0]?.version
    )
      throw new CommandError("conflict", "A newer Skill choice blocks automatic recovery");
  } else {
    const [proposal] = await db
      .select({ id: proposalTable.id })
      .from(proposalTable)
      .where(and(eq(proposalTable.id, row.proposalId), eq(proposalTable.state, "proposed")));
    if (!proposal) throw new CommandError("conflict", "The proposal already has a decision");
    const [reverted] = await db
      .select({ id: proposalTable.id })
      .from(proposalTable)
      .where(
        and(
          isNotNull(proposalTable.application),
          eq(typedSQL<string>`${proposalTable.application}->>'state'`, "reverted"),
          eq(typedSQL<string>`${proposalTable.application}->'target'->>'id'`, target.id),
          eq(typedSQL<string>`${proposalTable.content}->'edit'->>'after'`, edit.after),
        ),
      )
      .limit(1);
    if (reverted)
      throw new CommandError("conflict", "A reverted edit cannot be automatically repeated");
  }
  return loaded;
}

export async function expireStaleTrials(database: LearningDatabase) {
  const expired = await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const rows = await db
      .select({ id: operation.id, payload: operation.payload })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "learning.trial"),
          eq(operation.state, "running"),
          lt(operation.leaseExpiresAt, typedSQL`now()`),
        ),
      )
      .for("update");
    const completedAt = new Date().toISOString();
    const abandoned: Array<{ id: string; stage: number }> = [];
    for (const item of rows) {
      const steps = (item.payload["steps"] ?? []) as LearningTrialStepRecord[];
      for (const step of steps)
        if (step.state === "running") abandoned.push({ id: item.id, stage: step.stage });
      const nextSteps = steps.map((step) =>
        step.state === "running" ? { ...step, state: "uncertain", completedAt } : step,
      );
      const reason = "Comparison ownership expired. No paid step will be replayed.";
      await db
        .update(operation)
        .set({
          state: "uncertain",
          error: reason,
          payload: typedSQL`${operation.payload} || jsonb_build_object('steps', ${JSON.stringify(nextSteps)}::jsonb, 'reason', ${reason}::text)`,
          completedAt: typedSQL`now()`,
          updatedAt: typedSQL`now()`,
        })
        .where(
          and(
            eq(operation.id, item.id),
            eq(operation.kind, "learning.trial"),
            eq(operation.state, "running"),
          ),
        );
    }
    return abandoned;
  });
  for (const item of expired)
    await createUsageJournal(database).abandon(`learning-trial:${item.id}:${item.stage}`);
}

export async function queryCandidateRows(
  database: LearningDatabase,
  cursor: string,
): Promise<RawCandidateRow[]> {
  const phase = typedSQL<
    RawCandidateRow["phase"]
  >`case when ${proposalTable.application} is null then 'adopt' else 'recover' end`;
  const policyOp = alias(operation, "policy_op");
  const trialOp = alias(operation, "trial_op");
  return database.db
    .select({
      proposalId: proposalTable.id,
      reviewId: proposalTable.reviewId,
      content: proposalTable.content,
      projectId: learningReview.projectId,
      ownerId: learningReview.ownerId,
      developerOnly: learningReview.developerOnly,
      policyVersion: typedSQL<number>`(${policyOp.payload}->>'version')::int`,
      actorId: typedSQL<string>`${policyOp.payload}->>'updatedBy'`,
      phase,
      applicationId: typedSQL<string | null>`${proposalTable.application}->>'id'`,
      appliedRevisionId: typedSQL<
        string | null
      >`${proposalTable.application}->>'appliedRevisionId'`,
      appliedVersion: typedSQL<
        number | null
      >`(${proposalTable.application}->>'appliedVersion')::int`,
      activation: typedSQL<unknown>`${proposalTable.application}->'activation'`,
      proposalAfterGrant: typedSQL<boolean>`${gte(learningReview.createdAt, policyOp.updatedAt)}`,
    })
    .from(proposalTable)
    .innerJoin(learningReview, eq(learningReview.id, proposalTable.reviewId))
    .innerJoin(
      policyOp,
      and(
        eq(policyOp.kind, "learning.policy"),
        eq(policyOp.scopeType, "project"),
        eq(
          policyOp.idempotencyKey,
          typedSQL<string>`'learning.policy:'||${learningReview.projectId}::text||':'||coalesce(${learningReview.ownerId}::text,'project')`,
        ),
      ),
    )
    .where(
      and(
        eq(policyOp.state, "enabled"),
        eq(typedSQL<boolean>`(${policyOp.payload}->>'automaticSkills')::boolean`, true),
        eq(learningReview.kind, "work"),
        eq(learningReview.state, "completed"),
        typedSQL<boolean>`not(${learningReview.input} @> '[{"activity":"setup"}]'::jsonb)`,
        eq(typedSQL<string>`${proposalTable.content}->'edit'->'target'->>'kind'`, "skill"),
        eq(typedSQL<string>`${proposalTable.content}->'edit'->'target'->>'field'`, "instructions"),
        or(
          and(eq(proposalTable.state, "proposed"), isNull(proposalTable.application)),
          and(
            isNotNull(proposalTable.application),
            eq(typedSQL<string>`${proposalTable.application}->>'state'`, "applied"),
            typedSQL<boolean>`(${proposalTable.application}->>'comparisonId') IS NOT NULL`,
          ),
        ),
        notExists(
          database.db
            .select({ id: trialOp.id })
            .from(trialOp)
            .where(
              and(
                eq(trialOp.kind, "learning.trial"),
                eq(trialOp.scopeType, "learning_proposal"),
                eq(trialOp.scopeId, typedSQL<string>`${proposalTable.id}::text`),
                eq(
                  trialOp.idempotencyKey,
                  typedSQL<string>`'learning.trial:'||${proposalTable.id}::text||':'||(${phase})`,
                ),
              ),
            ),
        ),
        gt(typedSQL<string>`${proposalTable.id}::text`, cursor),
      ),
    )
    .orderBy(proposalTable.id)
    .limit(24);
}
