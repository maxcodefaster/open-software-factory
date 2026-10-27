import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { factoryFunction, factoryFunctionContext } from "./context";

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
