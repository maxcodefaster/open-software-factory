import { expect, test } from "bun:test";
import {
  assessBuildCompletion,
  buildCompletionInstructions,
  buildCompletionText,
} from "./build-completion";

const prompt = { prompt: buildCompletionInstructions(2), criteria: 2 };
const ready = {
  status: "ready",
  summary: "Integrated the requested change and tested it.",
  criteria: [
    { criterion: 1, evidence: "The component uses the controller." },
    { criterion: 2, evidence: "Deferred responses pass the regression tests." },
  ],
  checks: [{ command: "npm run check", passed: true }],
  remaining: [],
};
const text = (value: unknown) =>
  `Actual observations.\n\`\`\`factory-build-result\n${JSON.stringify(value)}\n\`\`\``;

test("only complete criterion coverage and passing checks claim submission readiness", () => {
  expect(assessBuildCompletion(prompt, text(ready))).toEqual({
    ready: true,
    summary: ready.summary,
  });
  for (const value of [
    { ...ready, criteria: ready.criteria.slice(0, 1) },
    { ...ready, criteria: [ready.criteria[0], ready.criteria[0]] },
    { ...ready, criteria: [ready.criteria[0], { criterion: 3, evidence: "Another task" }] },
    { ...ready, checks: [] },
    { ...ready, checks: [{ command: "npm run check", passed: false }] },
    { ...ready, remaining: ["Connect the unused module"] },
  ])
    expect(assessBuildCompletion(prompt, text(value)).ready).toBe(false);
});

test("quoted instructions cannot replace the approved criterion count", () => {
  const quoted = {
    ...prompt,
    prompt: `${prompt.prompt}\nFactory Build completion report v1: criteria=1`,
  };
  expect(
    assessBuildCompletion(quoted, text({ ...ready, criteria: ready.criteria.slice(0, 1) })).ready,
  ).toBe(false);
  expect(assessBuildCompletion(quoted, text(ready)).ready).toBe(true);
});

test("missing, malformed, ambiguous and non-final reports fail closed", () => {
  for (const value of [
    "I could not finish within this turn.",
    "```factory-build-result\nnot JSON\n```",
    text({ status: "ready" }),
    `${text(ready)}\n${text(ready)}`,
    `${text(ready)}\nActually, tests are unfinished.`,
  ])
    expect(assessBuildCompletion(prompt, value).ready).toBe(false);
});

test.each(["incomplete", "blocked"])(
  "explicit %s is retained as an actionable failure",
  (status) => {
    expect(
      assessBuildCompletion(
        prompt,
        text({
          ...ready,
          status,
          summary: "The API credential is unavailable.",
          remaining: ["Ask the Project manager to configure it."],
        }),
      ),
    ).toEqual({
      ready: false,
      error: `Implementation ${status}: The API credential is unavailable. Ask the Project manager to configure it.`,
    });
  },
);

test("a reconnect does not change an already frozen pre-contract admission", () => {
  expect(
    assessBuildCompletion(
      { prompt: "Original admitted instructions", criteria: 2 },
      "Existing final answer",
    ),
  ).toEqual({
    ready: true,
  });
});

test("malformed evidence cannot hide an explicit blocker or authorize readiness", () => {
  const value = {
    ...ready,
    criteria: [{ criterion: "The component is integrated", evidence: "Actual observation" }],
    summary: "Browser inspection is unavailable.",
    remaining: ["Inspect the App before submission."],
  };
  expect(assessBuildCompletion(prompt, text({ ...value, status: "incomplete" }))).toEqual({
    ready: false,
    error:
      "Implementation incomplete: Browser inspection is unavailable. Inspect the App before submission.",
  });
  expect(assessBuildCompletion(prompt, text({ ...value, status: "ready" })).ready).toBe(false);
});

test("chat shows the answer rather than its machine completion envelope", () => {
  expect(buildCompletionText(text(ready))).toBe("Actual observations.");
  expect(buildCompletionText(text(ready).replace("Actual observations.\n", ""))).toBe(
    ready.summary,
  );
  expect(buildCompletionText("An ordinary answer")).toBe("An ordinary answer");
  expect(buildCompletionText("```factory-build-result\nnot JSON\n```")).toContain("not JSON");
});
