import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  projectSetupCreate,
  projectSetupSave,
  type SetupTask,
  setupInspectionCommand,
  setupTask,
} from "../../../../packages/project-domain/src/setup";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getSetupDraft = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.setup.draft(context.actorID);
    });
  });
export const beginSetupDraft = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.begin(context.actorID);
    });
  });
export const saveSetupDraft = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof projectSetupSave>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = projectSetupSave.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.save(context.actorID, command);
    });
  });
export const createSetupProject = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof projectSetupCreate>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = projectSetupCreate.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.create(context.actorID, command);
    });
  });
export const checkSetupProject = createServerFn({ method: "POST" })
  .validator((args: [id: string]) => args)
  .handler(async ({ data: [id] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.check(context.actorID, identity);
    });
  });
export const retrySetupProject = createServerFn({ method: "POST" })
  .validator((args: [id: string]) => args)
  .handler(async ({ data: [id] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.retry(context.actorID, identity);
    });
  });
export const getSetupInspection = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const context = factoryFunctionContext();
      return context.setup.inspection(context.actorID, project);
    });
  });
export const startSetupInspection = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof setupInspectionCommand>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const command = setupInspectionCommand.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.inspect(context.actorID, project, command.id, {
        ...(command.parentID ? { parentID: command.parentID } : {}),
        answers: command.answers,
      });
    });
  });
export const confirmSetupInspection = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, id: string]) => args)
  .handler(async ({ data: [projectID, id] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.confirm(context.actorID, project, identity);
    });
  });
export const stopSetupInspection = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, id: string]) => args)
  .handler(async ({ data: [projectID, id] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.stop(context.actorID, project, identity);
    });
  });
export const getSetupReadiness = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const context = factoryFunctionContext();
      return context.setup.readiness(context.actorID, project);
    });
  });
export const retrySetupTask = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, task: SetupTask]) => args)
  .handler(async ({ data: [projectID, task] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        step = setupTask.parse(task);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.setup.retryTask(context.actorID, project, step);
    });
  });
