import { z } from "zod";

export const conversationReadInput = z.strictObject({
  ticketId: z.uuid().optional(),
  contextId: z.union([z.uuid(), z.literal("original")]).optional(),
});
