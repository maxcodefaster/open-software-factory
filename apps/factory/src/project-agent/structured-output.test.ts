import { expect, test } from "bun:test";
import { z } from "zod";
import { planningDesign } from "../../../../test/fixtures/technical-planning";
import {
  isStructuredOutputFailure,
  ProjectAgentOutputError,
  parseProjectAgentOutput,
  projectAgentProviderOutputFor,
} from "./structured-output";

const id = crypto.randomUUID();
const answer = (citation: unknown) => ({
  output: { kind: "answer", message: "An observed fact.[^1]", citations: [citation] },
});

test("an explicitly commissioned Ticket interview cannot finish with only a promise", () => {
  const noProposal = {
    output: {
      kind: "answer",
      message: "The Ticket is already detailed. I will prepare the proposal for confirmation.",
      citations: [],
    },
  };
  expect(projectAgentProviderOutputFor("plan", true).safeParse(noProposal).success).toBe(false);
  expect(() => parseProjectAgentOutput(noProposal, "plan", false, true)).toThrow();
  // Ordinary questions in Planning remain ordinary answers. Only the explicit
  // Interview action requires the next question or a confirmable proposal.
  expect(parseProjectAgentOutput(noProposal, "plan").kind).toBe("answer");
  const interview = projectAgentProviderOutputFor("plan", true);
  expect(
    interview.safeParse({
      output: {
        kind: "question",
        message: "One consequential decision is missing.",
        question: { type: "free-text", prompt: "Which supported architecture is required?" },
        citations: [],
      },
    }).success,
  ).toBe(true);
  expect(
    interview.safeParse({
      output: {
        kind: "requirement",
        message: "Confirm the supplied scope.",
        ticket: { title: "Native repository checks", description: "" },
        requirement: {
          summary: "Run the existing repository checks on both supported Linux architectures.",
          acceptanceCriteria: ["The existing checks pass natively on ARM64 and AMD64."],
          nonGoals: [],
        },
        citations: [],
      },
    }).success,
  ).toBe(true);
});

test("generated choice questions retain their type and always admit a custom answer", () => {
  const choices = ["single-select", "multi-select"].map((type) => ({
    type,
    prompt: "Who should receive the summary?",
    options: [
      { id: "developer", label: "Developer" },
      { id: "manager", label: "Project manager" },
    ],
    allowCustom: false,
  }));
  const free = {
    type: "free-text",
    prompt: "What stays out of scope?",
    placeholder: "Describe it",
  };
  for (const question of choices) {
    const result = parseProjectAgentOutput({ output: { kind: "question", question } }, "plan");
    expect(result.kind).toBe("question");
    if (result.kind === "question") {
      expect(result.question).toMatchObject({ ...question, allowCustom: true });
    }
  }
  const result = parseProjectAgentOutput(
    { output: { kind: "round", questions: [...choices, free] } },
    "plan",
  );
  expect(result.kind).toBe("round");
  if (result.kind === "round") {
    expect(result.questions).toMatchObject([
      { ...choices[0], allowCustom: true },
      { ...choices[1], allowCustom: true },
      free,
    ]);
    expect(result.questions[2]).not.toHaveProperty("allowCustom");
  }
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

test("only the explicit technical task admits a Technical Design output", () => {
  const technical = {
    output: {
      kind: "technical-design",
      message: "Review the design.",
      design: planningDesign,
      citations: [],
    },
  };
  expect(projectAgentProviderOutputFor("plan").safeParse(technical).success).toBe(false);
  expect(
    projectAgentProviderOutputFor("investigate", false, false, true).safeParse(technical).success,
  ).toBe(false);
  expect(parseProjectAgentOutput(technical, "plan", true).kind).toBe("technical-design");
});

test("validation diagnostics retain only schema paths and codes, never provider data", () => {
  const failure = z.object({ design: z.string() }).safeParse({ design: 1 });
  const error = new ProjectAgentOutputError({
    id: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
    cause: failure.error,
    request: { authorization: "private-provider-token", body: "private model input" },
  });
  expect(error.diagnostic).toBe("design: invalid_type");
  expect(error.retainedMessage).toContain("design: invalid_type");
  expect(error.retainedMessage).not.toContain("private");
  expect(JSON.stringify(error)).not.toContain("private");
  expect(error.message).toBe(
    "The Project Agent returned an invalid response. Your input is saved.",
  );
});

test("retained validation diagnostics fit compact turn outcomes", () => {
  const failure = z
    .object({ design: z.object({ validation: z.array(z.object({ check: z.string() })) }) })
    .safeParse({ design: { validation: Array.from({ length: 200 }, () => ({ check: 42 })) } });
  const error = new ProjectAgentOutputError(failure.error);
  expect(error.diagnostic).toContain("design.validation.0.check: invalid_type");
  expect(error.diagnostic.length).toBeLessThanOrEqual(1024);
  expect(error.retainedMessage.length).toBeLessThan(2000);
});
