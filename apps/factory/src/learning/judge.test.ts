import { expect, mock, test } from "bun:test";
import {
  type LearningResult,
  LearningResultRejected,
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
import { fixtureValue } from "../../../../test/fixtures/value";

let modelResult: LearningResult;
mock.module("./judge-engine", () => ({ reviewWorkWithModel: async () => modelResult }));
const { reviewWork } = await import("./judge");

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
