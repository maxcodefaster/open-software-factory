import { and, desc, eq, gt, gte, isNull, sql as typedSQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  applyLearningEdit,
  type LearningCase,
  LearningResultRejected,
  learningCase,
  learningProposal,
  learningResult,
} from "#conversation-domain/learning";
import {
  comparisonRubric,
  learningComparisonPlan,
  replayableCase,
} from "#conversation-domain/learning-comparison";
import { skillContentInput } from "#conversation-domain/skills";
import { drizzleTransaction } from "#db/client";
import { learningReview, operation } from "#db/schema";
import { CommandError } from "../command-error";
import { grantIn, loadedIn } from "./automation-candidates";
import {
  type AdmittedTrial,
  type AutomationDependencies,
  type Candidate,
  currentTarget,
  digest,
  type LearningDatabase,
  type LearningTargets,
} from "./automation-types";
import { relatedProposalEdit } from "./prior-proposals";

export async function admitTrial(
  database: LearningDatabase,
  targets: LearningTargets,
  dependencies: AutomationDependencies,
  row: Candidate,
): Promise<AdmittedTrial | null> {
  return database.client.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning-trial:${row.proposalId}:${row.phase}`}))`;
    const db = drizzleTransaction(sql);
    const trialKey = `learning.trial:${row.proposalId}:${row.phase}`;
    const [existing] = await db
      .select({ id: operation.id })
      .from(operation)
      .where(and(eq(operation.kind, "learning.trial"), eq(operation.idempotencyKey, trialKey)));
    if (existing) return null; // A failed or uncertain comparison is never paid again.
    await grantIn(sql, row);
    const proposal = learningProposal.parse(row.content);
    if (!proposal.edit) return null;
    const edit = proposal.edit;
    const loaded = await loadedIn(sql, targets, row, edit);
    const [busy] = await db
      .select({ id: operation.id })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "learning.trial"),
          eq(operation.state, "running"),
          eq(
            typedSQL<string>`${operation.payload}->'input'->'edit'->'target'->>'id'`,
            edit.target.id,
          ),
        ),
      );
    if (busy) return null;
    const baselineTarget = currentTarget(row, edit);
    const revisionId = baselineTarget.revisionId;
    const originalReview = alias(learningReview, "original_review");
    const originalCreatedAt = db
      .select({ createdAt: originalReview.createdAt })
      .from(originalReview)
      .where(eq(originalReview.id, row.reviewId));
    const policyKey = `learning.policy:${row.projectId}:${row.ownerId ?? "project"}`;
    const grantedAt = db
      .select({ updatedAt: operation.updatedAt })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "learning.policy"),
          eq(operation.scopeType, "project"),
          eq(operation.idempotencyKey, policyKey),
        ),
      );
    const reviews = await db
      .select({
        input: learningReview.input,
        result: learningReview.result,
        laterThanProposal: typedSQL<boolean>`${gt(learningReview.createdAt, originalCreatedAt)}`,
        afterGrant: typedSQL<boolean>`${gte(learningReview.createdAt, grantedAt)}`,
      })
      .from(learningReview)
      .where(
        and(
          eq(learningReview.projectId, row.projectId),
          row.ownerId === null
            ? isNull(learningReview.ownerId)
            : eq(learningReview.ownerId, row.ownerId),
          eq(learningReview.developerOnly, row.developerOnly),
          eq(learningReview.kind, "work"),
          eq(learningReview.state, "completed"),
          typedSQL<boolean>`not(${learningReview.input} @> '[{"activity":"setup"}]'::jsonb)`,
        ),
      )
      .orderBy(desc(learningReview.createdAt))
      .limit(12);
    const pool: { source: LearningCase; problem: boolean; healthy: boolean }[] = [];
    let freshLinkedProblem = false;
    for (const review of reviews) {
      const result = learningResult.parse(review.result);
      const cases = z.array(learningCase).parse(review.input);
      const linkedFindings = result.findings.filter((finding) => {
        if (finding.relatedProposalId !== row.proposalId) return false;
        try {
          return digest(relatedProposalEdit(finding, cases)) === digest(edit);
        } catch (cause) {
          if (!(cause instanceof LearningResultRejected)) throw cause;
          return false;
        }
      });
      for (const source of cases) {
        if (pool.some((item) => item.source.id === source.id)) continue;
        if (
          source.projectId !== row.projectId ||
          source.ownerId !== row.ownerId ||
          source.developerOnly !== row.developerOnly ||
          !replayableCase(source) ||
          !source.targets.some(
            (item) =>
              item.target.kind === "skill" &&
              item.target.id === edit.target.id &&
              item.target.revisionId === revisionId &&
              item.target.version === baselineTarget.version &&
              item.target.field === "instructions" &&
              !item.truncated &&
              item.text === loaded.text,
          )
        )
          continue;
        const verdict = result.cases.find((item) => item.caseId === source.id);
        const methodFinding = result.findings.some(
          (finding) =>
            finding.dimension === "method" &&
            finding.caseIds.includes(source.id) &&
            source.targets.some(
              (target) =>
                target.target.revisionId === revisionId &&
                finding.evidenceIds.includes(target.evidenceId),
            ),
        );
        const linked = linkedFindings.some((finding) => finding.caseIds.includes(source.id));
        const problem =
          verdict?.fulfillment === "problem" &&
          methodFinding &&
          (row.phase === "recover" || proposal.caseIds.includes(source.id) || linked);
        if (problem && linked && review.afterGrant && review.laterThanProposal)
          freshLinkedProblem = true;
        pool.push({
          source,
          problem,
          healthy:
            review.laterThanProposal &&
            verdict?.fulfillment === "supported" &&
            verdict.verification === "supported" &&
            !proposal.caseIds.includes(source.id),
        });
      }
    }
    // Renewed permission cannot activate an old proposal on old evidence alone.
    // A new, explicitly associated problem supplies current intent without
    // rewriting the proposal's original cases or repeating any paid review.
    if (row.phase === "adopt" && !row.proposalAfterGrant && !freshLinkedProblem) return null;
    const problems = pool.filter((item) => item.problem).slice(0, 2);
    const control = pool.find((item) => item.healthy && !problems.includes(item));
    if (problems.length !== 2 || !control) return null;
    const before = loaded.text;
    let after: string;
    try {
      after =
        row.phase === "recover"
          ? applyLearningEdit(before, { before: edit.after, after: edit.before })
          : applyLearningEdit(before, edit);
      const normalized = skillContentInput.parse({ ...loaded.content, instructions: after });
      if (normalized.instructions !== after) return null;
    } catch {
      return null;
    }
    const choice = loaded.choices[0];
    if (!choice) throw new CommandError("conflict", "Skill activation is no longer available");
    const plan = learningComparisonPlan.parse({
      edit,
      baselineTarget,
      before,
      after,
      cases: [...problems.map((item) => item.source), control.source],
      problemIds: problems.map((item) => item.source.id),
      controlId: control.source.id,
      candidateFirst: Math.random() < 0.5,
      activationVersion: choice.version,
    });
    if (Buffer.byteLength(JSON.stringify(plan)) > 192 * 1024) return null;
    const model = await dependencies.modelIn(sql, row, row.actorId);
    const [calibrated] = await db
      .select({ id: learningReview.id })
      .from(learningReview)
      .where(
        and(
          eq(learningReview.judgeKey, model.judgeKey),
          eq(learningReview.kind, "calibration"),
          eq(learningReview.state, "completed"),
          eq(learningReview.calibrated, true),
        ),
      );
    if (!calibrated) return null;
    const id = crypto.randomUUID(),
      token = crypto.randomUUID();
    await db.insert(operation).values({
      id,
      kind: "learning.trial",
      scopeType: "learning_proposal",
      scopeId: row.proposalId,
      idempotencyKey: trialKey,
      activeKey: null,
      state: "running",
      leaseOwner: token,
      leaseExpiresAt: typedSQL`now()+interval '2 minutes'`,
      error: null,
      createdBy: row.actorId,
      payload: {
        id,
        proposalId: row.proposalId,
        phase: row.phase,
        actorId: row.actorId,
        policyVersion: row.policyVersion,
        modelId: model.modelId,
        modelConnection: model.reference ?? {
          endpoint: model.fallback?.baseURL,
          provider: model.fallback?.provider,
        },
        judgeKey: model.judgeKey,
        rubric: comparisonRubric,
        input: plan,
        inputDigest: digest(plan),
        result: null,
        reason: null,
        steps: [],
      },
    });
    return { ...row, id, token, plan, model };
  });
}
