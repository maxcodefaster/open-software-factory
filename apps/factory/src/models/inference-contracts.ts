import type { ModelProvider } from "../../../../packages/conversation-domain/src/model-connection";
import type { UsageCounters } from "../../../../packages/conversation-domain/src/usage";

export type ResolvedModelConnection = {
  provider?: ModelProvider;
  baseURL?: string;
  apiKey: string;
};

// Model calls report steps or an unobserved gap; journal-only events stay with Usage.
export type ModelUsageOutcome = "completed" | "failed" | "interrupted";
export type ModelUsageSink = {
  begin(): Promise<void>;
  record(entry: {
    eventID: string;
    source: "step" | "unobserved";
    outcome: ModelUsageOutcome;
    counters: UsageCounters;
    occurredAt: string;
  }): Promise<void>;
  settle(outcome: ModelUsageOutcome): Promise<void>;
};
