import { z } from "zod";
import {
  type TurnUsage,
  unavailableTurnUsage,
} from "../../../../packages/conversation-domain/src/turn-usage";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const providerUsage = z
  .object({
    raw: z.object({
      raw: z.union([
        z
          .object({
            prompt_tokens: count,
            completion_tokens: count,
            prompt_tokens_details: z
              .object({ cached_tokens: count, cache_write_tokens: count })
              .optional(),
            completion_tokens_details: z.object({ reasoning_tokens: count }).optional(),
          })
          .refine(
            (value) => value.prompt_tokens !== undefined || value.completion_tokens !== undefined,
          ),
        z
          .object({
            input_tokens: count,
            output_tokens: count,
            input_tokens_details: z.object({ cached_tokens: count }).optional(),
            output_tokens_details: z.object({ reasoning_tokens: count }).optional(),
          })
          .transform((value) => ({
            prompt_tokens: value.input_tokens,
            completion_tokens: value.output_tokens,
            prompt_tokens_details: value.input_tokens_details,
            completion_tokens_details: value.output_tokens_details,
          })),
      ]),
    }),
  })
  .transform(({ raw: { raw } }) => ({
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens,
    cachedInputTokens: raw.prompt_tokens_details?.cached_tokens,
    cacheCreationInputTokens:
      raw.prompt_tokens_details && "cache_write_tokens" in raw.prompt_tokens_details
        ? raw.prompt_tokens_details.cache_write_tokens
        : undefined,
  }));

// Pinned Mastra wraps the chat SDK usage, which wraps the original provider counters.
// SDK normalization and Mastra totals synthesize zeros. Only the raw counters prove presence.
export function observeProjectUsage(steps: readonly { usage: unknown }[]): TurnUsage {
  const observations = steps.flatMap(({ usage }) => {
    const parsed = providerUsage.safeParse(usage);
    if (
      !parsed.success ||
      !Object.values(parsed.data).some((value) => value !== undefined && value > 0)
    )
      return [];
    return [parsed.data];
  });
  if (!observations.length) return unavailableTurnUsage();
  const sum = (field: keyof z.infer<typeof providerUsage>) => {
    if (
      observations.length !== steps.length ||
      observations.some((usage) => usage[field] === undefined)
    )
      return null;
    const total = observations.reduce((total, usage) => total + (usage[field] ?? 0), 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  return {
    source: "mastra-provider",
    coverage: observations.length === steps.length ? "complete" : "partial",
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    cacheReadTokens: sum("cachedInputTokens"),
    cacheWriteTokens: sum("cacheCreationInputTokens"),
    observedAt: new Date().toISOString(),
  };
}
