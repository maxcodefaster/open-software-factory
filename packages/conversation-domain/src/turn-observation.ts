import { z } from "zod";
import { agentTurnStates } from "./agent-turn";
import { conversationModeInput } from "./conversation";
import { turnUsageInput, unavailableTurnUsage } from "./turn-usage";

export const projectAgentProgressInput = z.object({
  phase: z.enum(["guidance", "thinking", "searching", "reading", "validating"]),
  completedLookups: z.number().int().nonnegative().max(12),
});
export type ProjectAgentProgress = z.infer<typeof projectAgentProgressInput>;

// Public read projection. Execution leases, commands and instruction bodies stay server-side.
export const turnObservationInput = z.object({
  id: z.uuid(),
  commandId: z.uuid(),
  state: z.enum(agentTurnStates),
  summary: z.string().nullable().optional(),
  engine: z.enum(["mastra", "opencode"]),
  mode: conversationModeInput,
  modelId: z.string(),
  usage: turnUsageInput.default(unavailableTurnUsage),
  progress: projectAgentProgressInput.optional(),
  skills: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        revision: z.number().int().positive(),
        digest: z.string(),
        loaded: z.boolean(),
      }),
    )
    .max(16),
});
export type TurnObservation = z.infer<typeof turnObservationInput>;
