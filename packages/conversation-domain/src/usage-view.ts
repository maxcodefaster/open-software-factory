import { z } from "zod";
import { executionPolicy } from "./execution-policy";
import { usagePurpose } from "./usage";

const amount = z.string().regex(/^\d+$/);
const decision = z.object({
  allowed: z.boolean(),
  warning: z.boolean(),
  reason: z.string().nullable(),
  scope: z.uuid().nullable(),
  knownNanoUSD: amount,
  incomplete: z.boolean(),
  reset: z.iso.datetime().nullable(),
});
export const usageSummary = z.object({
  provider: z.string(),
  model: z.string(),
  purpose: usagePurpose,
  knownNanoUSD: amount,
  incomplete: z.boolean(),
  steps: z.number().int().nonnegative(),
  input: amount,
  output: amount,
  cacheRead: amount,
  cacheWrite: amount,
});
export const usageSettingsView = z.object({
  projectAgentTotal: z.object({ knownNanoUSD: amount, incomplete: z.boolean() }),
  factory: executionPolicy,
  project: executionPolicy.nullable(),
  effective: executionPolicy,
  timezone: z.string(),
  version: z.number().int().nonnegative(),
  canEdit: z.boolean(),
  allowed: z.boolean(),
  reason: z.string().nullable(),
  scopes: z.array(decision),
  summary: z.array(usageSummary),
  detailScope: z.enum(["factory", "project", "own"]),
  allocation: z.object({
    sandboxes: z.number().int().nonnegative(),
    cpuMilli: z.number().int().nonnegative(),
    memoryMiB: z.number().int().nonnegative(),
  }),
});
export type UsageSettingsView = z.infer<typeof usageSettingsView>;
export const currentComputeView = z.object({
  hasMore: z.boolean(),
  observations: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      startedAt: z.iso.datetime(),
      status: z.enum(["available", "stale", "unavailable", "forbidden"]),
      timestamp: z.iso.datetime().nullable(),
      cpuMilli: z.number().nonnegative().nullable(),
      memoryMiB: z.number().nonnegative().nullable(),
    }),
  ),
});
