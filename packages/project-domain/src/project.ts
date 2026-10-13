import { z } from "zod";

const repositoryPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "Path must stay within the Project repository",
  });

const projectInput = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{1,62}$/),
    name: z.string().trim().min(1).max(200),
    repositoryUrl: z.url(),
    defaultBranch: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !value.startsWith("-") && !value.includes("..")),
    devcontainerPath: repositoryPath,
  })
  .strict();

export function createRegisterProjectInput(localRepositoryOrigin?: string) {
  return projectInput.extend({
    repositoryUrl: z.url().refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        (url.protocol === "https:" ||
          url.protocol === "file:" ||
          url.origin === localRepositoryOrigin) &&
        !url.username &&
        !url.password
      );
    }, "Repository URL must use HTTPS, the configured local repository origin, or a local file URL without credentials"),
  });
}

export const registerProjectInput = createRegisterProjectInput();

export type RegisterProjectInput = z.infer<typeof registerProjectInput>;

export interface Project extends RegisterProjectInput {
  readonly id: string;
  readonly createdAt: string;
}
