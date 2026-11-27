import { and, asc, desc, eq, inArray, isNotNull, ne, sql as typedSQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { learningProposal, learningTarget, learningView } from "#conversation-domain/learning";
import { drizzleTransaction } from "#db/client";
import {
  learningCase as caseRecord,
  learningReview,
  operation,
  learningProposal as proposalRecord,
} from "#db/schema";
import { CommandError } from "../command-error";
import {
  caseVisibility,
  type LearningDatabase,
  type LearningTargets,
  policyIdempotencyKey,
  resolveLearningRights,
  reviewVisibility,
  tryAuthorizeTarget,
} from "./command-ledger";
import { loadLearningMetrics } from "./metrics-query";
import { learningEditDigest } from "./targets";

const reviewFields = {
  id: learningReview.id,
  kind: learningReview.kind,
  state: learningReview.state,
  modelId: learningReview.modelId,
  rubric: learningReview.rubric,
  calibrated: learningReview.calibrated,
  reason: learningReview.reason,
  createdAt: learningReview.createdAt,
  completedAt: learningReview.completedAt,
  result: learningReview.result,
  cases: learningReview.input,
};

export async function loadLearningView(
  database: LearningDatabase,
  targets: LearningTargets,
  userId: string,
  projectId: string | null,
  personal = false,
) {
  const db = drizzleTransaction(database.client);
  const permitted = await resolveLearningRights(database, userId, projectId, personal);
  const ownerId = personal ? userId : null;
  const reviewVisible = reviewVisibility(projectId, ownerId, permitted);
  const caseVisible = caseVisibility(projectId, ownerId, permitted);
  const policyKeys = projectId
    ? ownerId
      ? [policyIdempotencyKey(projectId, null), policyIdempotencyKey(projectId, ownerId)]
      : [policyIdempotencyKey(projectId, null)]
    : [];
  const policies = projectId
    ? await db
        .select({
          ownerId: typedSQL<string | null>`${operation.payload}->>'ownerId'`,
          enabled: typedSQL<boolean>`(${operation.payload}->>'enabled')::boolean`,
          automaticSkills: typedSQL<boolean>`(${operation.payload}->>'automaticSkills')::boolean`,
          version: typedSQL<number>`(${operation.payload}->>'version')::int`,
        })
        .from(operation)
        .where(
          and(
            eq(operation.kind, "learning.policy"),
            eq(operation.scopeType, "project"),
            eq(operation.scopeId, projectId),
            inArray(operation.idempotencyKey, policyKeys),
          ),
        )
    : [];
  const policy = policies.find((item) => item.ownerId === ownerId);
  const parentEnabled = policies.find((item) => item.ownerId === null)?.enabled ?? true;
  const metrics = await loadLearningMetrics(database, {
    userId,
    projectId,
    ownerId,
    permitted,
    caseVisible,
  });
  let reviews: Array<Record<string, unknown>> = projectId
    ? await db
        .select(reviewFields)
        .from(learningReview)
        .where(reviewVisible)
        .orderBy(desc(learningReview.createdAt))
        .limit(12)
    : [];
  const proposals = projectId
    ? await db
        .select({
          id: proposalRecord.id,
          reviewId: proposalRecord.reviewId,
          content: proposalRecord.content,
          state: proposalRecord.state,
          ticketId: proposalRecord.ticketId,
          private: isNotNull(learningReview.ownerId),
        })
        .from(proposalRecord)
        .innerJoin(learningReview, eq(learningReview.id, proposalRecord.reviewId))
        .where(reviewVisible)
        .orderBy(desc(learningReview.createdAt), asc(proposalRecord.ordinal))
        .limit(24)
    : [];
  // Pending proposals can outlive the recent-history window. Always return
  // their exact supporting reviews, under the same visibility predicate.
  const missing = [...new Set(proposals.map((item) => String(item["reviewId"])))].filter(
    (id) => !reviews.some((review) => review["id"] === id),
  );
  if (projectId && missing.length) {
    const sources = await db
      .select(reviewFields)
      .from(learningReview)
      .where(and(inArray(learningReview.id, missing), reviewVisible))
      .orderBy(desc(learningReview.createdAt));
    reviews = [...reviews, ...sources];
  }
  const later = alias(learningReview, "later");
  const recent = db
    .select({
      id: caseRecord.id,
      snapshot: caseRecord.snapshot,
      settledAt: caseRecord.settledAt,
      reviewId: typedSQL<string | null>`${later.id}`.as("review_id"),
      verdict: typedSQL<unknown>`verdict.value`.as("verdict"),
      sampled: typedSQL<number>`count(*) OVER()`.as("sampled"),
      reviewed: typedSQL<number>`count(verdict.value) OVER()`.as("reviewed"),
      problems:
        typedSQL<number>`count(*) FILTER(WHERE verdict.value->>'fulfillment'='problem') OVER()`.as(
          "problems",
        ),
    })
    .from(caseRecord)
    .leftJoin(
      later,
      and(eq(later.id, caseRecord.batchId), eq(later.state, "completed"), eq(later.kind, "work")),
    )
    .leftJoin(
      typedSQL`LATERAL jsonb_array_elements(${later.result}->'cases') verdict(value)`,
      typedSQL`verdict.value->>'caseId'=${caseRecord.id}`,
    )
    .where(
      and(
        eq(caseRecord.projectId, learningReview.projectId),
        typedSQL`${caseRecord.ownerId} IS NOT DISTINCT FROM ${learningReview.ownerId}`,
        eq(caseRecord.developerOnly, learningReview.developerOnly),
        eq(caseRecord.selected, true),
        typedSQL`${caseRecord.snapshot}->'targets' @> jsonb_build_array(jsonb_build_object(
        'target',jsonb_build_object('kind',${proposalRecord.application}->'target'->>'kind',
          'id',${proposalRecord.application}->'target'->>'id','revisionId',${proposalRecord.application}->>'appliedRevisionId')))`,
        permitted.manager ? undefined : ne(caseRecord.activity, "setup"),
      ),
    )
    .orderBy(desc(caseRecord.settledAt), asc(caseRecord.id))
    .limit(3)
    .as("recent");
  const subsequent = db
    .select({
      sampled: typedSQL<number>`max(${recent.sampled})::int`.as("sampled"),
      reviewed: typedSQL<number>`max(${recent.reviewed})::int`.as("reviewed"),
      problems: typedSQL<number>`max(${recent.problems})::int`.as("problems"),
      cases: typedSQL<unknown[]>`jsonb_agg(jsonb_build_object(
      'source',${recent.snapshot},'reviewId',${recent.reviewId},'verdict',${recent.verdict})
      ORDER BY ${recent.settledAt} DESC,${recent.id})`.as("cases"),
    })
    .from(recent)
    .as("subsequent");
  const applications = projectId
    ? await db
        .select({
          id: typedSQL<string>`${proposalRecord.application}->>'id'`,
          proposalId: proposalRecord.id,
          target: typedSQL<unknown>`${proposalRecord.application}->'target'`,
          title: typedSQL<string>`${proposalRecord.content}->>'title'`,
          edit: typedSQL<unknown>`${proposalRecord.content}->'edit'`,
          appliedRevisionId: typedSQL<string>`${proposalRecord.application}->>'appliedRevisionId'`,
          appliedVersion: typedSQL<number>`(${proposalRecord.application}->>'appliedVersion')::int`,
          state: typedSQL<"applied" | "reverted">`${proposalRecord.application}->>'state'`,
          createdAt: typedSQL<string>`${proposalRecord.application}->>'createdAt'`,
          revertedAt: typedSQL<string | null>`${proposalRecord.application}->>'revertedAt'`,
          automatic: typedSQL<boolean>`(${proposalRecord.application}->>'comparisonId') IS NOT NULL`,
          automaticRecovery: typedSQL<boolean>`(${proposalRecord.application}->>'revertedComparisonId') IS NOT NULL`,
          subsequent: typedSQL<unknown>`jsonb_build_object(
        'sampled',coalesce(${subsequent.sampled},0),'reviewed',coalesce(${subsequent.reviewed},0),
        'problems',coalesce(${subsequent.problems},0),'cases',coalesce(${subsequent.cases},'[]'::jsonb))`,
        })
        .from(proposalRecord)
        .innerJoin(learningReview, eq(learningReview.id, proposalRecord.reviewId))
        .leftJoinLateral(subsequent, typedSQL`true`)
        .where(and(reviewVisible, isNotNull(proposalRecord.application)))
        .orderBy(desc(typedSQL`(${proposalRecord.application}->>'createdAt')::timestamptz`))
        .limit(24)
    : [];
  const proposalViews: Array<Record<string, unknown>> = await Promise.all(
    proposals.map(async (row) => {
      const content = learningProposal.parse(row["content"]);
      const auth =
        content.edit && projectId
          ? await tryAuthorizeTarget(database, targets, content.edit.target, userId, projectId)
          : null;
      const scope = auth?.ok ? auth.scope : null;
      return {
        ...row,
        editDigest: content.edit ? learningEditDigest(content.edit) : null,
        canApply: auth?.ok ?? false,
        applyBlockedReason: auth && !auth.ok ? auth.reason : null,
        targetScope: scope,
        targetLabel: auth?.ok ? auth.label : null,
        requiresPrivateRelease: Boolean(row["private"] && scope && scope !== "personal"),
      };
    }),
  );
  const applicationViews = await Promise.all(
    applications.map(async (row) => {
      const auth = projectId
        ? await tryAuthorizeTarget(
            database,
            targets,
            learningTarget.parse(row["target"]),
            userId,
            projectId,
          )
        : null;
      return {
        ...row,
        canRevert: Boolean(auth?.ok && row["state"] === "applied"),
        targetLabel: auth?.ok ? auth.label : null,
        targetScope: auth?.ok ? auth.scope : null,
        createdAt: new Date(row.createdAt).toISOString(),
        revertedAt: row.revertedAt ? new Date(row.revertedAt).toISOString() : null,
      };
    }),
  );
  const comparisons: Array<Record<string, unknown>> = projectId
    ? [
        ...(await db
          .select({
            id: operation.id,
            proposalId: typedSQL<string>`${operation.payload}->>'proposalId'`,
            phase: typedSQL<"adopt" | "recover">`${operation.payload}->>'phase'`,
            title: typedSQL<string>`${proposalRecord.content}->>'title'`,
            state: operation.state,
            reason: typedSQL<
              string | null
            >`coalesce(${operation.error}, ${operation.payload}->>'reason')`,
            modelId: typedSQL<string>`${operation.payload}->>'modelId'`,
            rubric: typedSQL<string>`${operation.payload}->>'rubric'`,
            createdAt: operation.createdAt,
            result: typedSQL<unknown>`coalesce(NULLIF(${operation.payload}->'result', 'null'::jsonb), ${operation.result})`,
            candidateFirst: typedSQL<boolean>`(${operation.payload}->'input'->>'candidateFirst')::boolean`,
            evidence: typedSQL<unknown>`${operation.payload}->'input'->'cases'`,
            baselineTarget: typedSQL<unknown>`${operation.payload}->'input'->'baselineTarget'`,
            before: typedSQL<string>`${operation.payload}->'input'->>'before'`,
            after: typedSQL<string>`${operation.payload}->'input'->>'after'`,
            responses: typedSQL<unknown[]>`coalesce((
              SELECT jsonb_agg(step->'result' ORDER BY (step->>'stage')::int)
              FROM jsonb_array_elements(coalesce(${operation.payload}->'steps', '[]'::jsonb)) AS step
              WHERE (step->>'stage')::int < 2 AND step->>'state' = 'completed'
            ),'[]'::jsonb)`,
          })
          .from(operation)
          .innerJoin(
            proposalRecord,
            eq(typedSQL<string>`${proposalRecord.id}::text`, operation.scopeId),
          )
          .innerJoin(learningReview, eq(learningReview.id, proposalRecord.reviewId))
          .where(
            and(
              eq(operation.kind, "learning.trial"),
              eq(operation.scopeType, "learning_proposal"),
              reviewVisible,
            ),
          )
          .orderBy(desc(operation.createdAt))
          .limit(24)),
      ].map((row) => ({
        ...row,
        createdAt: new Date(row["createdAt"] as Date).toISOString(),
      }))
    : [];
  const fresh = await resolveLearningRights(database, userId, projectId, personal);
  if ((permitted.developer && !fresh.developer) || (permitted.manager && !fresh.manager))
    throw new CommandError(
      "conflict",
      "Project permissions changed while reading Monitoring. Refresh before continuing.",
    );
  return learningView.parse({
    projectId,
    scope: personal ? "personal" : "project",
    detailScope: !projectId ? "factory" : permitted.ownUsage ? "own" : "project",
    enabled: (policy?.enabled ?? true) && parentEnabled,
    automaticSkills: policy?.automaticSkills ?? false,
    parentEnabled,
    canManage: Boolean(projectId && (personal || permitted.manager)),
    version: policy?.version ?? 0,
    ...metrics,
    reviews: reviews.map((row) => ({
      ...row,
      createdAt: new Date(row["createdAt"] as Date).toISOString(),
      completedAt: row["completedAt"] ? new Date(row["completedAt"] as Date).toISOString() : null,
    })),
    proposals: proposalViews.map((proposal) => {
      const trial = comparisons.find(
        (item) => item["proposalId"] === proposal["id"] && item["phase"] === "adopt",
      );
      return {
        ...proposal,
        comparisonState: !trial
          ? "untested"
          : trial["state"] === "running"
            ? "running"
            : trial["state"] === "completed"
              ? "not-demonstrated"
              : "unconfirmed",
      };
    }),
    applications: applicationViews,
    comparisons,
  });
}
