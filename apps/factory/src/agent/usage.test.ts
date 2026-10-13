import { expect, test } from "bun:test";
import { observeProjectUsage } from "../project-agent/usage";
import { observeOpenCodeUsage } from "./opencode-usage";
import { createUsageObservations } from "./usage-observations";

const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } };
const user = (id: string) => ({ id, type: "user", time: { created: 1 } });
const assistant = (id: string, usage: unknown = tokens) => ({
  id,
  type: "assistant",
  time: { created: 2, completed: 3 },
  tokens: usage,
});
const projectStep = (usage: unknown) => ({ usage: { raw: { raw: usage } } });

test("OpenCode usage belongs to the exact input interval, never another turn or Session total", () => {
  const messages = [
    assistant("new"),
    user("new-input"),
    assistant("old-a"),
    assistant("old-b"),
    user("old-input"),
    assistant("previous"),
  ];
  expect(observeOpenCodeUsage(messages, "old-input")).toMatchObject({
    source: "opencode-provider",
    coverage: "complete",
    inputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 4,
    cacheReadTokens: 6,
    cacheWriteTokens: 0,
  });
  expect(observeOpenCodeUsage(messages, "new-input").inputTokens).toBe(10);
  expect(observeOpenCodeUsage(messages, "outside-page")).toMatchObject({
    source: "unavailable",
    inputTokens: null,
    outputTokens: null,
  });
});

test("OpenCode missing, initialized, invalid and unfinished usage is not fabricated zero", () => {
  const missing = { id: "missing", type: "assistant", time: { created: 2, completed: 3 } };
  for (const message of [
    missing,
    assistant("zero", { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    assistant("invalid", { ...tokens, input: -1 }),
    { ...assistant("running"), time: { created: 2 } },
  ]) {
    expect(observeOpenCodeUsage([message, user("input")], "input").inputTokens).toBeNull();
  }
  expect(observeOpenCodeUsage([assistant("known"), missing, user("input")], "input")).toMatchObject(
    { coverage: "partial", inputTokens: 10 },
  );
});

test("Mastra reports actual step measurements, unknown absent counters and partial coverage", () => {
  expect(
    observeProjectUsage([
      projectStep({ prompt_tokens: 12, completion_tokens: 4 }),
      projectStep({ prompt_tokens: 3, completion_tokens: 2 }),
    ]),
  ).toMatchObject({
    source: "mastra-provider",
    coverage: "complete",
    inputTokens: 15,
    outputTokens: 6,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  for (const usage of [
    {},
    { prompt_tokens: 0, completion_tokens: 0 },
    { prompt_tokens: NaN, completion_tokens: 1 },
    { prompt_tokens: -1, completion_tokens: 1 },
  ]) {
    expect(observeProjectUsage([projectStep(usage)])).toMatchObject({
      source: "unavailable",
      inputTokens: null,
    });
  }
  expect(
    observeProjectUsage([
      projectStep({ prompt_tokens: 10, completion_tokens: 2 }),
      projectStep({}),
    ]),
  ).toMatchObject({ coverage: "partial", inputTokens: null, outputTokens: null });
});

test("Mastra does not trust SDK-synthesized zero counters", () => {
  expect(
    observeProjectUsage([
      projectStep({
        input_tokens: 20,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 2 },
      }),
    ]),
  ).toMatchObject({
    inputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
  });
  expect(
    observeProjectUsage([
      {
        usage: {
          inputTokens: 12,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          raw: { raw: { prompt_tokens: 12 } },
        },
      },
    ]),
  ).toMatchObject({
    source: "mastra-provider",
    inputTokens: 12,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  expect(
    observeProjectUsage([
      projectStep({
        prompt_tokens: 12,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      }),
    ]),
  ).toMatchObject({
    inputTokens: 12,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("usage observations expire, are bounded, and do not survive a new owner", () => {
  let now = 0;
  const observations = createUsageObservations(() => now);
  const usage = observeProjectUsage([projectStep({ prompt_tokens: 3, completion_tokens: 2 })]);
  for (let index = 0; index < 129; index++) observations.record(String(index), usage);
  expect(observations.get("0").inputTokens).toBeNull();
  expect(observations.get("128").inputTokens).toBe(3);
  expect(createUsageObservations().get("128").inputTokens).toBeNull();
  now = 30 * 60_000;
  expect(observations.get("128").inputTokens).toBeNull();
});
