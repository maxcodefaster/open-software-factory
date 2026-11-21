export type SubstrateCapacityConfiguration = {
  database: string;
  workerSelector: Record<string, string>;
  profile: string;
  runtime: {
    version: { attributes: readonly { key: string; value: string }[] };
  };
};

export type SubstrateCapacityResources = { cpuMilli: number; memoryMiB: number };

export interface SubstrateCapacity {
  requireReady(resources: SubstrateCapacityResources): Promise<void>;
}
