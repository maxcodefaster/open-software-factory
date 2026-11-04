import { expect, test } from "bun:test";
import {
  comparisonCases,
  comparisonPassed,
  learningComparisonPlan,
  replayableCase,
  validateReplayAnswers,
} from "./learning-comparison";
import {
  comparisonExample,
  comparisonBefore,
  comparisonAfter,
} from "../../../test/fixtures/learning-comparison";
import type { LearningEdit, LearningResult } from "./learning";
import { fixtureValue } from "../../../test/fixtures/value";

const target = {
  kind: "skill",
  id: crypto.randomUUID(),
  revisionId: crypto.randomUUID(),
  version: 1,
  field: "instructions",
} as const;
const edit: LearningEdit = { target, before: comparisonBefore, after: comparisonAfter };
const example = comparisonExample(crypto.randomUUID(), edit);
const plan = learningComparisonPlan.parse({
  edit,
  baselineTarget: edit.target,
  before: comparisonBefore,
  after: comparisonAfter,
  cases: example.cases,
  problemIds: example.content.caseIds,
  controlId: fixtureValue(example.cases[2], "example.cases[2]").id,
  candidateFirst: true,
  activationVersion: 1,
});
const answers = {
  answers: example.cases.map((item) => ({ caseId: item.id, body: "An actual replay answer." })),
};
const evidence = comparisonCases(plan, [answers, answers]);
const passed: LearningResult = {
  cases: evidence.map((item, index) => ({
    caseId: item.id,
    fulfillment: index === 3 || index === 4 ? "problem" : "supported",
    verification: "supported",
    rework: "unknown",
    explanation: "Observed artifact compared to answer.",
    evidenceIds: [fixtureValue(item.evidence.at(-1), "item.evidence.at(-1)").id],
  })),
  findings: [],
  proposals: [],
};
test("matched comparison requires both observed failures to reproduce, improve and retain the held-out healthy result", () => {
  expect(comparisonPassed(plan, passed)).toBe(true);
  for (const index of [0, 1, 2, 5]) {
    const regression = structuredClone(passed);
    fixtureValue(regression.cases[index], "regression.cases[index]").fulfillment = "unknown";
    expect(comparisonPassed(plan, regression)).toBe(false);
  }
  const unreproduced = structuredClone(passed);
  fixtureValue(unreproduced.cases[3], "unreproduced.cases[3]").fulfillment = "supported";
  expect(comparisonPassed(plan, unreproduced)).toBe(false);
});
test("a tool-free text replay is judged on its fulfilment verdicts, and verification is informational", () => {
  // A text replay executes nothing, so a judge honestly reports verification as unknown.
  // Requiring "supported" made a correct comparison fail depending on that wording.
  const unknownVerification = structuredClone(passed);
  for (const item of unknownVerification.cases) item.verification = "unknown";
  expect(plan.verification).toBe("text");
  expect(comparisonPassed(plan, unknownVerification)).toBe(true);
  // The relaxation never rescues a weak candidate, a baseline that did not fail, or a control regression.
  for (const index of [0, 1, 2]) {
    for (const fulfillment of ["unknown", "problem"] as const) {
      const weak = structuredClone(unknownVerification);
      fixtureValue(weak.cases[index], "weak.cases[index]").fulfillment = fulfillment;
      expect(comparisonPassed(plan, weak)).toBe(false);
    }
  }
  const avoidable = structuredClone(unknownVerification);
  fixtureValue(avoidable.cases[1], "avoidable.cases[1]").rework = "avoidable";
  expect(comparisonPassed(plan, avoidable)).toBe(false);
  const baselineHealthy = structuredClone(unknownVerification);
  fixtureValue(baselineHealthy.cases[4], "baselineHealthy.cases[4]").fulfillment = "supported";
  expect(comparisonPassed(plan, baselineHealthy)).toBe(false);
  const controlRegression = structuredClone(unknownVerification);
  fixtureValue(controlRegression.cases[5], "controlRegression.cases[5]").fulfillment = "problem";
  expect(comparisonPassed(plan, controlRegression)).toBe(false);
  // A judge-observed verification problem, such as a claimed but unrun check, still fails.
  const claimed = structuredClone(unknownVerification);
  fixtureValue(claimed.cases[0], "claimed.cases[0]").verification = "problem";
  expect(comparisonPassed(plan, claimed)).toBe(false);
});
test("a replay that claims executed verification stays strict", () => {
  const executed = { ...plan, verification: "executed" as const };
  expect(comparisonPassed(executed, passed)).toBe(true);
  for (const index of [0, 1, 2, 5]) {
    const unverified = structuredClone(passed);
    fixtureValue(unverified.cases[index], "unverified.cases[index]").verification = "unknown";
    expect(comparisonPassed(executed, unverified)).toBe(false);
    expect(comparisonPassed(plan, unverified)).toBe(true);
  }
  // Plans retained before this field existed are text replays.
  const { verification: _omitted, ...legacy } = plan;
  expect(learningComparisonPlan.parse(legacy).verification).toBe("text");
});
test("comparison is blind to arm names and excludes old outcome/configuration from judging new responses", () => {
  expect(evidence.every((item) => item.targets.length === 0)).toBe(true);
  expect(
    evidence.every(
      (item) => item.evidence.filter((source) => source.kind === "outcome").length === 1,
    ),
  ).toBe(true);
  expect(JSON.stringify(evidence)).not.toContain(comparisonBefore);
  expect(
    comparisonPassed(
      { ...plan, candidateFirst: false },
      {
        ...passed,
        cases: passed.cases.map((item) => ({
          ...item,
          caseId: item.caseId.replace(/replay:(0|1):/, (_, arm) => `replay:${1 - Number(arm)}:`),
        })),
      },
    ),
  ).toBe(true);
});
test("summaries, incomplete sources and non-research work cannot serve as an automatic replay", () => {
  const source = fixtureValue(example.cases[0], "example.cases[0]");
  expect(replayableCase(source)).toBe(true);
  expect(replayableCase({ ...source, activity: "build" })).toBe(false);
  expect(
    replayableCase({
      ...source,
      evidence: source.evidence.filter((item) => item.kind !== "artifact"),
    }),
  ).toBe(false);
  expect(
    replayableCase({
      ...source,
      evidence: source.evidence.map((item) => ({ ...item, truncated: true })),
    }),
  ).toBe(false);
  expect(() =>
    validateReplayAnswers(
      { answers: [answers.answers[0], answers.answers[0], answers.answers[2]] },
      example.cases,
    ),
  ).toThrow("once");
});
