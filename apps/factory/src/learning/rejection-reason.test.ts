import { expect, test } from "bun:test";
import {
  LearningResultRejected,
  validateLearningResult,
} from "../../../../packages/conversation-domain/src/learning";
import { calibratedResult } from "../../../../test/fixtures/learning";
import { fixtureValue } from "../../../../test/fixtures/value";
import { calibrationCases } from "./calibration";
import { learningRejectionReason } from "./rejection-reason";

const generic =
  "The model's review did not match the evidence it was given, so it was discarded. It will not be repeated automatically.";
const predicates = [
  "Work review must account for every admitted case exactly once",
  "Unknown work review case",
  "Work review cited unobserved evidence",
  "Missing work evidence cannot establish a review verdict",
  "A learning finding needs observed work",
  "An improvement edit must change its declared target",
  "An improvement edit must name an observed exact revision and text",
];

test.each(predicates)("retains only the exact semantic predicate: %s", (message) => {
  const cause = new LearningResultRejected(message, { cause: new Error("PRIVATE-CAUSE") });
  cause.stack = "PRIVATE-STACK";
  for (const prefix of [generic, "The comparison grade was discarded."]) {
    const reason = learningRejectionReason(cause, prefix);
    expect(reason).toBe(`${prefix} Diagnostic: ${message}.`);
    expect(reason.length).toBeLessThan(512);
    expect(reason).not.toContain("PRIVATE");
  }
});

test.each([
  "PRIVATE-MODEL-PROSE",
  "Work review cited unobserved evidence PRIVATE-REFERENCE",
  "Work review cited unobserved evidence\nPRIVATE-ANALYSIS",
  " Work review cited unobserved evidence",
  "Work review cited unobserved evidence.",
  '{"issues":[{"message":"PRIVATE-ZOD-OUTPUT","path":["PRIVATE-REFERENCE"]}]}',
  "PRIVATE".repeat(4096),
])("unknown or extended messages keep the generic reason", (message) => {
  const cause = new LearningResultRejected(message, {
    cause: new LearningResultRejected("Work review cited unobserved evidence"),
  });
  expect(learningRejectionReason(cause, generic)).toBe(generic);
});

test("untyped errors and forged names never acquire semantic diagnostic authority", () => {
  for (const cause of [
    new Error("Work review cited unobserved evidence"),
    { name: "LearningResultRejected", message: "Work review cited unobserved evidence" },
    "Work review cited unobserved evidence",
    null,
  ])
    expect(learningRejectionReason(cause, generic)).toBe(generic);
});

test("the maintained validator's actual rejection retains only its allowed predicate", () => {
  const value = calibratedResult();
  fixtureValue(value.cases[0], "first verdict").evidenceIds = ["PRIVATE-UNOBSERVED-REFERENCE"];
  let rejected: unknown;
  try {
    validateLearningResult(value, calibrationCases);
  } catch (cause) {
    rejected = cause;
  }
  expect(rejected).toBeInstanceOf(LearningResultRejected);
  expect(learningRejectionReason(rejected, generic)).toBe(
    `${generic} Diagnostic: Work review cited unobserved evidence.`,
  );
});
