import { z } from "zod";

export const implementationInput = z
  .object({
    commandId: z.uuid(),
    revisionId: z.uuid(),
  })
  .strict();
