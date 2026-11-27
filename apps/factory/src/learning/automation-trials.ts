import { and, eq, gt, sql as typedSQL } from "drizzle-orm";
import { LearningResultRejected, validateLearningResult } from "#conversation-domain/learning";
import {
  comparisonCases,
  comparisonPassed,
  type ReplayAnswers,
  validateReplayAnswers,
} from "#conversation-domain/learning-comparison";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { type LearningTrialStepRecord, operation } from "#db/schema";
import { CommandError } from "../command-error";
import { knownModelRejection } from "../models/execution-policy";
import { createUsageJournal } from "../usage/journal-api";
import { recordedMastraUsage } from "../usage/record-mastra";
import { grantIn, loadedIn } from "./automation-candidates";
import { settleTrialOutcome } from "./automation-settlement";
import {
  type AdmittedTrial,
  type AutomationDependencies,
  digest,
  type LearningDatabase,
  type LearningTargets,
} from "./automation-types";
import { reviewWork } from "./judge";
import { workReviewInstructions } from "./judge-contract";
import { learningRejectionReason } from "./rejection-reason";
import { replayPlanning } from "./replay";
import { replayInstructions } from "./replay-contract";

async function mutateTrialSteps(
  sql: DatabaseTransaction,
  trialId: string,
  authorizeIn: (sql: DatabaseTransaction) => Promise<void>,
  transform: (steps: LearningTrialStepRecord[]) => LearningTrialStepRecord[],
) {
  await authorizeIn(sql);
  const db = drizzleTransaction(sql);
  const [trial] = await db
    .select({ payload: operation.payload })
    .from(operation)
    .where(and(eq(operation.id, trialId), eq(operation.kind, "learning.trial")))
    .for("update");
  if (!trial) throw new CommandError("conflict", "Comparison ownership expired");
  const steps = (trial.payload["steps"] ?? []) as LearningTrialStepRecord[];
  const nextSteps = transform(steps);
  await db
    .update(operation)
    .set({
      payload: typedSQL`jsonb_set(${operation.payload}, '{steps}', ${JSON.stringify(nextSteps)}::jsonb, true)`,
      updatedAt: typedSQL`now()`,
    })
    .where(
      and(
        eq(operation.id, trialId),
        eq(operation.kind, "learning.trial"),
        eq(operation.state, "running"),
      ),
    );
}

export async function executeTrial(
  database: LearningDatabase,
  targets: LearningTargets,
  dependencies: AutomationDependencies,
  running: Set<AbortController>,
  admitted: AdmittedTrial,
) {
  const controller = new AbortController();
  running.add(controller);
  const authorizeIn = async (sql: DatabaseTransaction) => {
    controller.signal.throwIfAborted();
    await grantIn(sql, admitted);
    await loadedIn(sql, targets, admitted, admitted.plan.edit, admitted.plan.activationVersion);
    const [lease] = await drizzleTransaction(sql)
      .update(operation)
      .set({ leaseExpiresAt: typedSQL`now()+interval '2 minutes'`, updatedAt: typedSQL`now()` })
      .where(
        and(
          eq(operation.id, admitted.id),
          eq(operation.kind, "learning.trial"),
          eq(operation.leaseOwner, admitted.token),
          eq(operation.state, "running"),
          gt(operation.leaseExpiresAt, typedSQL`now()`),
        ),
      )
      .returning({ id: operation.id });
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
      await database.client.begin((sql) =>
        mutateTrialSteps(sql, admitted.id, authorizeIn, (steps) => {
          if (steps.some((existing) => existing.stage === stage))
            throw new CommandError("conflict", "Comparison step already recorded");
          return [
            ...steps,
            {
              stage,
              input,
              inputDigest: digest(input),
              state: "running",
              result: null,
              createdAt: new Date().toISOString(),
              completedAt: null,
            },
          ];
        }),
      );
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
      await database.client.begin((sql) =>
        mutateTrialSteps(sql, admitted.id, authorizeIn, (steps) => {
          const completedAt = new Date().toISOString();
          return steps.map((existing) =>
            existing.stage === stage && existing.state === "running"
              ? { ...existing, state: "completed", result, completedAt }
              : existing,
          );
        }),
      );
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
    await database.client.begin((sql) =>
      settleTrialOutcome(sql, targets, admitted, passed, grade, authorizeIn),
    );
  } catch (cause) {
    const rejected = cause instanceof LearningResultRejected;
    const state =
      knownModelRejection(cause) || cause instanceof CommandError || rejected
        ? "failed"
        : "uncertain";
    const abandonedStages = await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const [current] = await db
        .select({ payload: operation.payload })
        .from(operation)
        .where(
          and(
            eq(operation.id, admitted.id),
            eq(operation.kind, "learning.trial"),
            eq(operation.state, "running"),
            eq(operation.leaseOwner, admitted.token),
          ),
        )
        .for("update");
      if (!current) return [];
      const steps = (current.payload["steps"] ?? []) as LearningTrialStepRecord[];
      const completedAt = new Date().toISOString();
      const runningStages = steps
        .filter((item) => item.state === "running")
        .map((item) => item.stage);
      const nextSteps = steps.map((item) =>
        item.state === "running" ? { ...item, state: "uncertain", completedAt } : item,
      );
      const reason =
        cause instanceof CommandError
          ? cause.message
          : rejected
            ? learningRejectionReason(
                cause,
                "The comparison grade did not match the replayed responses, so it was discarded. It will not be repeated automatically.",
              )
            : "The comparison did not finish. It will not be repeated automatically.";
      await db
        .update(operation)
        .set({
          state,
          error: reason,
          payload: typedSQL`${operation.payload} || jsonb_build_object('steps', ${JSON.stringify(nextSteps)}::jsonb, 'reason', ${reason}::text)`,
          completedAt: typedSQL`now()`,
          updatedAt: typedSQL`now()`,
        })
        .where(
          and(
            eq(operation.id, admitted.id),
            eq(operation.kind, "learning.trial"),
            eq(operation.state, "running"),
            eq(operation.leaseOwner, admitted.token),
          ),
        );
      return runningStages;
    });
    for (const stage of abandonedStages)
      await createUsageJournal(database).abandon(`learning-trial:${admitted.id}:${stage}`);
  } finally {
    clearInterval(renewalTimer);
    await renewal;
    running.delete(controller);
  }
}
