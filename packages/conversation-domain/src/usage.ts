import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const price = z.number().finite().nonnegative().max(1_000_000).nullable();
export const usagePurpose = z.enum([
  "coding",
  "research",
  "requirements",
  "wiki",
  "setup",
  "probe",
]);
export type UsagePurpose = z.infer<typeof usagePurpose>;

// Billing buckets are disjoint. Reasoning is a detail of output, not another charge.
export const usageCounters = z.object({
  input: count.nullable(),
  output: count.nullable(),
  cacheRead: count.nullable(),
  cacheWrite: count.nullable(),
  reasoning: count.nullable(),
});
export type UsageCounters = z.infer<typeof usageCounters>;
export const usageRate = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    source: z.enum(["catalogue", "contract"]),
    fetchedAt: z.iso.datetime(),
    tiers: z
      .array(
        z.object({
          above: count,
          input: price,
          output: price,
          cacheRead: price,
          cacheWrite: price,
        }),
      )
      .min(1)
      .max(8),
  })
  .superRefine((value, context) => {
    if (
      value.tiers[0]?.above !== 0 ||
      value.tiers.some(
        (tier, index) => index > 0 && tier.above <= (value.tiers[index - 1]?.above ?? 0),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Rates need a base tier and ascending context thresholds",
      });
  });
export type UsageRate = z.infer<typeof usageRate>;
export const unknownCounters = (): UsageCounters => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
});

export function estimateUsage(counters: UsageCounters, rate: UsageRate | null) {
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const context = [counters.input, counters.cacheRead, counters.cacheWrite];
  const contextKnown = context.every((value) => value !== null);
  const contextSize = context.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const tier = rate?.tiers.findLast((tier) => contextSize > tier.above || tier.above === 0);
  if (!tier || (rate && rate.tiers.length > 1 && !contextKnown))
    return { nanoUSD: null, knownNanoUSD: "0", complete: false };
  let known = 0n;
  let complete = true;
  for (const field of fields) {
    const tokens = counters[field];
    const cost = tier[field];
    if (tokens === null || (tokens > 0 && cost === null)) {
      complete = false;
      continue;
    }
    // Rates are USD per million tokens. Round each observed bucket up to a nanodollar.
    const scaled = BigInt(Math.round((cost ?? 0) * 1_000_000_000));
    known += (BigInt(tokens) * scaled + 999_999n) / 1_000_000n;
  }
  return { nanoUSD: complete ? known.toString() : null, knownNanoUSD: known.toString(), complete };
}
