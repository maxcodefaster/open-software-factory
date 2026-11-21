import type { WikiGenerationOutput } from "../../../../packages/knowledge-domain/src/generation";
import type { WikiGenerationInput } from "./generation-contracts";

export async function generateWiki(input: WikiGenerationInput): Promise<WikiGenerationOutput> {
  input.signal.throwIfAborted();
  const { generateWiki: generate } = await import("./generation-workflow");
  input.signal.throwIfAborted();
  return generate(input);
}
