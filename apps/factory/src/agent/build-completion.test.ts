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

test("completion instructions preserve the exact approved array positions", () => {
  const instructions = buildCompletionInstructions(9);
  expect(instructions).toContain("Do not split, merge, reorder or renumber criteria");
  const example = instructions
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((value) => value?.status === "ready");
  expect(example.criteria.map((item: { criterion: number }) => item.criterion)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  for (const count of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => buildCompletionInstructions(count)).toThrow();
});

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

test("an incomplete handoff identifies missing criteria and failing checks", () => {
  const completion = { prompt: buildCompletionInstructions(9), criteria: 9 };
  const criteria = Array.from({ length: 7 }, (_, index) => ({
    criterion: index + 1,
    evidence: `Observed criterion ${index + 1}.`,
  }));
  const missing = assessBuildCompletion(completion, text({ ...ready, criteria }));
  expect(missing.ready).toBe(false);
  expect("error" in missing && missing.error).toContain("missing evidence for criteria 8, 9");
  const split = assessBuildCompletion(
    completion,
    text({
      ...ready,
      criteria: Array.from({ length: 10 }, (_, index) => ({
        criterion: index + 1,
        evidence: `The model split approved criterion 4 and shifted the later entries ${index + 1}.`,
      })),
    }),
  );
  expect("error" in split && split.error).toContain(
    "criterion evidence includes numbers outside the approved specification",
  );
  const failing = assessBuildCompletion(
    prompt,
    text({ ...ready, checks: [{ command: "npm run check", passed: false }] }),
  );
  expect("error" in failing && failing.error).toContain("checks still failing: npm run check");
  const unfinished = assessBuildCompletion(
    prompt,
    text({ ...ready, remaining: ["Inspect the 390px layout"] }),
  );
  expect("error" in unfinished && unfinished.error).toContain(
    "unfinished work: Inspect the 390px layout",
  );
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
