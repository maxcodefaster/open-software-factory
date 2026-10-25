import { z } from "zod";

export const mcpSharingInput = z
  .object({
    id: z.uuid(),
    revisionId: z.uuid(),
    target: z.enum(["project", "system"]),
    projectId: z.uuid().optional(),
  })
  .strict();
export const mcpGrantInput = z
  .object({
    projectId: z.uuid(),
    enabled: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
