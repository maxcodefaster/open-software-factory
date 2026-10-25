import { z } from "zod";
import type {
  monitoringChange,
  monitoringSave,
} from "../../../../packages/conversation-domain/src/monitoring";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getProjectInputs(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const context = factoryFunctionContext();
    return context.inputs.get(context.actorID, project);
  });
}
export async function saveProjectInput(projectID: string, input: z.input<typeof monitoringSave>) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.inputs.save(context.actorID, project, input);
  });
}
export async function disableProjectInput(
  projectID: string,
  id: string,
  input: z.input<typeof monitoringChange>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID),
      identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.inputs.disable(context.actorID, project, identity, input);
  });
}
export async function rotateProjectInput(
  projectID: string,
  id: string,
  input: z.input<typeof monitoringChange>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID),
      identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.inputs.rotate(context.actorID, project, identity, input);
  });
}
