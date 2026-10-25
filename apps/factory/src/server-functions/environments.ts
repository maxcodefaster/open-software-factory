import { z } from "zod";
import {
  environmentWrite,
  projectEnvironment,
  type ProjectEnvironment,
} from "../../../../packages/project-domain/src/environment";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getEnvironment(projectID: string, environment: ProjectEnvironment) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const scope = projectEnvironment.parse(environment);
    const context = factoryFunctionContext();
    return context.environments.get(project, context.actorID, scope);
  });
}

export async function saveEnvironment(
  projectID: string,
  environment: ProjectEnvironment,
  input: z.input<typeof environmentWrite>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const scope = projectEnvironment.parse(environment);
    const command = environmentWrite
      .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2_097_152, {
        message: "Environment settings are too large",
      })
      .parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.environments.save(project, context.actorID, scope, command);
  });
}

export async function discardEnvironmentSave(
  projectID: string,
  environment: ProjectEnvironment,
  commandID: string,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const scope = projectEnvironment.parse(environment);
    const command = z.uuid().parse(commandID);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.environments.discard(project, context.actorID, scope, command);
  });
}
