import { z } from "zod";
import { skillContentInput } from "../../../../packages/conversation-domain/src/skills";

export const skillImportInput = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string(),
            body: z.string(),
            encoding: z.enum(["utf8", "base64"]),
            executable: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(65),
    origin: skillContentInput.shape.origin.optional(),
  })
  .strict();
export const repositorySkillImportInput = z
  .object({
    repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    path: z
      .string()
      .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\/SKILL\.md$/)
      .refine((path) => !path.split("/").some((part) => part === "." || part === "..")),
  })
  .strict();
export const skillShareInput = z
  .object({
    id: z.uuid(),
    revisionId: z.uuid(),
    target: z.enum(["project", "system"]),
    projectId: z.uuid().optional(),
  })
  .strict();
