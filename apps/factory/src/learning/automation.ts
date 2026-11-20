import { createHash } from "node:crypto";
import {
  and,
  desc,
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
import { z } from "zod";
import {
  applyLearningEdit,
  type LearningCase,
  type LearningEdit,
  LearningResultRejected,
  learningCase,
  learningProposal,
  learningResult,
  validateLearningResult,
} from "../../../../packages/conversation-domain/src/learning";
import {
  comparisonCases,
  comparisonPassed,
  comparisonRubric,
  learningComparisonPlan,
  type ReplayAnswers,
  replayableCase,
  validateReplayAnswers,
} from "../../../../packages/conversation-domain/src/learning-comparison";
import type { ModelConnectionReference } from "../../../../packages/conversation-domain/src/model-connection";
import { skillContentInput } from "../../../../packages/conversation-domain/src/skills";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  learningApplication,
  learningPolicy,
  learningReview,
  learningTrial,
  learningTrialStep,
  learningProposal as proposalTable,
} from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";
import { knownModelRejection } from "../models/execution-policy";
import type { ResolvedModelConnection } from "../models/native";
import { createUsageJournal } from "../usage/journal";
import { recordedMastraUsage } from "../usage/record-mastra";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { reviewWork, workReviewInstructions } from "./judge";
import { relatedProposalEdit } from "./prior-proposals";
import { learningRejectionReason } from "./rejection-reason";
import { replayInstructions, replayPlanning } from "./replay";
import { createLearningTargets, learningActivation, learningEditDigest } from "./targets";

