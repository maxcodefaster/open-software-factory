import type { CodingReasoning } from "#conversation-domain/model-settings";
import type { ModelUsageSink, ResolvedModelConnection } from "./inference-contracts";

export type ModelProbeInput = {
  connection: ResolvedModelConnection;
  modelId: string;
  signal: AbortSignal;
  role?: "planning" | "build";
  usageSink?: ModelUsageSink;
  reasoningEffort?: CodingReasoning;
};
