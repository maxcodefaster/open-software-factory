import { z } from "zod";

export const newCodingConversationInput = z.strictObject({
  commandId: z.uuid(),
  contextId: z.uuid().nullable(),
});
