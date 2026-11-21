import type { ModelProbeResult } from "../../../../packages/conversation-domain/src/model-connection";
import type { ModelProbeInput } from "./probe-contracts";

export async function probeModel(input: ModelProbeInput): Promise<ModelProbeResult> {
  // The engine retains the existing stopped/timeout result if this check is
  // cancelled while its first import is in progress.
  const { probeModel: probe } = await import("./probe-engine");
  return probe(input);
}
