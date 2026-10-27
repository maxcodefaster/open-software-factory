import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { factoryFunction, factoryFunctionContext } from "./context";

export const startPersonalWorkspace = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.runtime.startPersonal(context.actorID, id);
    });
  });
export const startTicketWorkspace = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.runtime.startTicket(context.actorID, id);
    });
  });
export const stopRuntimeAttempt = createServerFn({ method: "POST" })
  .validator((args: [attemptID: string]) => args)
  .handler(async ({ data: [attemptID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(attemptID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.runtime.stop(context.actorID, id);
    });
  });
export const cancelChange = createServerFn({ method: "POST" })
  .validator((args: [changeID: string]) => args)
  .handler(async ({ data: [changeID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(changeID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.runtime.cancelChange(context.actorID, id);
    });
  });

export const getChanges = createServerFn({ method: "POST", strict: { input: false } })
  .validator((args: [projectID?: string | undefined]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().optional().parse(projectID),
        context = factoryFunctionContext();
      return context.runtime.changes(context.actorID, id);
    });
  });
export const getRuntimeAttempts = createServerFn({ method: "POST", strict: { input: false } })
  .validator((args: [projectID?: string | undefined]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().optional().parse(projectID),
        context = factoryFunctionContext();
      return context.runtime.attempts(context.actorID, id);
    });
  });
export const getProjectPreviews = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      return context.runtime.previews(context.actorID, id);
    });
  });
export const ensureStaging = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.runtime.ensureStaging(context.actorID, id);
    });
  });
