import { type PullRow } from "@rocicorp/zero";
import { z } from "zod";
import { desktopBackgroundKeys } from "../../../../packages/interface-domain/src/background";
import { type FactoryZeroSchema } from "../../../../packages/zero-schema/src";

export type Project = Pick<
  PullRow<"project", FactoryZeroSchema>,
  "id" | "slug" | "name" | "repositoryUrl" | "defaultBranch" | "devcontainerPath" | "createdAt"
>;

export type Epic = Pick<
  PullRow<"epic", FactoryZeroSchema>,
  "id" | "projectId" | "parentId" | "title" | "description" | "version"
>;

export const projectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  desktopBackgroundKey: z.enum(desktopBackgroundKeys),
  repositoryUrl: z.string(),
  defaultBranch: z.string(),
  devcontainerPath: z.string(),
  createdAt: z.union([z.number(), z.string()]),
});

export type ProjectSummary = z.infer<typeof projectSchema>;
