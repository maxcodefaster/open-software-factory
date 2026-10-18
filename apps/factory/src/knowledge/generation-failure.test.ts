import { expect, test } from "bun:test";
import { ModelExecutionBoundError } from "../models/execution-policy";
import {
  wikiGenerationFailureMessage,
  WikiSourceEvidenceError,
  WikiTopicPlanError,
  WikiTopicQualityError,
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
  for (const cause of [
    new WikiTopicPlanError("private source path"),
    new WikiTopicQualityError("private-slug", ["private prose"]),
    new WikiSourceEvidenceError(["private/path"]),
    new Error("Authorization: private provider key"),
  ])
    expect(wikiGenerationFailureMessage(cause, fallback)).not.toContain("private");
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
