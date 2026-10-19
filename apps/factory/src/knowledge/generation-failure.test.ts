import { expect, test } from "bun:test";
import { ModelExecutionBoundError } from "../models/execution-policy";
import {
  wikiGenerationFailureMessage,
  WikiSourceEvidenceError,
  WikiTopicPlanError,
  WikiTopicQualityError,
  WikiHumanEditConflict,
  WikiStructuredResultError,
  rejectedWikiStructuredResult,
} from "./generation-failure";

test("Wiki diagnostics distinguish known failures without exposing model prose or paths", () => {
  const fallback = "Existing safe failure";
  expect(
    wikiGenerationFailureMessage(new WikiTopicPlanError("private source path"), fallback),
  ).toContain("topic plan");
  expect(
    wikiGenerationFailureMessage(
      new WikiTopicQualityError("private-slug", ["private prose"]),
      fallback,
    ),
  ).toContain("source and quality checks");
  expect(
    wikiGenerationFailureMessage(new WikiSourceEvidenceError(["private/path"]), fallback),
  ).toContain("source it had not inspected");
  expect(wikiGenerationFailureMessage(new WikiHumanEditConflict(), fallback)).toContain(
    "not overwritten",
  );
  expect(wikiGenerationFailureMessage(new WikiStructuredResultError(), fallback)).toContain(
    "required format",
  );
  for (const cause of [
    new WikiTopicPlanError("private source path"),
    new WikiTopicQualityError("private-slug", ["private prose"]),
    new WikiSourceEvidenceError(["private/path"]),
    new Error("Authorization: private provider key"),
  ])
    expect(wikiGenerationFailureMessage(cause, fallback)).not.toContain("private");
});

test("a Wiki correction receives only a recognized, complete and bounded rejected structured result", () => {
  const value = {
    findings: [{ claim: "x".repeat(1201), paths: ["src/app.ts"] }],
    uncertainties: [],
  };
  const failure = {
    id: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
    details: { value: JSON.stringify(value) },
  };
  expect(rejectedWikiStructuredResult(failure)).toEqual(value);
  expect(
    rejectedWikiStructuredResult({ ...failure, id: "UNKNOWN_PROVIDER_FAILURE" }),
  ).toBeUndefined();
  expect(
    rejectedWikiStructuredResult({ ...failure, details: { value: "incomplete {" } }),
  ).toBeUndefined();
  expect(
    rejectedWikiStructuredResult({
      ...failure,
      details: { value: "x".repeat(1024 * 1024 + 1) },
    }),
  ).toBeUndefined();
});

test("Wiki diagnostics preserve serialized execution bounds but bound error traversal", () => {
  const bound = new ModelExecutionBoundError("requests");
  expect(wikiGenerationFailureMessage({ cause: { name: bound.name } }, "fallback")).toContain(
    "No additional provider request",
  );
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(wikiGenerationFailureMessage(cycle, "fallback")).toBe("fallback");
});
