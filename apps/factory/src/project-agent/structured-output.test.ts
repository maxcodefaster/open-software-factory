import { expect, test } from "bun:test";
import { z } from "zod";
import {
  isStructuredOutputFailure,
  parseProjectAgentOutput,
  projectAgentProviderOutputFor,
} from "./structured-output";

const id = crypto.randomUUID();
const answer = (citation: unknown) => ({
  output: { kind: "answer", message: "An observed fact.[^1]", citations: [citation] },
});

test.each(["ticket", "epic", "knowledge"])(
  "%s citations accept a nullable unused reference without Git metadata",
  (source) => {
    const result = parseProjectAgentOutput(
      answer({ source, id, label: "Observed source", reference: null }),
      "investigate",
    );
    expect(result.citations).toEqual([{ source, id, label: "Observed source" }]);
    expect(() =>
      parseProjectAgentOutput(
        answer({ source, id, label: "Observed source", commitSha: "", path: "" }),
        "investigate",
      ),
    ).toThrow();
  },
);

test("Code citations keep exact provenance and reject missing or invented empty metadata", () => {
  const source = {
    source: "code" as const,
    id,
    label: "Observed file",
    reference: 1,
    commitSha: "a".repeat(40),
    path: "src/app.ts",
  };
  expect(parseProjectAgentOutput(answer(source), "investigate").citations).toEqual([source]);
  for (const change of [
    { commitSha: null },
    { path: null },
    { commitSha: "" },
    { path: "" },
    { commitSha: "main" },
  ])
    expect(() =>
      parseProjectAgentOutput(answer({ ...source, ...change }), "investigate"),
    ).toThrow();
});

test("provider output never widens research authority or bypasses domain refinements", () => {
  expect(
    projectAgentProviderOutputFor("investigate").safeParse({
      output: { kind: "round", questions: [{ type: "free-text", prompt: "Change?" }] },
    }).success,
  ).toBe(false);
  expect(() =>
    parseProjectAgentOutput(
      {
        output: {
          kind: "epic",
          message: "A grouping",
          citations: [],
          proposal: {
            epic: { title: "Goal" },
            members: ["first", "second"].map((key) => ({
              key,
              title: key,
              existingTicketId: id,
              expectedVersion: 1,
              requirement: { summary: key, acceptanceCriteria: ["Observable outcome"] },
            })),
          },
        },
      },
      "plan",
    ),
  ).toThrow("Reuse each Ticket once");
});

test("known structured-output rejection is distinct from transport and provider uncertainty", () => {
  expect(
    isStructuredOutputFailure({
      id: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
      details: { private: "not exposed" },
    }),
  ).toBe(true);
  expect(isStructuredOutputFailure({ id: "STRUCTURED_OUTPUT_OBJECT_UNDEFINED" })).toBe(true);
  expect(isStructuredOutputFailure(z.string().safeParse(1).error)).toBe(true);
  expect(isStructuredOutputFailure(new Error("Connection lost"))).toBe(false);
  expect(isStructuredOutputFailure({ id: "API_CALL_ERROR", statusCode: 503 })).toBe(false);
});
