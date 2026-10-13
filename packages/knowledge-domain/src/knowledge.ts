import { z } from "zod";

export const knowledgePageInput = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  body: z.string().min(1).max(120_000),
  sources: z.array(z.string().min(1).max(500)).max(64),
});

export const knowledgeEditInput = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(120_000),
});
