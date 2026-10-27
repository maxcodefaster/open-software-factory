import { expect, test } from "bun:test";
import {
  learningBatchDue,
  sampleLearningCase,
  validateLearningResult,
  learningEdit,
  applyLearningEdit,
} from "./learning";
import {
  calibrationCases,
  calibrationPassed,
} from "../../../apps/factory/src/learning/calibration";
import { calibratedResult } from "../../../test/fixtures/learning";
import { fixtureValue } from "../../../test/fixtures/value";

test("concrete improvements are bound to observed revisions and exact unique passages", () => {
  const target = {
    kind: "skill" as const,
    id: "10000000-0000-4000-8000-000000000001",
    revisionId: "10000000-0000-4000-8000-000000000002",
    version: 1,
    field: "instructions" as const,
  };
  const edit = learningEdit.parse({ target, before: "  foo", after: "  $&" });
  expect(edit.before).toBe("  foo");
  expect(applyLearningEdit("Start\n  foo\nEnd", edit)).toBe("Start\n  $&\nEnd");
  expect(() => applyLearningEdit("foo foo", { before: "foo", after: "bar" })).toThrow(
    "unique passage",
  );
  expect(() => applyLearningEdit("newer human writing", { before: "foo", after: "bar" })).toThrow(
    "no longer matches",
  );
  const cases = structuredClone(calibrationCases);
  fixtureValue(cases[0], "cases[0]").targets = [
    { target, evidenceId: "healthy:source", text: "Start\n  foo\nEnd", truncated: false },
  ];
  const result = calibratedResult();
  result.proposals = [
    {
      title: "Use an exact passage",
      target: "skill",
      caseIds: [fixtureValue(cases[0], "cases[0]").id],
      evidenceIds: ["healthy:source"],
      change: "Replace one instruction.",
      expectedEffect: "Avoid repeated work.",
      validation: "Use a healthy comparison.",
      edit,
    },
  ];
  expect(validateLearningResult(result, cases).proposals[0]?.edit).toEqual(edit);
  const changed = structuredClone(result);
  fixtureValue(
    fixtureValue(changed.proposals[0], "changed.proposals[0]").edit,
    "changed.proposals[0]!.edit",
  ).target.revisionId = "10000000-0000-4000-8000-000000000003";
  expect(() => validateLearningResult(changed, cases)).toThrow("observed exact revision");
  fixtureValue(changed.proposals[0], "changed.proposals[0]").edit = edit;
  fixtureValue(changed.proposals[0], "changed.proposals[0]").target = "input";
  expect(() => validateLearningResult(changed, cases)).toThrow("declared target");
});
test("work-review calibration checks real defects, healthy work, false alarms and missing evidence", () => {
  const result = validateLearningResult(calibratedResult(), calibrationCases);
  expect(calibrationPassed(result)).toBe(true);
  for (const index of [0, 1, 2, 3]) {
    const changed = structuredClone(result);
    fixtureValue(changed.cases[index], "changed.cases[index]").fulfillment =
      index === 1 ? "supported" : "problem";
    expect(calibrationPassed(changed)).toBe(false);
  }
});
test("the reviewer cannot invent identities, omit cases or use a task as outcome evidence", () => {
  const result = calibratedResult();
  const missing = structuredClone(result);
  missing.cases.pop();
  expect(() => validateLearningResult(missing, calibrationCases)).toThrow("every admitted case");
  const duplicate = structuredClone(result);
  duplicate.cases[1] = fixtureValue(duplicate.cases[0], "duplicate.cases[0]");
  expect(() => validateLearningResult(duplicate, calibrationCases)).toThrow("every admitted case");
  const invented = structuredClone(result);
  fixtureValue(invented.cases[0], "invented.cases[0]").evidenceIds = ["not-observed"];
  expect(() => validateLearningResult(invented, calibrationCases)).toThrow("unobserved evidence");
  const task = structuredClone(result);
  fixtureValue(task.cases[0], "task.cases[0]").evidenceIds = ["healthy:task"];
  expect(() => validateLearningResult(task, calibrationCases)).toThrow("Missing work evidence");
  const finding = structuredClone(result);
  finding.findings.push({
    caseIds: ["calibration:healthy"],
    evidenceIds: ["healthy:task"],
    dimension: "method",
    cause: "Guess",
    observation: "Unsupported",
  });
  expect(() => validateLearningResult(finding, calibrationCases)).toThrow("observed work");
});
test("sampling is stable, every failed outcome is eligible, and quiet projects reach the age trigger", () => {
  const selected = Array.from({ length: 1000 }, (_, index) =>
    sampleLearningCase(`turn:${index}`, "completed"),
  );
  expect(selected.filter(Boolean).length).toBeGreaterThan(150);
  expect(selected.filter(Boolean).length).toBeLessThan(250);
  expect(selected).toEqual(
    Array.from({ length: 1000 }, (_, index) => sampleLearningCase(`turn:${index}`, "completed")),
  );
  for (const state of ["failed", "interrupted", "unknown"] as const)
    expect(sampleLearningCase("any", state)).toBe(true);
  const now = Date.parse("2026-10-26T12:00:00Z");
  const young = {
    ...fixtureValue(calibrationCases[0], "calibrationCases[0]"),
    settledAt: new Date(now).toISOString(),
  };
  expect(learningBatchDue([], now)).toBe(false);
  expect(learningBatchDue([young], now)).toBe(false);
  expect(learningBatchDue(Array(6).fill(young), now)).toBe(true);
  expect(
    learningBatchDue(
      [{ ...young, settledAt: new Date(now - 24 * 60 * 60_000).toISOString() }],
      now,
    ),
  ).toBe(true);
});
