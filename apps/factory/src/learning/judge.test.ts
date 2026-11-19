import { expect, mock, test } from "bun:test";
import {
  type LearningResult,
  LearningResultRejected,
  validateLearningResult,
} from "../../../../packages/conversation-domain/src/learning";
import {
  comparisonCases,
  learningComparisonPlan,
} from "../../../../packages/conversation-domain/src/learning-comparison";
import {
  comparisonAfter,
  comparisonBefore,
  comparisonExample,
} from "../../../../test/fixtures/learning-comparison";
import { calibratedResult } from "../../../../test/fixtures/learning";
import { fixtureValue } from "../../../../test/fixtures/value";
import { calibrationCases, calibrationPassed } from "./calibration";

let modelResult: LearningResult;
mock.module("./judge-engine", () => ({ reviewWorkWithModel: async () => modelResult }));
const { reviewWork, workReviewInstructions } = await import("./judge");

const target = {
  kind: "skill",
  id: crypto.randomUUID(),
  revisionId: crypto.randomUUID(),
  version: 1,
  field: "instructions",
} as const;
const edit = { target, before: comparisonBefore, after: comparisonAfter };
const example = comparisonExample(crypto.randomUUID(), edit);
const plan = learningComparisonPlan.parse({
  edit,
  baselineTarget: target,
  before: comparisonBefore,
  after: comparisonAfter,
  cases: example.cases,
  problemIds: example.content.caseIds,
  controlId: fixtureValue(example.cases[2], "example.cases[2]").id,
  candidateFirst: false,
  activationVersion: 1,
});
const answers = {
  answers: example.cases.map((item) => ({ caseId: item.id, body: "An actual replay answer." })),
};
const cases = comparisonCases(plan, [answers, answers]);
const input = {
  cases,
  modelId: "model",
  connection: {} as never,
  signal: AbortSignal.timeout(1_000),
  authorize: async () => {},
  usage: { begin: async () => {}, record: async () => {}, settle: async () => {} },
};

function gradedWithCrossArmFinding(): LearningResult {
  return {
    cases: cases.map((item) => ({
      caseId: item.id,
      fulfillment: "supported",
      verification: "supported",
      rework: "unknown",
      explanation: "Observed response compared to the artifact.",
      evidenceIds: [fixtureValue(item.evidence.at(-1), "item.evidence.at(-1)").id],
    })),
    findings: [
      {
        caseIds: ["replay:0:0"],
        // The candidate arm's response belongs to another admitted case.
        evidenceIds: ["response:0:0", "response:1:0"],
        dimension: "method",
        cause: "The baseline used the cached value; the candidate used the pinned source.",
        observation: "The two arms answered differently for the same task.",
      },
    ],
    proposals: [],
  };
}

test("a comparison grades the replayed responses and keeps no finding that cites the other arm", async () => {
  modelResult = gradedWithCrossArmFinding();
  const graded = await reviewWork({ ...input, comparison: true });
  expect(graded.cases).toHaveLength(6);
  expect(graded.findings).toEqual([]);
  expect(graded.proposals).toEqual([]);
});

test("a work review still rejects a finding that cites evidence from an unlisted case", async () => {
  modelResult = gradedWithCrossArmFinding();
  const rejected = await reviewWork(input).catch((cause: unknown) => cause);
  expect(rejected).toBeInstanceOf(LearningResultRejected);
  expect((rejected as Error).message).toBe("Work review cited unobserved evidence");
});

test("a comparison still rejects a verdict that cites evidence outside its own case", async () => {
  modelResult = gradedWithCrossArmFinding();
  fixtureValue(modelResult.cases[0], "modelResult.cases[0]").evidenceIds = ["response:1:0"];
  await expect(reviewWork({ ...input, comparison: true })).rejects.toBeInstanceOf(
    LearningResultRejected,
  );
});

test("the judge contract limits findings to observed problems, not healthy confirmations", () => {
  expect(workReviewInstructions).toContain(
    "Findings are actionable observed problems, not praise or confirmations of correct work.",
  );
  expect(workReviewInstructions).toContain(
    "Keep positive observations in case explanations; return no findings when no problem is observed.",
  );
});

test("the judge contract separates product evidence from verification claims", () => {
  expect(workReviewInstructions).toContain(
    "For implementation work, judge the requested product behavior separately from its checks.",
  );
  expect(workReviewInstructions).toContain(
    "If implementation and behavior evidence are missing, fulfillment is unknown.",
  );
  expect(workReviewInstructions).toContain(
    "required checks passed is a verification problem, not by itself proof of a product defect.",
  );
  expect(workReviewInstructions).toContain(
    "An observed product defect is a fulfillment problem even if checks pass.",
  );
  expect(workReviewInstructions).not.toContain("calibration:");
});

test("the scope calibration states a product requirement separately from required checks", () => {
  const item = fixtureValue(
    calibrationCases.find((item) => item.id === "calibration:scope-mismatch"),
    "scope calibration",
  );
  const task = fixtureValue(
    item.evidence.find((source) => source.kind === "task"),
    "scope task",
  );
  expect(task.body).toContain(
    "Product requirement: a dismiss button hides the notification banner.",
  );
  expect(task.body).toContain(
    "Verification requirement: run unit and browser checks on the exact candidate.",
  );
  expect(item.evidence.some((source) => source.body.includes("Its browser job was skipped."))).toBe(
    true,
  );
  expect(
    item.evidence.some((source) =>
      source.body.includes("UI implementation itself has no observed defect or correctness proof."),
    ),
  ).toBe(true);
});

test.each(["healthy", "false-alarm", "coverage-preserved"])(
  "even a positive finding about %s still fails calibration",
  (id) => {
    const source = fixtureValue(
      calibrationCases.find((item) => item.id === `calibration:${id}`),
      id,
    );
    const observed = fixtureValue(
      source.evidence.find((item) => item.kind === "artifact" || item.kind === "outcome"),
      "observed work",
    );
    const result = calibratedResult();
    result.findings.push({
      caseIds: [source.id],
      evidenceIds: [observed.id],
      dimension: "verification",
      cause: "No defect is observed.",
      observation: "The observed work satisfies the requirement.",
    });
    expect(calibrationPassed(validateLearningResult(result, calibrationCases))).toBe(false);
  },
);

test("calibration keeps missing-evidence and observed-defect thresholds unchanged", () => {
  for (const [id, field, expected] of [
    ["missing", "fulfillment", "unknown"],
    ["missing", "verification", "unknown"],
    ["scope-mismatch", "fulfillment", "unknown"],
    ["scope-mismatch", "verification", "problem"],
    ["defect", "fulfillment", "problem"],
    ["green-diagnostics", "fulfillment", "problem"],
    ["green-diagnostics", "verification", "problem"],
    ["coverage-lost", "fulfillment", "problem"],
    ["coverage-lost", "verification", "problem"],
  ] as const) {
    for (const verdict of ["supported", "problem", "unknown"] as const) {
      const result = calibratedResult();
      fixtureValue(
        result.cases.find((item) => item.caseId === `calibration:${id}`),
        id,
      )[field] = verdict;
      expect(calibrationPassed(validateLearningResult(result, calibrationCases))).toBe(
        verdict === expected,
      );
    }
  }
});

test.each(["false-alarm", "coverage-preserved"])(
  "healthy %s still cannot be graded as avoidable rework",
  (id) => {
    const result = calibratedResult();
    fixtureValue(
      result.cases.find((item) => item.caseId === `calibration:${id}`),
      id,
    ).rework = "avoidable";
    expect(calibrationPassed(validateLearningResult(result, calibrationCases))).toBe(false);
  },
);
