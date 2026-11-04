import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { reviewWork } from "../../apps/factory/src/learning/judge";
import { calibrationCases, calibrationPassed } from "../../apps/factory/src/learning/calibration";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";
import { modelEnvironment } from "../../apps/factory/src/models/controller";
import type { UsageEntry } from "../../apps/factory/src/usage/journal";
import type { LearningCase } from "../../packages/conversation-domain/src/learning";
import { replayPlanning } from "../../apps/factory/src/learning/replay";
import {
  comparisonExample,
  comparisonBefore,
  comparisonAfter,
} from "../fixtures/learning-comparison";
import {
  comparisonCases,
  comparisonPassed,
  learningComparisonPlan,
  validateReplayAnswers,
} from "../../packages/conversation-domain/src/learning-comparison";
import { fixtureValue } from "../fixtures/value";

test.skipIf(process.env["FACTORY_LEARNING_MODEL_LIVE"] !== "1")(
  "configured retrospective judge distinguishes healthy work, defects, false greens, scope and coverage evidence",
  async () => {
    const modelId = modelEnvironment().planningModelId;
    const usage: UsageEntry[] = [];
    let started = false,
      settled = false;
    const result = await reviewWork({
      cases: calibrationCases,
      modelId,
      connection: projectModelConnection(),
      signal: AbortSignal.timeout(120_000),
      authorize: async () => {},
      usage: {
        begin: async () => {
          started = true;
        },
        record: async (entry) => {
          expect(started).toBe(true);
          usage.push(entry);
        },
        settle: async () => {
          settled = true;
        },
      },
    });
    await mkdir(".factory/test-results/learning-live", { recursive: true });
    await Bun.write(
      ".factory/test-results/learning-live/calibration.json",
      JSON.stringify(
        {
          modelId,
          result,
          usage,
          calibrated: calibrationPassed(result),
        },
        null,
        2,
      ),
    );
    expect(calibrationPassed(result)).toBe(true);
    expect(started).toBe(true);
    expect(settled).toBe(true);
    expect(usage.some((entry) => entry.source === "step")).toBe(true);
  },
  150_000,
);

test.skipIf(process.env["FACTORY_LEARNING_MODEL_LIVE"] !== "1")(
  "configured model executes isolated matched research replays and the calibrated judge grades actual responses",
  async () => {
    const target = {
      kind: "skill" as const,
      id: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      version: 1,
      field: "instructions" as const,
    };
    const edit = { target, before: comparisonBefore, after: comparisonAfter };
    const example = comparisonExample(crypto.randomUUID(), edit);
    const plan = learningComparisonPlan.parse({
      edit,
      baselineTarget: edit.target,
      before: comparisonBefore,
      after: comparisonAfter,
      cases: example.cases,
      problemIds: example.content.caseIds,
      controlId: fixtureValue(example.cases[2], "example.cases[2]").id,
      candidateFirst: false,
      activationVersion: 1,
    });
    const modelId = modelEnvironment().planningModelId;
    const usage: UsageEntry[] = [];
    const common = {
      modelId,
      connection: projectModelConnection(),
      signal: AbortSignal.timeout(300_000),
      authorize: async () => {},
      usage: {
        begin: async () => {},
        record: async (entry: UsageEntry) => {
          usage.push(entry);
        },
        settle: async () => {},
      },
    };
    const runs = Math.max(1, Number(process.env["FACTORY_LEARNING_COMPARISON_RUNS"] ?? "1"));
    const summary: { passed: boolean; reproduced: boolean; verdicts: string[] }[] = [];
    for (let run = 0; run < runs; run++) {
      const before = usage.length;
      const baseline = validateReplayAnswers(
        await replayPlanning({ ...common, cases: plan.cases, instructions: plan.before }),
        plan.cases,
      );
      const candidate = validateReplayAnswers(
        await replayPlanning({ ...common, cases: plan.cases, instructions: plan.after }),
        plan.cases,
      );
      const cases = comparisonCases(plan, [baseline, candidate]);
      const result = await reviewWork({ ...common, cases, comparison: true });
      const passed = comparisonPassed(plan, result);
      const verdict = (arm: number, index: number) =>
        result.cases.find((item) => item.caseId === `replay:${arm}:${index}`);
      // Arm 0 is the baseline and arm 1 the candidate in this fixed plan.
      const reproduced = [0, 1].every((index) => verdict(0, index)?.fulfillment === "problem");
      const candidateSupported = [0, 1, 2].every(
        (index) =>
          verdict(1, index)?.fulfillment === "supported" &&
          verdict(1, index)?.rework !== "avoidable",
      );
      const controlSupported =
        verdict(0, 2)?.fulfillment === "supported" && verdict(0, 2)?.rework !== "avoidable";
      // A judge-observed verification problem still fails the arms the gate must trust. The
      // baseline's two reproduced failures may carry one without affecting the outcome.
      const noVerificationProblem = [
        verdict(1, 0),
        verdict(1, 1),
        verdict(1, 2),
        verdict(0, 2),
      ].every((item) => item?.verification !== "problem");
      summary.push({
        passed,
        reproduced,
        verdicts: result.cases.map(
          (item) => `${item.caseId}:${item.fulfillment}/${item.verification}/${item.rework}`,
        ),
      });
      await mkdir(".factory/test-results/learning-live", { recursive: true });
      await Bun.write(
        `.factory/test-results/learning-live/comparison-${run + 1}.json`,
        JSON.stringify(
          { modelId, plan, baseline, candidate, result, passed, usage: usage.slice(before) },
          null,
          2,
        ),
      );
      expect(result.cases).toHaveLength(6);
      // The gate rests on the blinded fulfilment verdicts. It must pass exactly when the baseline
      // reproduced both failures, the candidate removed them and the healthy control stayed
      // supported. Never train this assertion to pass.
      expect(passed).toBe(
        reproduced && candidateSupported && controlSupported && noVerificationProblem,
      );
    }
    const passes = summary.filter((item) => item.passed).length;
    await Bun.write(
      ".factory/test-results/learning-live/comparison.json",
      JSON.stringify({ modelId, runs, passes, passRate: passes / runs, summary }, null, 2),
    );
    expect(usage.filter((entry) => entry.source === "step")).toHaveLength(3 * runs);
  },
  330_000 * Math.max(1, Number(process.env["FACTORY_LEARNING_COMPARISON_RUNS"] ?? "1")),
);

