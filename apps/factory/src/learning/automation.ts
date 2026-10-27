import { createHash } from "node:crypto";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  applyLearningEdit,
  learningCase,
  learningProposal,
  learningResult,
  validateLearningResult,
  type LearningCase,
  type LearningEdit,
} from "../../../../packages/conversation-domain/src/learning";
import {
  comparisonCases,
  comparisonPassed,
  comparisonRubric,
  learningComparisonPlan,
  replayableCase,
  validateReplayAnswers,
  type ReplayAnswers,
} from "../../../../packages/conversation-domain/src/learning-comparison";
import type { ModelConnectionReference } from "../../../../packages/conversation-domain/src/model-connection";
import { skillContentInput } from "../../../../packages/conversation-domain/src/skills";
import type { AgentTurnTransaction } from "../agent/turn-store";
import type { ResolvedModelConnection } from "../models/native";
import { knownModelRejection } from "../models/execution-policy";
import { recordedMastraUsage } from "../usage/record-mastra";
import { createUsageJournal } from "../usage/journal";
import { CommandError } from "../command-error";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { createLearningTargets, learningActivation, learningEditDigest } from "./targets";
import { reviewWork, workReviewInstructions } from "./judge";
import { replayInstructions, replayPlanning } from "./replay";

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
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createLearningAutomation(
  database: Database,
  dependencies: {
    modelIn(sql: AgentTurnTransaction, scope: Scope, actorId: string): Promise<Model>;
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

  async function grantIn(sql: AgentTurnTransaction, row: Candidate) {
    await learningAuthorityIn(sql, row.actorId, row);
    if (!(await learningEnabledIn(sql, row.projectId, row.ownerId)))
      throw new CommandError("forbidden", "Learning is paused");
    const [policy] = await sql`SELECT scope_key FROM factory.learning_policy
      WHERE project_id=${row.projectId} AND owner_id IS NOT DISTINCT FROM ${row.ownerId}::uuid
        AND automatic_skills AND version=${row.policyVersion} AND updated_by=${row.actorId}`;
    if (!policy) throw new CommandError("forbidden", "Automatic Skill permission changed");
  }
  async function loadedIn(
    sql: AgentTurnTransaction,
    row: Candidate,
    edit: LearningEdit,
    choiceVersion?: number,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
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
      const [application] = await sql`SELECT id FROM factory.learning_application
        WHERE id=${row.applicationId} AND state='applied' AND comparison_id IS NOT NULL
          AND applied_revision_id=${row.appliedRevisionId}`;
      if (!application) throw new CommandError("conflict", "Applied guidance changed");
      const activation = z.array(learningActivation).parse(row.activation);
      if (activation.length !== 1 || activation[0]?.afterVersion !== loaded.choices[0]?.version)
        throw new CommandError("conflict", "A newer Skill choice blocks automatic recovery");
    } else {
      const [proposal] =
        await sql`SELECT id FROM factory.learning_proposal WHERE id=${row.proposalId} AND state='proposed'`;
      if (!proposal) throw new CommandError("conflict", "The proposal already has a decision");
      const [reverted] =
        await sql`SELECT application.id FROM factory.learning_application application
        JOIN factory.learning_proposal proposal ON proposal.id=application.proposal_id
        WHERE application.state='reverted' AND application.target->>'id'=${target.id}
          AND proposal.content->'edit'->>'after'=${edit.after} LIMIT 1`;
      if (reverted)
        throw new CommandError("conflict", "A reverted edit cannot be automatically repeated");
    }
    return loaded;
  }
  async function admit(row: Candidate) {
    return database.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning-trial:${row.proposalId}:${row.phase}`}))`;
      const [existing] =
        await sql`SELECT id FROM factory.learning_trial WHERE proposal_id=${row.proposalId} AND phase=${row.phase}`;
      if (existing) return null; // A failed or uncertain comparison is never paid again.
      await grantIn(sql, row);
      const proposal = learningProposal.parse(row.content);
      if (!proposal.edit) return null;
      const edit = proposal.edit;
      const loaded = await loadedIn(sql, row, edit);
      const [busy] = await sql`SELECT id FROM factory.learning_trial WHERE state='running'
        AND input->'edit'->'target'->>'id'=${edit.target.id}`;
      if (busy) return null;
      const baselineTarget = currentTarget(row, edit);
      const revisionId = baselineTarget.revisionId;
      const reviews = await sql<{ input: unknown; result: unknown; laterThanProposal: boolean }[]>`
        SELECT review.input,review.result,
          (review.created_at>(SELECT created_at FROM factory.learning_review WHERE id=${row.reviewId})) AS "laterThanProposal"
        FROM factory.learning_review review
        WHERE review.project_id=${row.projectId} AND review.owner_id IS NOT DISTINCT FROM ${row.ownerId}::uuid
          AND review.developer_only=${row.developerOnly} AND review.kind='work' AND review.state='completed'
          AND NOT(review.input @> '[{"activity":"setup"}]'::jsonb)
        ORDER BY review.created_at DESC LIMIT 12`;
      const pool: { source: LearningCase; problem: boolean; healthy: boolean }[] = [];
      for (const review of reviews) {
        const result = learningResult.parse(review.result);
        for (const source of z.array(learningCase).parse(review.input)) {
          if (pool.some((item) => item.source.id === source.id)) continue;
          if (
            !replayableCase(source) ||
            !source.targets.some(
              (item) =>
                item.target.kind === "skill" &&
                item.target.id === edit.target.id &&
                item.target.revisionId === revisionId &&
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
          pool.push({
            source,
            problem:
              verdict?.fulfillment === "problem" &&
              methodFinding &&
              (row.phase === "recover" || proposal.caseIds.includes(source.id)),
            healthy:
              review.laterThanProposal &&
              verdict?.fulfillment === "supported" &&
              verdict.verification === "supported" &&
              !proposal.caseIds.includes(source.id),
          });
        }
      }
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
      const [calibrated] = await sql`SELECT id FROM factory.learning_review
        WHERE judge_key=${model.judgeKey} AND kind='calibration' AND state='completed' AND calibrated`;
      if (!calibrated) return null;
      const id = crypto.randomUUID(),
        token = crypto.randomUUID();
      await sql`INSERT INTO factory.learning_trial(id,proposal_id,phase,actor_id,policy_version,model_id,model_connection,judge_key,
        rubric,input,input_digest,owner_token,owner_expires_at)
        VALUES(${id},${row.proposalId},${row.phase},${row.actorId},${row.policyVersion},${model.modelId},
          ${JSON.stringify(model.reference ?? { endpoint: model.fallback?.baseURL, provider: model.fallback?.provider })}::jsonb,${model.judgeKey},${comparisonRubric},
          ${JSON.stringify(plan)}::jsonb,${digest(plan)},${token},now()+interval '2 minutes')`;
      return { ...row, id, token, plan, model };
    });
  }
  async function execute(admitted: NonNullable<Awaited<ReturnType<typeof admit>>>) {
    const controller = new AbortController();
    running.add(controller);
    const authorizeIn = async (sql: AgentTurnTransaction) => {
      controller.signal.throwIfAborted();
      await grantIn(sql, admitted);
      await loadedIn(sql, admitted, admitted.plan.edit, admitted.plan.activationVersion);
      const [lease] =
        await sql`UPDATE factory.learning_trial SET owner_expires_at=now()+interval '2 minutes'
        WHERE id=${admitted.id} AND owner_token=${admitted.token} AND state='running' AND owner_expires_at>now() RETURNING id`;
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
          await sql`INSERT INTO factory.learning_trial_step(trial_id,stage,input,input_digest)
            VALUES(${admitted.id},${stage},${JSON.stringify(input)}::jsonb,${digest(input)})`;
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
          await sql`UPDATE factory.learning_trial_step SET state='completed',result=${JSON.stringify(result)}::jsonb,completed_at=now()
            WHERE trial_id=${admitted.id} AND stage=${stage} AND state='running'`;
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
          (dependencies.review ?? reviewWork)({ ...common, usage, cases }),
        ),
        cases,
      );
      const passed = comparisonPassed(admitted.plan, grade);
      await database.client.begin(async (sql) => {
        await sql`SELECT id FROM factory.learning_proposal WHERE id=${admitted.proposalId} FOR UPDATE`;
        if (admitted.applicationId)
          await sql`SELECT id FROM factory.learning_application WHERE id=${admitted.applicationId} FOR UPDATE`;
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
            await sql`INSERT INTO factory.learning_application(id,proposal_id,target,edit_digest,activation,applied_revision_id,applied_version,applied_by,comparison_id)
              VALUES(${crypto.randomUUID()},${admitted.proposalId},${JSON.stringify(admitted.plan.edit.target)}::jsonb,
                ${learningEditDigest(admitted.plan.edit)},${JSON.stringify(saved.activation)}::jsonb,
                ${saved.revisionId},${saved.version},${admitted.actorId},${admitted.id})`;
            await sql`UPDATE factory.learning_proposal SET state='applied',decision_id=${admitted.id},decided_by=${admitted.actorId},decided_at=now()
              WHERE id=${admitted.proposalId} AND state='proposed'`;
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
            await sql`UPDATE factory.learning_application SET state='reverted',reverted_revision_id=${saved.revisionId},
              reverted_version=${saved.version},reverted_by=${admitted.actorId},reverted_at=now(),reverted_comparison_id=${admitted.id}
              WHERE id=${admitted.applicationId} AND state='applied'`;
            decision = "reverted";
          }
        }
        await sql`UPDATE factory.learning_trial SET state='completed',
          result=${JSON.stringify({ passed, decision, cases: grade.cases })}::jsonb,completed_at=now()
          WHERE id=${admitted.id} AND owner_token=${admitted.token} AND state='running'`;
      });
    } catch (cause) {
      const state =
        knownModelRejection(cause) || cause instanceof CommandError ? "failed" : "uncertain";
      await database.client`UPDATE factory.learning_trial SET state=${state},
        reason=${cause instanceof CommandError ? cause.message : "The comparison did not finish. It will not be repeated automatically."},completed_at=now()
        WHERE id=${admitted.id} AND state='running' AND owner_token=${admitted.token}`;
      await abandon(admitted.id);
    } finally {
      clearInterval(renewalTimer);
      await renewal;
      running.delete(controller);
    }
  }
  async function abandon(id: string) {
    const steps = await database.client<
      { stage: number }[]
    >`UPDATE factory.learning_trial_step SET state='uncertain',completed_at=now()
      WHERE trial_id=${id} AND state='running' RETURNING stage`;
    for (const step of steps)
      await createUsageJournal(database).abandon(`learning-trial:${id}:${step.stage}`);
  }
  return {
    async sweep() {
      if (closed) return false;
      const expired = await database.client<
        { id: string }[]
      >`UPDATE factory.learning_trial SET state='uncertain',completed_at=now(),
        reason='Comparison ownership expired. No paid step will be replayed.' WHERE state='running' AND owner_expires_at<now() RETURNING id`;
      for (const item of expired) await abandon(item.id);
      const rows = await database.client<Candidate[]>`
        SELECT proposal.id AS "proposalId",proposal.review_id AS "reviewId",proposal.content,review.project_id AS "projectId",review.owner_id AS "ownerId",
          review.developer_only AS "developerOnly",policy.version AS "policyVersion",policy.updated_by AS "actorId",
          CASE WHEN application.id IS NULL THEN 'adopt' ELSE 'recover' END AS phase,
          application.id AS "applicationId",application.applied_revision_id AS "appliedRevisionId",
          application.applied_version AS "appliedVersion",application.activation
        FROM factory.learning_proposal proposal JOIN factory.learning_review review ON review.id=proposal.review_id
        JOIN factory.learning_policy policy ON policy.project_id=review.project_id AND policy.owner_id IS NOT DISTINCT FROM review.owner_id
        LEFT JOIN factory.learning_application application ON application.proposal_id=proposal.id
        WHERE policy.enabled AND policy.automatic_skills AND review.kind='work' AND review.state='completed'
          AND NOT(review.input @> '[{"activity":"setup"}]'::jsonb)
          AND proposal.content->'edit'->'target'->>'kind'='skill' AND proposal.content->'edit'->'target'->>'field'='instructions'
          AND ((proposal.state='proposed' AND review.created_at>=policy.updated_at) OR
            (application.state='applied' AND application.comparison_id IS NOT NULL))
          AND NOT EXISTS(SELECT 1 FROM factory.learning_trial trial WHERE trial.proposal_id=proposal.id
            AND trial.phase=CASE WHEN application.id IS NULL THEN 'adopt' ELSE 'recover' END)
          AND proposal.id::text>${cursor}
        ORDER BY proposal.id LIMIT 24`;
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
