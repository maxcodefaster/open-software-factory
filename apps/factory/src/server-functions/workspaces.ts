import { z } from "zod";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getWorkspaceSource(workspaceID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(workspaceID),
      context = factoryFunctionContext();
    return context.workspaces.getSource(context.actorID, id);
  });
}

export async function ensureWorkspaceSource(workspaceID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(workspaceID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.workspaces.ensureSource(context.actorID, id);
  });
}

export async function ensurePersonalSource(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.workspaces.ensurePersonalSource(context.actorID, id);
  });
}

export async function ensureChangeSource(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.workspaces.ensureChangeSource(context.actorID, id);
  });
}

export async function stopWorkspaceSource(workspaceID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(workspaceID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.workspaces.stopSource(context.actorID, id);
  });
}

export async function getDeveloperIDE() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.workspaces.getEditor(context.actorID);
  });
}

export async function ensureDeveloperIDE(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.workspaces.ensureEditor(context.actorID, id);
  });
}

export async function stopDeveloperIDE() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.workspaces.stopEditor(context.actorID);
  });
}
