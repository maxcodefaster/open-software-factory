import { z } from "zod";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function startPersonalWorkspace(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.runtime.startPersonal(context.actorID, id);
  });
}
export async function startTicketWorkspace(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.runtime.startTicket(context.actorID, id);
  });
}
export async function stopRuntimeAttempt(attemptID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(attemptID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.runtime.stop(context.actorID, id);
  });
}
export async function cancelChange(changeID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(changeID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.runtime.cancelChange(context.actorID, id);
  });
}

export async function getChanges(projectID?: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().optional().parse(projectID),
      context = factoryFunctionContext();
    return context.runtime.changes(context.actorID, id);
  });
}
export async function getRuntimeAttempts(projectID?: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().optional().parse(projectID),
      context = factoryFunctionContext();
    return context.runtime.attempts(context.actorID, id);
  });
}
export async function getProjectPreviews(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    return context.runtime.previews(context.actorID, id);
  });
}
export async function ensureStaging(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.runtime.ensureStaging(context.actorID, id);
  });
}
