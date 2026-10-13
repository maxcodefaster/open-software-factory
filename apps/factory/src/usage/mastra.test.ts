import { expect, test } from "bun:test";
import { createMastraUsage, mastraCounters } from "./mastra";
import type { UsageEntry } from "./journal";

test("native raw counters split cache without trusting synthesized totals", () => {
  expect(mastraCounters({ inputTokens: 50, outputTokens: 0 }, "openai").output).toBeNull();
  expect(
    mastraCounters(
      {
        raw: {
          raw: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 30 },
            completion_tokens_details: { reasoning_tokens: 10 },
          },
        },
      },
      "openai",
    ),
  ).toEqual({ input: 70, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 10 });
  expect(
    mastraCounters(
      {
        raw: {
          raw: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
      },
      "anthropic",
    ),
  ).toEqual({ input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: null });
  expect(
    mastraCounters(
      {
        raw: {
          raw: { input_tokens: 100, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
        },
      },
      "openai",
    ).output,
  ).toBe(0);
  expect(
    mastraCounters({ raw: { raw: { prompt_tokens: 100, completion_tokens: 20 } } }, "openai").input,
  ).toBeNull();
});
test("failed and interrupted runs retain unknown gaps without transcripts", async () => {
  const entries: UsageEntry[] = [];
  const outcomes: string[] = [];
  let begin = 0;
  const abort = new AbortController();
  const usage = createMastraUsage(
    {
      begin: async () => {
        begin++;
      },
      record: async (value) => {
        entries.push(value);
      },
      settle: async (value) => {
        outcomes.push(value);
      },
    },
    "openai",
    abort.signal,
  );
  await usage.begin();
  abort.abort();
  await usage.finish(true);
  await usage.finish(true);
  expect(begin).toBe(1);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    source: "unobserved",
    outcome: "interrupted",
    counters: { input: null, output: null },
  });
  expect(outcomes).toEqual(["interrupted"]);
});
