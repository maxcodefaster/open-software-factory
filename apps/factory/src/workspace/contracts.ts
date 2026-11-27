import { z } from "zod";

export const sourceWorkspaceViewSchema = z.object({
  workspaceID: z.uuid(),
  serviceID: z.string(),
  epoch: z.number().int().positive(),
  state: z.enum([
    "create-intended",
    "preparing",
    "ready",
    "paused",
    "failed",
    "stop-intended",
    "stopped",
  ]),
  failure: z.string().nullable(),
});
export type WorkspaceSourceView = z.infer<typeof sourceWorkspaceViewSchema>;

export const developerIDEViewSchema = z.object({
  serviceID: z.string(),
  epoch: z.number().int().positive(),
  state: z.enum(["create-intended", "preparing", "ready", "failed", "stop-intended", "stopped"]),
  failure: z.string().nullable(),
});
