export type ReserveRole = "staging" | "verification";
export type ReserveState = "creating" | "ready" | "assigned" | "retiring" | "deleted";

export interface ExecutionSlot {
  readonly id: string;
  readonly role: ReserveRole;
  readonly state: ReserveState;
  readonly runtimeHostImage: string;
  readonly namespace: string;
  readonly namespaceUID: string | null;
  readonly podUID: string | null;
  readonly claimUID: string | null;
  readonly expiresAt: string;
  readonly assignedAttemptID: string | null;
  readonly factoryboxProfile?: unknown;
  readonly factoryboxIdentity?: unknown;
  readonly factoryboxPreparation?: unknown;
  readonly factoryboxStartAttempted?: boolean;
}

export interface ReservePolicy {
  readonly readyPerRole: number;
  readonly maxSlots: number;
  readonly creationConcurrency: number;
  readonly maxExecutionSlots: number;
  readonly expiryMS: number;
  readonly preparationMS: number;
  readonly retryMS: number;
}

export const defaultReservePolicy: ReservePolicy = {
  readyPerRole: 1,
  maxSlots: 2,
  creationConcurrency: 1,
  maxExecutionSlots: 16,
  expiryMS: 15 * 60_000,
  preparationMS: 3 * 60_000,
  retryMS: 30_000,
};

export function requireReservePolicy(value: ReservePolicy): ReservePolicy {
  if (
    Object.values(value).some((number) => !Number.isSafeInteger(number) || number < 0) ||
    value.readyPerRole > 4 ||
    value.maxSlots > 8 ||
    value.maxSlots < 2 * value.readyPerRole ||
    value.creationConcurrency < 1 ||
    value.creationConcurrency > 2 ||
    value.maxExecutionSlots < value.maxSlots ||
    value.maxExecutionSlots < 1 ||
    value.maxExecutionSlots > 256 ||
    value.expiryMS < 60_000 ||
    value.expiryMS > 60 * 60_000 ||
    value.preparationMS < 1_000 ||
    value.preparationMS > value.expiryMS ||
    value.retryMS < 1_000
  )
    throw new Error("Execution reserve policy is outside its bounded limits");
  return value;
}

export function reserveIdentity(id: string) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))
    throw new Error("Invalid execution slot identity");
  return {
    id,
    namespace: `factory-reserve-${id.replaceAll("-", "").slice(0, 12)}`,
    podName: "slot",
  };
}

export function reserveCreationCount(
  policy: ReservePolicy,
  counts: {
    readonly matching: number;
    readonly creating: number;
    readonly spare: number;
    readonly execution: number;
  },
) {
  return Math.max(
    0,
    Math.min(
      policy.readyPerRole - counts.matching,
      policy.creationConcurrency - counts.creating,
      policy.maxSlots - counts.spare,
      policy.maxExecutionSlots - counts.spare - counts.execution,
    ),
  );
}
