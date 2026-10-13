import { z } from "zod";

export const requirementContentInput = z
  .object({
    summary: z.string().trim().min(1).max(10_000),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
    nonGoals: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  })
  .strict();

export type RequirementContent = z.infer<typeof requirementContentInput>;
