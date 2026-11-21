import type {
  WikiGenerationOutput,
  WikiGenerationProgress,
  WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import type { ModelUsageSink, ResolvedModelConnection } from "../models/inference-contracts";

export type WikiGenerationInput = {
  name: string;
  commit: string;
  modelId: string;
  connection?: ResolvedModelConnection;
  pages: WikiPageSnapshot[];
  completedPageIDs?: readonly string[];
  inventory: Array<{ path: string; sha: string; size: number }>;
  changedPaths: string[];
  sources: Array<{ path: string; content: string }>;
  readFiles(paths: string[]): Promise<Array<{ path: string; content: string }>>;
  // A publisher that merges human edits supplies the same pure projection for checking.
  preparePublication?(output: WikiGenerationOutput): WikiGenerationOutput;
  publish?(output: WikiGenerationOutput): Promise<WikiPageSnapshot[]>;
  providerRequests?: { remaining: number };
  authorize?(): Promise<void>;
  progress?(progress: WikiGenerationProgress): Promise<void>;
  usageSink?(callID: string): ModelUsageSink;
  signal: AbortSignal;
};
