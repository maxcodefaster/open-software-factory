import { z } from "zod";
import {
  projectSetupSave,
  projectSetupCreate,
  setupInspectionCommand,
  setupTask,
  type SetupTask,
} from "../../../../packages/project-domain/src/setup";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getSetupDraft() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.setup.draft(context.actorID);
  });
}
export async function beginSetupDraft() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.begin(context.actorID);
  });
}
export async function saveSetupDraft(input: z.input<typeof projectSetupSave>) {
  "use server";
  return factoryFunction(async () => {
    const command = projectSetupSave.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.save(context.actorID, command);
  });
}
export async function createSetupProject(input: z.input<typeof projectSetupCreate>) {
  "use server";
  return factoryFunction(async () => {
    const command = projectSetupCreate.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.create(context.actorID, command);
  });
}
export async function checkSetupProject(id: string) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.check(context.actorID, identity);
  });
}
export async function retrySetupProject(id: string) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.retry(context.actorID, identity);
  });
}
export async function getSetupInspection(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const context = factoryFunctionContext();
    return context.setup.inspection(context.actorID, project);
  });
}
export async function startSetupInspection(
  projectID: string,
  input: z.input<typeof setupInspectionCommand>,
) {
  "use server";
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
}
export async function confirmSetupInspection(projectID: string, id: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID),
      identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.confirm(context.actorID, project, identity);
  });
}
export async function stopSetupInspection(projectID: string, id: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID),
      identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.stop(context.actorID, project, identity);
  });
}
export async function getSetupReadiness(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const context = factoryFunctionContext();
    return context.setup.readiness(context.actorID, project);
  });
}
export async function retrySetupTask(projectID: string, task: SetupTask) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID),
      step = setupTask.parse(task);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.setup.retryTask(context.actorID, project, step);
  });
}
