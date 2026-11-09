import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { factoryFunction, factoryFunctionContext } from "./context";
import { registerSharedReads } from "./shared-reads";
import { workspaceShareInput } from "../../../../packages/workspace-domain/src/sharing";
import { workspaceSubmissionInput } from "../workspace/submission";

export const inspectWorkspaceSubmission = createServerFn({ method: "POST" })
  .validator((args: [workspaceID: string]) => args)
  .handler(async ({ data: [workspaceID] }) =>
    factoryFunction(() => {
      const context = factoryFunctionContext();
      return context.workspaces.inspectSubmission(context.actorID, z.uuid().parse(workspaceID));
    }),
  );
export const submitWorkspace = createServerFn({ method: "POST" })
  .validator((args: [input: unknown]) => args)
  .handler(async ({ data: [input] }) =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.submit(context.actorID, workspaceSubmissionInput.parse(input));
    }),
  );

export const getAvailableWorkspaces = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) =>
    factoryFunction(() => {
      const context = factoryFunctionContext();
      return context.workspaces.available(context.actorID, z.uuid().parse(projectID));
    }),
  );
export const getWorkspaceCollaboration = createServerFn({ method: "POST" })
  .validator((args: [workspaceID: string]) => args)
  .handler(async ({ data: [workspaceID] }) =>
    factoryFunction(() => {
      const context = factoryFunctionContext();
      return context.workspaces.collaboration(context.actorID, z.uuid().parse(workspaceID));
    }),
  );
export const enableWorkspaceCollaboration = createServerFn({ method: "POST" })
  .validator((args: [workspaceID: string, commandID: string]) => args)
  .handler(async ({ data: [workspaceID, commandID] }) =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.enableCollaboration(
        context.actorID,
        z.uuid().parse(workspaceID),
        z.uuid().parse(commandID),
      );
    }),
  );

export const getWorkspaceSharing = createServerFn({ method: "POST" })
  .validator((args: [workspaceID: string]) => args)
  .handler(async ({ data: [workspaceID] }) =>
    factoryFunction(() => {
      const context = factoryFunctionContext();
      return context.workspaces.getSharing(context.actorID, z.uuid().parse(workspaceID));
    }),
  );

export const shareWorkspace = createServerFn({ method: "POST" })
  .validator((args: [input: unknown]) => args)
  .handler(async ({ data: [input] }) =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.share(context.actorID, workspaceShareInput.parse(input));
    }),
  );

export const getWorkspaceSource = createServerFn({ method: "POST" })
  .validator((args: [workspaceID: string]) => args)
  .handler(async ({ data: [workspaceID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(workspaceID),
        context = factoryFunctionContext();
      return context.workspaces.getSource(context.actorID, id);
    });
  });

export const ensureWorkspaceSource = createServerFn({ method: "POST" })
  .validator((args: [workspaceID: string]) => args)
  .handler(async ({ data: [workspaceID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(workspaceID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.ensureSource(context.actorID, id);
    });
  });

export const ensurePersonalSource = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.ensurePersonalSource(context.actorID, id);
    });
  });

export const ensureChangeSource = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.ensureChangeSource(context.actorID, id);
    });
  });

export const stopWorkspaceSource = createServerFn({ method: "POST" })
  .validator((args: [workspaceID: string]) => args)
  .handler(async ({ data: [workspaceID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(workspaceID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.stopSource(context.actorID, id);
    });
  });

export const getDeveloperIDE = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.workspaces.getEditor(context.actorID);
    });
  });

export const ensureDeveloperIDE = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.ensureEditor(context.actorID, id);
    });
  });

export const stopDeveloperIDE = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.workspaces.stopEditor(context.actorID);
    });
  });

registerSharedReads(
  inspectWorkspaceSubmission,
  getWorkspaceSource,
  getDeveloperIDE,
  getWorkspaceSharing,
  getAvailableWorkspaces,
  getWorkspaceCollaboration,
);
