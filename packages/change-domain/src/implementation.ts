import { z } from "zod";
import { codingReasoningInput } from "../../conversation-domain/src/model-settings";

export const implementationInput = z
  .object({
    commandId: z.uuid(),
    revisionId: z.uuid(),
    codingReasoning: codingReasoningInput.optional(),
  })
  .strict();
