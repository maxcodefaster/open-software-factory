import { z } from "zod";
import type { LLMStepResult } from "@mastra/core/stream";
import {
  usageCounters,
  unknownCounters,
  type UsageCounters,
} from "../../../../packages/conversation-domain/src/usage";
import type { UsageEntry } from "./journal";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const rawInput = z.object({ raw: z.unknown().optional() }).passthrough();
const chat = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count, cache_write_tokens: count }).optional(),
  completion_tokens_details: z.object({ reasoning_tokens: count }).optional(),
  prompt_cache_hit_tokens: count,
  prompt_cache_miss_tokens: count,
});
const messages = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
  output_tokens_details: z.object({ thinking_tokens: count, reasoning_tokens: count }).optional(),
  input_tokens_details: z.object({ cached_tokens: count }).optional(),
});

export function mastraCounters(usage: unknown, provider: string): UsageCounters {
  // Only provider-native counters establish presence. SDK normalization supplies missing zeros.
  let raw = usage;
  for (let depth = 0; depth < 3; depth++) {
    const wrapper = rawInput.safeParse(raw);
    if (!wrapper.success || wrapper.data.raw === undefined) break;
    raw = wrapper.data.raw;
  }
  const value = provider === "anthropic" ? messages.safeParse(raw) : chat.safeParse(raw);
  if (provider === "anthropic" && value.success && "input_tokens" in value.data) {
    const result = messages.parse(raw);
    return usageCounters.parse({
      input: result.input_tokens ?? null,
      output: result.output_tokens ?? null,
      cacheRead: result.cache_read_input_tokens ?? null,
      cacheWrite: result.cache_creation_input_tokens ?? null,
      reasoning: result.output_tokens_details?.thinking_tokens ?? null,
    });
  }
  const parsedChat = chat.safeParse(raw);
  const parsedResponse = messages.safeParse(raw);
  const input = parsedChat.success ? parsedChat.data.prompt_tokens : undefined;
  const output = parsedChat.success ? parsedChat.data.completion_tokens : undefined;
  const response = parsedResponse.success ? parsedResponse.data : undefined;
  const cached = parsedChat.success
    ? (parsedChat.data.prompt_tokens_details?.cached_tokens ??
      parsedChat.data.prompt_cache_hit_tokens)
    : undefined;
  const read = cached ?? response?.input_tokens_details?.cached_tokens;
  // Native OpenAI/DeepSeek do not charge cache writes. Absent cache reads are still unknown.
  const write = parsedChat.success
    ? (parsedChat.data.prompt_tokens_details?.cache_write_tokens ?? 0)
    : 0;
  const total = input ?? response?.input_tokens;
  const fresh = parsedChat.success ? parsedChat.data.prompt_cache_miss_tokens : undefined;
  const nonCached =
    fresh ??
    (total !== undefined && read !== undefined && total >= read + write
      ? total - read - write
      : null);
  return usageCounters.parse({
    input: nonCached,
    output: output ?? response?.output_tokens ?? null,
    cacheRead: read ?? null,
    cacheWrite: write,
    reasoning: parsedChat.success
      ? (parsedChat.data.completion_tokens_details?.reasoning_tokens ??
        response?.output_tokens_details?.reasoning_tokens ??
        null)
      : (response?.output_tokens_details?.reasoning_tokens ?? null),
  });
}

export type MastraUsageSink = {
  begin(): Promise<void>;
  record(entry: UsageEntry): Promise<void>;
  settle(outcome: UsageEntry["outcome"]): Promise<void>;
};
export function createMastraUsage(
  sink: MastraUsageSink | undefined,
  provider: string,
  signal: AbortSignal,
) {
  let ordinal = 0;
  let started = false;
  let finished = false;
  return {
    async begin() {
      await sink?.begin();
      started = true;
    },
    async onStepFinish(step: Pick<LLMStepResult, "usage" | "finishReason">) {
      if (!started) throw new Error("Model usage must be admitted before inference");
      const outcome = step.finishReason === "error" ? "failed" : "completed";
      await sink?.record({
        eventID: `step:${++ordinal}`,
        source: "step",
        outcome,
        counters: mastraCounters(step.usage, provider),
        occurredAt: new Date().toISOString(),
      });
    },
    async finish(failed = false) {
      if (!started || finished) return;
      const outcome = signal.aborted ? "interrupted" : failed ? "failed" : "completed";
      // Errors can happen after a paid step or before a provider reports usage. Preserve the gap.
      if (ordinal === 0 || failed || signal.aborted)
        await sink?.record({
          eventID: "unobserved",
          source: "unobserved",
          outcome,
          counters: unknownCounters(),
          occurredAt: new Date().toISOString(),
        });
      await sink?.settle(outcome);
      finished = true;
    },
  };
}
