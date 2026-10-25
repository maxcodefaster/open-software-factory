import type {
  WikiGenerationOutput,
  WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import type { ResolvedModelConnection } from "../models/native";
import type { MastraUsageSink } from "../usage/mastra";

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
  publish?(output: WikiGenerationOutput): Promise<WikiPageSnapshot[]>;
  providerRequests?: { remaining: number };
  usageSink?(callID: string): MastraUsageSink;
  signal: AbortSignal;
};

export async function generateWiki(input: WikiGenerationInput): Promise<WikiGenerationOutput> {
  input.signal.throwIfAborted();
  const { generateWiki: generate } = await import("./generation-workflow");
  input.signal.throwIfAborted();
  return generate(input);
}
