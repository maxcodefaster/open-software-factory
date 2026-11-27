import { z } from "zod";

const declaredProcess = z.strictObject({
  name: z.string(),
  label: z.string().optional(),
  command: z.array(z.string()).min(1),
});
export const stagingConfiguration = z.strictObject({
  actorTemplatePath: z.string().min(1),
  channels: z
    .array(
      z.strictObject({
        name: z.string(),
        kind: z.literal("app"),
        target: z.string(),
        healthPath: z.string(),
      }),
    )
    .min(1)
    .max(4),
  processes: z.array(declaredProcess).min(1).max(4),
});
