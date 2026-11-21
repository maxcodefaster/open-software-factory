import type { ReplayInput } from "./replay-contract";

export async function replayPlanning(input: ReplayInput) {
  const { replayPlanningWithModel } = await import("./replay-engine");
  return replayPlanningWithModel(input);
}
