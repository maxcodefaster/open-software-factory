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
  const unverified = structuredClone(passed);
  fixtureValue(unverified.cases[0], "unverified.cases[0]").verification = "unknown";
  expect(comparisonPassed(plan, unverified)).toBe(false);
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
