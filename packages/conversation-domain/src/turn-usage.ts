import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const turnUsageInput = z.object({
  source: z.enum(["mastra-provider", "opencode-provider", "unavailable"]),
  coverage: z.enum(["complete", "partial", "unavailable"]),
  inputTokens: count,
  outputTokens: count,
  reasoningTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  observedAt: z.iso.datetime().nullable(),
});
export type TurnUsage = z.infer<typeof turnUsageInput>;

export function unavailableTurnUsage(): TurnUsage {
  return {
    source: "unavailable",
    coverage: "unavailable",
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    observedAt: null,
  };
}
