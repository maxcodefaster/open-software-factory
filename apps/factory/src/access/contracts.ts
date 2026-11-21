import { z } from "zod";

export const sessionSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  systemManager: z.boolean().default(false),
});

export type Session = z.infer<typeof sessionSchema>;
