import { z } from "zod";
import type { createDatabase } from "#db/client";
import type { createIdentityConfiguration } from "../access/api";
import type { createRuntimeAccess } from "../access/runtime";
import type { createChangeWriterController } from "../access/writer-api";
import { CommandError } from "../command-error";
import type { createProjectService } from "../projects/service";
import type { createRuntimeController } from "../runtime/api";
import type { RuntimeHub } from "../runtime/transport-api";
import type {
  createWorkspaceCollaboration,
  createWorkspaceContainerFiles,
  createWorkspaceSharing,
  createWorkspaceSubmission,
} from "../workspace/api";
import type { createWorkspaceCommands } from "../workspace/execution-api";
import type { createWorkspaceSourceController } from "../workspace/source-api";

export type ExternalMCPServices = {
  database: ReturnType<typeof createDatabase>;
  factoryAuth: ReturnType<typeof createIdentityConfiguration>;
  factoryOrigin: string;
  workspaceSources: ReturnType<typeof createWorkspaceSourceController>;
  workspaceSharing: ReturnType<typeof createWorkspaceSharing>;
  workspaceCommands: ReturnType<typeof createWorkspaceCommands>;
  workspaceFiles: ReturnType<typeof createWorkspaceContainerFiles>;
  workspaceCollaboration: ReturnType<typeof createWorkspaceCollaboration>;
  workspaceSubmission: ReturnType<typeof createWorkspaceSubmission>;
  writers: Pick<ReturnType<typeof createChangeWriterController>, "view" | "takeOver">;
  runtimeController: ReturnType<typeof createRuntimeController>;
  runtimeAccess: ReturnType<typeof createRuntimeAccess>;
  runtimeHub: RuntimeHub;
  projects: ReturnType<typeof createProjectService>;
};

export type ExternalMCPActor = Awaited<
  ReturnType<ExternalMCPServices["factoryAuth"]["mcpSession"]>
>;

export type RegisterExternalTool = <T extends z.ZodObject>(
  name: string,
  description: string,
  schema: T,
  write: boolean,
  execute: (value: z.output<T>) => Promise<unknown>,
) => void;

export type ExternalToolContext = {
  services: ExternalMCPServices;
  actor: ExternalMCPActor;
  request: Request;
  tool: RegisterExternalTool;
};

export const workspaceInput = z.strictObject({ workspaceID: z.uuid() });
export const lifecycleInput = workspaceInput.extend({ requestID: z.uuid() });

export const startWorkspaceInput = z
  .strictObject({
    workspaceID: z.uuid().optional(),
    projectID: z.uuid().optional(),
    requestID: z.uuid(),
  })
  .refine(
    (value) => [value.workspaceID, value.projectID].filter(Boolean).length === 1,
    "Choose exactly one Workspace or Project",
  );

export const openWorkspaceInput = z
  .strictObject({
    workspaceID: z.uuid().optional(),
    projectID: z.uuid().optional(),
    changeID: z.uuid().optional(),
  })
  .refine(
    (value) => [value.workspaceID, value.projectID, value.changeID].filter(Boolean).length === 1,
    "Choose exactly one Workspace, Project or Ticket Change",
  );

export const fileInput = workspaceInput.extend({
  path: z.string().max(4096),
  location: z.enum(["checkout", "container"]).default("checkout"),
});

export type OpenWorkspaceTarget =
  | { target: "workspace"; workspaceID: string }
  | { target: "change"; changeID: string }
  | { target: "project"; projectID: string };

export function resolveOpenWorkspaceTarget(
  input: z.output<typeof openWorkspaceInput>,
): OpenWorkspaceTarget {
  if (input.workspaceID) return { target: "workspace", workspaceID: input.workspaceID };
  if (input.changeID) return { target: "change", changeID: input.changeID };
  if (input.projectID) return { target: "project", projectID: input.projectID };
  throw new CommandError("invalid", "Choose exactly one Workspace, Project or Ticket Change");
}

export type StartWorkspaceTarget =
  | { target: "workspace"; workspaceID: string; requestID: string }
  | { target: "project"; projectID: string; requestID: string };

export function resolveStartWorkspaceTarget(
  input: z.output<typeof startWorkspaceInput>,
): StartWorkspaceTarget {
  if (input.workspaceID)
    return { target: "workspace", workspaceID: input.workspaceID, requestID: input.requestID };
  if (input.projectID)
    return { target: "project", projectID: input.projectID, requestID: input.requestID };
  throw new CommandError("invalid", "Choose exactly one Workspace or Project");
}
