import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import type { ModelUsageSink, ResolvedModelConnection } from "./inference-contracts";

export type ModelProbeInput = {
  connection: ResolvedModelConnection;
  modelId: string;
  signal: AbortSignal;
  role?: "planning" | "build";
  usageSink?: ModelUsageSink;
  reasoningEffort?: CodingReasoning;
};
