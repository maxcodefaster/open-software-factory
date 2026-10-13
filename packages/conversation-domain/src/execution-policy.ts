import { z } from "zod";

const allowance = z.number().finite().nonnegative();
export const executionPolicy = z
  .object({
    codingUSD: allowance.max(10_000_000).nullable().default(null),
    finishPercent: allowance.max(100).default(10),
    sandboxes: z.number().int().nonnegative().max(256).nullable().default(null),
    cpuMilli: z.number().int().nonnegative().max(1_000_000).nullable().default(null),
    memoryMiB: z.number().int().nonnegative().max(10_000_000).nullable().default(null),
  })
  .strict();
export type ExecutionPolicy = z.output<typeof executionPolicy>;
export const defaultExecutionPolicy = (): ExecutionPolicy => executionPolicy.parse({});
export const executionPolicyCommand = z
  .object({
    commandID: z.uuid(),
    version: z.number().int().nonnegative(),
    policy: executionPolicy,
    timezone: z
      .string()
      .max(100)
      .optional()
      .refine((value) => {
        if (!value) return true;
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Use a valid installation timezone"),
  })
  .strict();

export function effectiveExecutionPolicy(
  factory: ExecutionPolicy,
  project: ExecutionPolicy | null,
) {
  const min = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : Math.min(a, b);
  return {
    codingUSD: min(factory.codingUSD, project?.codingUSD ?? null),
    finishPercent: Math.min(factory.finishPercent, project?.finishPercent ?? factory.finishPercent),
    sandboxes: min(factory.sandboxes, project?.sandboxes ?? null),
    cpuMilli: min(factory.cpuMilli, project?.cpuMilli ?? null),
    memoryMiB: min(factory.memoryMiB, project?.memoryMiB ?? null),
  } satisfies ExecutionPolicy;
}
export function tighterExecutionPolicy(factory: ExecutionPolicy, project: ExecutionPolicy) {
  return (
    (["codingUSD", "sandboxes", "cpuMilli", "memoryMiB"] as const).every(
      (key) => project[key] === null || factory[key] === null || project[key] <= factory[key],
    ) && project.finishPercent <= factory.finishPercent
  );
}
export function codingDecision(input: {
  policy: ExecutionPolicy;
  knownNanoUSD: bigint;
  unknown: boolean;
  continuation: boolean;
}) {
  const { policy, knownNanoUSD, unknown, continuation } = input;
  if (policy.codingUSD === null) return { allowed: true, warning: false, reason: null };
  const threshold = BigInt(Math.round(policy.codingUSD * 1_000_000_000));
  const ceiling = continuation
    ? threshold + (threshold * BigInt(Math.round(policy.finishPercent * 100))) / 10000n
    : threshold;
  const reason = unknown
    ? "accounting-incomplete"
    : knownNanoUSD >= ceiling
      ? continuation
        ? "finish-reserve-used"
        : "coding-budget-used"
      : null;
  return {
    allowed: reason === null,
    warning: unknown || knownNanoUSD * 100n >= threshold * 80n,
    reason,
  };
}
