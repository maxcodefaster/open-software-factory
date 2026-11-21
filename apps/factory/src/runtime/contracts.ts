import { z } from "zod";
import { optionalEnum, optionalString } from "../optional-values";

export const runtimeAttemptSchema = z.object({
  computeWait: optionalString,
  id: z.string(),
  projectId: z.string(),
  changeId: optionalString,
  workspaceId: optionalString,
  workspaceKind: optionalEnum(["personal", "ticket"]),
  runtimeKind: optionalEnum([
    "personal",
    "ticket",
    "staging",
    "verification",
    "prebuild",
    "publication",
  ]),
  currentStaging: z.boolean().optional(),
  ownerUserId: optionalString,
  state: z.string(),
  failure: optionalString,
  generation: z.string().optional(),
  revision: z.string().optional(),
  createdAt: optionalString,
  updatedAt: optionalString,
  readyAt: optionalString,
  appReadyAt: z.record(z.string(), z.string()).optional(),
  restoreFailed: z.boolean().optional(),
  native: z
    .object({
      engine: z.literal("substrate"),
      actorUID: z.uuid().optional(),
      state: z.string(),
      version: z.string().optional(),
      coldRestart: z.literal(true),
      portable: z.literal(false),
      sourceHandoff: z.enum(["pending", "confirmed-same-node"]),
    })
    .optional(),
});

export type RuntimeAttempt = z.infer<typeof runtimeAttemptSchema>;

export const appPreviewsSchema = z.object({
  previews: z.array(
    z.object({
      attemptID: z.string().optional(),
      projectID: z.string(),
      channel: z.string(),
      label: z.string(),
      state: z.string().optional(),
      port: z.number().int().optional(),
      process: z.object({ state: z.string(), exitCode: z.number().int().optional() }).optional(),
    }),
  ),
});

export type AppPreview = z.infer<typeof appPreviewsSchema>["previews"][number];

export type RuntimeDockTarget = {
  id: string;
  label: string;
  detail: string;
  attemptId?: string;
  changeId?: string;
  projectId?: string;
  appChannel?: string;
  workspaceId?: string;
};

export const attemptsResponseSchema = z.object({ attempts: z.array(runtimeAttemptSchema) });
