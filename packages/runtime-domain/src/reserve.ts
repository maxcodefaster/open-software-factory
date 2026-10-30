export type ReserveRole = "staging" | "verification";
export type ReserveState = "creating" | "ready" | "assigned" | "retiring" | "deleted";

export interface ExecutionSlot {
  readonly id: string;
  readonly projectID?: string;
  readonly stagingAttemptID?: string;
  readonly revision?: string;
  readonly templateID?: string | null;
  readonly templateKey?: string;
  readonly seedExpiresAt?: string;
  readonly projectRecipe?: unknown;
  readonly sourceImportSHA256?: string | null;
  readonly sourceImportObservation?: unknown;
  readonly factoryboxForkRequest?: unknown;
  readonly factoryboxForkAttempted?: boolean;
  readonly factoryboxStandby?: unknown;
  readonly role: ReserveRole;
  readonly state: ReserveState;
  readonly runtimeHostImage: string;
  readonly workerRuntimeHostImage?: string | null;
  readonly workerDeclaration?: unknown;
  readonly namespace: string;
  readonly workerID: string;
  readonly admissionID?: string;
  readonly namespaceUID: string | null;
  readonly podUID: string | null;
  readonly claimUID: string | null;
  readonly expiresAt: string;
  readonly assignedAttemptID: string | null;
  readonly factoryboxProfile?: unknown;
  readonly factoryboxIdentity?: unknown;
  readonly factoryboxPreparation?: unknown;
  readonly factoryboxStartAttempted?: boolean;
  readonly factoryboxPauseAttempted?: boolean;
  readonly factoryboxResumeAttempted?: boolean;
  readonly factoryboxDeleteAttempted?: boolean;
}

export interface ReservePolicy {
  readonly readyTarget: number;
  readonly maxSlots: number;
  readonly creationConcurrency: number;
  readonly maxExecutionSlots: number;
  readonly expiryMS: number;
  readonly preparationMS: number;
  readonly retryMS: number;
}

export const defaultReservePolicy: ReservePolicy = {
  readyTarget: 2,
  maxSlots: 2,
  creationConcurrency: 1,
  maxExecutionSlots: 16,
  expiryMS: 15 * 60_000,
  // Initial image export and worker admission are part of cold preparation.
  // Match the lifecycle deadline instead of retiring a still-preparing worker.
  preparationMS: 420_000,
  retryMS: 30_000,
};

export function requireReservePolicy(value: ReservePolicy): ReservePolicy {
  if (
    Object.values(value).some((number) => !Number.isSafeInteger(number) || number < 0) ||
    value.readyTarget > 8 ||
    value.maxSlots > 8 ||
    value.maxSlots < value.readyTarget ||
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
      policy.readyTarget - counts.matching,
      policy.creationConcurrency - counts.creating,
      policy.maxSlots - counts.spare,
      policy.maxExecutionSlots - counts.spare - counts.execution,
    ),
  );
}