type Database = ReturnType<typeof createDatabase>;
type Scope = { projectId: string; ownerId: string | null; developerOnly: boolean };
type Model = {
  modelId: string;
  reference: ModelConnectionReference | null;
  fallback: ResolvedModelConnection | null;
  judgeKey: string;
};
type Candidate = Scope & {
  proposalId: string;
  reviewId: string;
  content: unknown;
  phase: "adopt" | "recover";
  policyVersion: number;
  actorId: string;
  applicationId: string | null;
  appliedRevisionId: string | null;
  appliedVersion: number | null;
  activation: unknown;
  proposalAfterGrant: boolean;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createLearningAutomation(
  database: Database,
  dependencies: {
    modelIn(sql: DatabaseTransaction, scope: Scope, actorId: string): Promise<Model>;
    connect(model: Model): Promise<ResolvedModelConnection>;
    review?: typeof reviewWork;
    replay?: typeof replayPlanning;
  },
) {
  const targets = createLearningTargets(database);
  let closed = false;
  const running = new Set<AbortController>();
  let cursor = "";

  function currentTarget(
    row: Pick<Candidate, "phase" | "appliedRevisionId" | "appliedVersion">,
    edit: LearningEdit,
  ) {
    if (row.phase !== "recover") return edit.target;
    const revisionId = row.appliedRevisionId;
    const version = row.appliedVersion;
    if (!revisionId || version === null)
      throw new CommandError("conflict", "Recovery requires its exact applied revision");
    return { ...edit.target, revisionId, version };
  }

  async function grantIn(sql: DatabaseTransaction, row: Candidate) {
    await learningAuthorityIn(sql, row.actorId, row);
    if (!(await learningEnabledIn(sql, row.projectId, row.ownerId)))
      throw new CommandError("forbidden", "Learning is paused");
    const [policy] = await drizzleTransaction(sql)
      .select({ scopeKey: learningPolicy.scopeKey })
      .from(learningPolicy)
      .where(
        and(
          eq(learningPolicy.projectId, row.projectId),
          row.ownerId === null
            ? isNull(learningPolicy.ownerId)
            : eq(learningPolicy.ownerId, row.ownerId),
          eq(learningPolicy.automaticSkills, true),
          eq(learningPolicy.version, row.policyVersion),
          eq(learningPolicy.updatedBy, row.actorId),
        ),
      );
    if (!policy) throw new CommandError("forbidden", "Automatic Skill permission changed");
  }
  async function loadedIn(
    sql: DatabaseTransaction,
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
        .select({ id: learningApplication.id })
        .from(learningApplication)
        .where(
          and(
            // A recovery candidate always carries both identities. Preserve SQL's
            // non-match for a missing identity instead of matching a shared null.
            eq(learningApplication.id, typedSQL`${row.applicationId}::uuid`),
            eq(learningApplication.state, "applied"),
            isNotNull(learningApplication.comparisonId),
            eq(learningApplication.appliedRevisionId, typedSQL`${row.appliedRevisionId}::uuid`),
          ),
        );
      if (!application) throw new CommandError("conflict", "Applied guidance changed");
      const activation = z.array(learningActivation).parse(row.activation);
      if (activation.length !== 1 || activation[0]?.afterVersion !== loaded.choices[0]?.version)
        throw new CommandError("conflict", "A newer Skill choice blocks automatic recovery");
    } else {
      const [proposal] = await db
        .select({ id: proposalTable.id })
        .from(proposalTable)
        .where(and(eq(proposalTable.id, row.proposalId), eq(proposalTable.state, "proposed")));
      if (!proposal) throw new CommandError("conflict", "The proposal already has a decision");
      const [reverted] = await db
        .select({ id: learningApplication.id })
        .from(learningApplication)
        .innerJoin(proposalTable, eq(proposalTable.id, learningApplication.proposalId))
        .where(
          and(
            eq(learningApplication.state, "reverted"),
            eq(typedSQL<string>`${learningApplication.target}->>'id'`, target.id),
            eq(typedSQL<string>`${proposalTable.content}->'edit'->>'after'`, edit.after),
          ),
        )
        .limit(1);
      if (reverted)
        throw new CommandError("conflict", "A reverted edit cannot be automatically repeated");
    }
    return loaded;
  }
  async function admit(row: Candidate) {
    return database.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning-trial:${row.proposalId}:${row.phase}`}))`;
      const db = drizzleTransaction(sql);
      const [existing] = await db
        .select({ id: learningTrial.id })
        .from(learningTrial)
        .where(
          and(eq(learningTrial.proposalId, row.proposalId), eq(learningTrial.phase, row.phase)),
        );
      if (existing) return null; // A failed or uncertain comparison is never paid again.
      await grantIn(sql, row);
      const proposal = learningProposal.parse(row.content);
      if (!proposal.edit) return null;
      const edit = proposal.edit;
      const loaded = await loadedIn(sql, row, edit);
      const [busy] = await db
        .select({ id: learningTrial.id })
        .from(learningTrial)
        .where(
          and(
            eq(learningTrial.state, "running"),
            eq(typedSQL<string>`${learningTrial.input}->'edit'->'target'->>'id'`, edit.target.id),
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
      const grantedAt = db
        .select({ updatedAt: learningPolicy.updatedAt })
        .from(learningPolicy)
        .where(
          and(
            eq(learningPolicy.projectId, row.projectId),
            row.ownerId === null
              ? isNull(learningPolicy.ownerId)
              : eq(learningPolicy.ownerId, row.ownerId),
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
      await db.insert(learningTrial).values({
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
        ownerToken: token,
        ownerExpiresAt: typedSQL`now()+interval '2 minutes'`,
      });
      return { ...row, id, token, plan, model };
    });
  }
  async function execute(admitted: NonNullable<Awaited<ReturnType<typeof admit>>>) {
    const controller = new AbortController();
    running.add(controller);
    const authorizeIn = async (sql: DatabaseTransaction) => {
      controller.signal.throwIfAborted();
      await grantIn(sql, admitted);
      await loadedIn(sql, admitted, admitted.plan.edit, admitted.plan.activationVersion);
      const [lease] = await drizzleTransaction(sql)
        .update(learningTrial)
        .set({ ownerExpiresAt: typedSQL`now()+interval '2 minutes'` })
        .where(
          and(
            eq(learningTrial.id, admitted.id),
            eq(learningTrial.ownerToken, admitted.token),
            eq(learningTrial.state, "running"),
            gt(learningTrial.ownerExpiresAt, typedSQL`now()`),
          ),
        )
        .returning({ id: learningTrial.id });
      if (!lease) throw new CommandError("conflict", "Comparison ownership expired");
    };
    const authorize = () => database.client.begin(authorizeIn).then(() => {});
    let renewal: Promise<unknown> | undefined;
    const renewalTimer = setInterval(() => {
      if (renewal) return;
      renewal = authorize()
        .catch(() => controller.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, 15_000);
    renewalTimer.unref();
    try {
      const connection = await dependencies.connect(admitted.model);
      const common = {
        modelId: admitted.model.modelId,
        connection,
        signal: controller.signal,
        authorize,
      };
      async function step<T>(
        stage: number,
        input: unknown,
        run: (usage: ReturnType<typeof recordedMastraUsage>) => Promise<T>,
      ) {
        // Save this exact request before each independent paid boundary, including
        // the judge's actual response artifacts. No inferred retry after a crash.
        await database.client.begin(async (sql) => {
          await authorizeIn(sql);
          await drizzleTransaction(sql)
            .insert(learningTrialStep)
            .values({ trialId: admitted.id, stage, input, inputDigest: digest(input) });
        });
        const result = await run(
          recordedMastraUsage(database, {
            id: `learning-trial:${admitted.id}:${stage}`,
            projectID: admitted.projectId,
            userID: admitted.actorId,
            purpose: "learning",
            provider: connection.provider ?? "openai",
            model: common.modelId,
          }),
        );
        await database.client.begin(async (sql) => {
          await authorizeIn(sql);
          await drizzleTransaction(sql)
            .update(learningTrialStep)
            .set({ state: "completed", result, completedAt: typedSQL`now()` })
            .where(
              and(
                eq(learningTrialStep.trialId, admitted.id),
                eq(learningTrialStep.stage, stage),
                eq(learningTrialStep.state, "running"),
              ),
            );
        });
        return result;
      }
      const arms: ReplayAnswers[] = [];
      for (let arm = 0; arm < 2; arm++) {
        const candidate = (arm === 0) === admitted.plan.candidateFirst;
        const instructions = candidate ? admitted.plan.after : admitted.plan.before;
        arms.push(
          validateReplayAnswers(
            await step(
              arm,
              { instructions: replayInstructions, skill: instructions, cases: admitted.plan.cases },
              (usage) =>
                (dependencies.replay ?? replayPlanning)({
                  ...common,
                  usage,
                  instructions,
                  cases: admitted.plan.cases,
                }),
            ),
            admitted.plan.cases,
          ),
        );
      }
      const cases = comparisonCases(admitted.plan, arms);
      const grade = validateLearningResult(
        await step(2, { instructions: workReviewInstructions, cases }, (usage) =>
          (dependencies.review ?? reviewWork)({ ...common, usage, cases, comparison: true }),
        ),
        cases,
      );
      const passed = comparisonPassed(admitted.plan, grade);
      await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await db
          .select({ id: proposalTable.id })
          .from(proposalTable)
          .where(eq(proposalTable.id, admitted.proposalId))
          .for("update");
        if (admitted.applicationId)
          await db
            .select({ id: learningApplication.id })
            .from(learningApplication)
            .where(eq(learningApplication.id, admitted.applicationId))
            .for("update");
        await authorizeIn(sql);
        let decision: "applied" | "reverted" | "kept" = "kept";
        if (passed) {
          if (admitted.phase === "adopt") {
            const saved = await targets.apply(sql, {
              edit: admitted.plan.edit,
              userId: admitted.actorId,
              projectId: admitted.projectId,
              revisionId: crypto.randomUUID(),
            });
            await db.insert(learningApplication).values({
              id: crypto.randomUUID(),
              proposalId: admitted.proposalId,
              target: admitted.plan.edit.target,
              editDigest: learningEditDigest(admitted.plan.edit),
              activation: saved.activation,
              appliedRevisionId: saved.revisionId,
              appliedVersion: saved.version,
              appliedBy: admitted.actorId,
              comparisonId: admitted.id,
            });
            await db
              .update(proposalTable)
              .set({
                state: "applied",
                decisionId: admitted.id,
                decidedBy: admitted.actorId,
                decidedAt: typedSQL`now()`,
              })
              .where(
                and(eq(proposalTable.id, admitted.proposalId), eq(proposalTable.state, "proposed")),
              );
            decision = "applied";
          } else {
            const target = currentTarget(admitted, admitted.plan.edit);
            const saved = await targets.revert(sql, {
              target: admitted.plan.edit.target,
              appliedRevisionId: target.revisionId,
              appliedVersion: target.version,
              activation: z.array(learningActivation).parse(admitted.activation),
              userId: admitted.actorId,
              projectId: admitted.projectId,
              revisionId: crypto.randomUUID(),
            });
            await db
              .update(learningApplication)
              .set({
                state: "reverted",
                revertedRevisionId: saved.revisionId,
                revertedVersion: saved.version,
                revertedBy: admitted.actorId,
                revertedAt: typedSQL`now()`,
                revertedComparisonId: admitted.id,
              })
              .where(
                and(
                  eq(learningApplication.id, typedSQL`${admitted.applicationId}::uuid`),
                  eq(learningApplication.state, "applied"),
                ),
              );
            decision = "reverted";
          }
        }
        await db
          .update(learningTrial)
          .set({
            state: "completed",
            result: { passed, decision, cases: grade.cases },
            completedAt: typedSQL`now()`,
          })
          .where(
            and(
              eq(learningTrial.id, admitted.id),
              eq(learningTrial.ownerToken, admitted.token),
              eq(learningTrial.state, "running"),
            ),
          );
      });
    } catch (cause) {
      const rejected = cause instanceof LearningResultRejected;
      const state =
        knownModelRejection(cause) || cause instanceof CommandError || rejected
          ? "failed"
          : "uncertain";
      await database.db
        .update(learningTrial)
        .set({
          state,
          reason:
            cause instanceof CommandError
              ? cause.message
              : rejected
                ? learningRejectionReason(
                    cause,
                    "The comparison grade did not match the replayed responses, so it was discarded. It will not be repeated automatically.",
                  )
                : "The comparison did not finish. It will not be repeated automatically.",
          completedAt: typedSQL`now()`,
        })
        .where(
          and(
            eq(learningTrial.id, admitted.id),
            eq(learningTrial.state, "running"),
            eq(learningTrial.ownerToken, admitted.token),
          ),
        );
      await abandon(admitted.id);
    } finally {
      clearInterval(renewalTimer);
      await renewal;
      running.delete(controller);
    }
  }
  async function abandon(id: string) {
    const steps = await database.db
      .update(learningTrialStep)
      .set({ state: "uncertain", completedAt: typedSQL`now()` })
      .where(and(eq(learningTrialStep.trialId, id), eq(learningTrialStep.state, "running")))
      .returning({ stage: learningTrialStep.stage });
    for (const step of steps)
      await createUsageJournal(database).abandon(`learning-trial:${id}:${step.stage}`);
  }
  return {
    async sweep() {
      if (closed) return false;
      const expired = await database.db
        .update(learningTrial)
        .set({
          state: "uncertain",
          completedAt: typedSQL`now()`,
          reason: "Comparison ownership expired. No paid step will be replayed.",
        })
        .where(
          and(
            eq(learningTrial.state, "running"),
            lt(learningTrial.ownerExpiresAt, typedSQL`now()`),
          ),
        )
        .returning({ id: learningTrial.id });
      for (const item of expired) await abandon(item.id);
      const phase = typedSQL<
        Candidate["phase"]
      >`case when ${learningApplication.id} is null then 'adopt' else 'recover' end`;
      const rows: Candidate[] = await database.db
        .select({
          proposalId: proposalTable.id,
          reviewId: proposalTable.reviewId,
          content: proposalTable.content,
          projectId: learningReview.projectId,
          ownerId: learningReview.ownerId,
          developerOnly: learningReview.developerOnly,
          policyVersion: learningPolicy.version,
          actorId: learningPolicy.updatedBy,
          phase,
          applicationId: learningApplication.id,
          appliedRevisionId: learningApplication.appliedRevisionId,
          appliedVersion: learningApplication.appliedVersion,
          activation: learningApplication.activation,
          proposalAfterGrant: typedSQL<boolean>`${gte(learningReview.createdAt, learningPolicy.updatedAt)}`,
        })
        .from(proposalTable)
        .innerJoin(learningReview, eq(learningReview.id, proposalTable.reviewId))
        .innerJoin(
          learningPolicy,
          and(
            eq(learningPolicy.projectId, learningReview.projectId),
            typedSQL<boolean>`${learningPolicy.ownerId} is not distinct from ${learningReview.ownerId}`,
          ),
        )
        .leftJoin(learningApplication, eq(learningApplication.proposalId, proposalTable.id))
        .where(
          and(
            eq(learningPolicy.enabled, true),
            eq(learningPolicy.automaticSkills, true),
            eq(learningReview.kind, "work"),
            eq(learningReview.state, "completed"),
            typedSQL<boolean>`not(${learningReview.input} @> '[{"activity":"setup"}]'::jsonb)`,
            eq(typedSQL<string>`${proposalTable.content}->'edit'->'target'->>'kind'`, "skill"),
            eq(
              typedSQL<string>`${proposalTable.content}->'edit'->'target'->>'field'`,
              "instructions",
            ),
            or(
              and(eq(proposalTable.state, "proposed"), isNull(learningApplication.id)),
              and(
                eq(learningApplication.state, "applied"),
                isNotNull(learningApplication.comparisonId),
              ),
            ),
            notExists(
              database.db
                .select({ id: learningTrial.id })
                .from(learningTrial)
                .where(
                  and(
                    eq(learningTrial.proposalId, proposalTable.id),
                    eq(learningTrial.phase, phase),
                  ),
                ),
            ),
            gt(typedSQL<string>`${proposalTable.id}::text`, cursor),
          ),
        )
        .orderBy(proposalTable.id)
        .limit(24);
      if (!rows.length) {
        cursor = "";
        return false;
      }
      for (const row of rows) {
        cursor = row.proposalId;
        if (closed) break;
        try {
          const admitted = await admit(row);
          if (admitted) {
            await execute(admitted);
            return true;
          }
        } catch (cause) {
          if (!(cause instanceof CommandError)) throw cause;
        }
      }
      return false;
    },
    close() {
      closed = true;
      for (const item of running) item.abort();
    },
  };
}