test.skipIf(process.env["FACTORY_LEARNING_MODEL_LIVE"] !== "1")(
  "configured work reviewer proposes an exact version-bound edit for an observed bad method",
  async () => {
    const before =
      "For configuration questions, reuse the previous cached value even when the pinned current source differs.";
    const target = {
      kind: "skill" as const,
      id: "10000000-0000-4000-8000-000000000020",
      revisionId: "10000000-0000-4000-8000-000000000021",
      version: 1,
      field: "instructions" as const,
    };
    const source: LearningCase = {
      id: "calibration:method-edit",
      projectId: "10000000-0000-4000-8000-000000000001",
      ownerId: null,
      developerOnly: false,
      activity: "research",
      outcome: "completed",
      settledAt: new Date().toISOString(),
      evidence: [
        {
          id: "method:task",
          kind: "task",
          body: "Report the retry limit from the pinned current settings.ts. Do not change code.",
          truncated: false,
        },
        {
          id: "method:source",
          kind: "artifact",
          body: "Actual pinned settings.ts source: export const MAX_RETRIES = 3;",
          truncated: false,
        },
        {
          id: "method:config",
          kind: "configuration",
          body: `The actually loaded Skill contained this exact instruction: ${before}`,
          truncated: false,
        },
        {
          id: "method:outcome",
          kind: "outcome",
          body: "The Assistant read the pinned source but obeyed the cached-value instruction and answered 5, the prior cached limit. A correction reread the same source and returned 3. The recorded wrong value followed this loaded instruction, not a missing source.",
          truncated: false,
        },
      ],
      targets: [{ target, evidenceId: "method:config", text: before, truncated: false }],
    };
    const usage: UsageEntry[] = [];
    const modelId = modelEnvironment().planningModelId;
    const result = await reviewWork({
      cases: [source],
      modelId,
      connection: projectModelConnection(),
      signal: AbortSignal.timeout(120_000),
      authorize: async () => {},
      usage: {
        begin: async () => {},
        record: async (entry) => {
          usage.push(entry);
        },
        settle: async () => {},
      },
    });
    await mkdir(".factory/test-results/learning-live", { recursive: true });
    await Bun.write(
      ".factory/test-results/learning-live/exact-edit.json",
      JSON.stringify({ modelId, result, usage }, null, 2),
    );
    expect(result.cases[0]?.fulfillment).toBe("problem");
    const edit = result.proposals.find((proposal) => proposal.edit)?.edit;
    expect(edit?.target).toEqual(target);
    expect(before).toContain(edit?.before ?? "missing edit");
    expect(edit?.after).not.toBe(edit?.before);
  },
  150_000,
);
