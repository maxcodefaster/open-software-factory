import { expect, test } from "bun:test";
import { estimateUsage, usageRate, unknownCounters } from "./usage";

const base = usageRate.parse({
  provider: "provider",
  model: "model",
  source: "catalogue",
  fetchedAt: "2026-10-11T00:00:00.000Z",
  tiers: [{ above: 0, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
});
const counters = { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, reasoning: 40 };
test("pricing uses disjoint buckets and never charges output reasoning twice", () => {
  expect(estimateUsage(counters, base)).toEqual({
    nanoUSD: "729000",
    knownNanoUSD: "729000",
    complete: true,
  });
  expect(estimateUsage({ ...counters, reasoning: null }, base).nanoUSD).toBe("729000");
});
test("unknown counters and prices remain partial, explicitly free observed usage is zero", () => {
  expect(estimateUsage(unknownCounters(), base).nanoUSD).toBeNull();
  expect(estimateUsage(counters, null).nanoUSD).toBeNull();
  expect(estimateUsage({ ...counters, cacheRead: null }, base)).toEqual({
    nanoUSD: null,
    knownNanoUSD: "725000",
    complete: false,
  });
  expect(
    estimateUsage(
      { ...counters, input: 0 },
      { ...base, tiers: [{ ...base.tiers[0]!, input: null }] },
    ).complete,
  ).toBe(true);
  expect(
    estimateUsage(counters, {
      ...base,
      tiers: [{ above: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    }).nanoUSD,
  ).toBe("0");
});
test("context tier includes cache; missing context cannot select an apparently cheaper tier", () => {
  const rate = { ...base, tiers: [...base.tiers, { ...base.tiers[0]!, above: 100, input: 4 }] };
  expect(estimateUsage(counters, rate).nanoUSD).toBe("929000");
  expect(estimateUsage({ ...counters, input: 70 }, rate).nanoUSD).toBe("669000");
  expect(estimateUsage({ ...counters, cacheRead: null }, rate).nanoUSD).toBeNull();
  expect(usageRate.safeParse({ ...rate, tiers: rate.tiers.toReversed() }).success).toBe(false);
});
