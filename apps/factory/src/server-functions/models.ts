import { z } from "zod";
import {
  personalModelInput,
  projectModelInput,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import {
  modelConnectionWrite,
  modelRoleConnectionInput,
} from "../../../../packages/conversation-domain/src/model-connection";
import { modelDefaultsInput } from "../../../../packages/conversation-domain/src/model-settings";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getModelSettings() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.models.get(context.actorID);
  });
}

export async function saveModelSettings(input: z.input<typeof modelDefaultsInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = modelDefaultsInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.models.set(context.actorID, command);
  });
}

export async function getProjectModels(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const context = factoryFunctionContext();
    return context.models.inherited(context.actorID, project);
  });
}

export async function saveProjectModels(
  projectID: string,
  input: z.input<typeof projectModelInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const command = projectModelInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.models.setProject(context.actorID, project, command);
  });
}

export async function savePersonalModels(
  projectID: string,
  input: z.input<typeof personalModelInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const command = personalModelInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.models.setPersonal(context.actorID, project, command);
  });
}

export async function getModelConnections() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.models.catalogue(context.actorID);
  });
}

export async function getModelConnection(connectionID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(connectionID);
    const context = factoryFunctionContext();
    return context.models.connection(context.actorID, id);
  });
}

export async function saveModelConnection(input: z.input<typeof modelConnectionWrite>) {
  "use server";
  return factoryFunction(async () => {
    const command = modelConnectionWrite.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.models.saveConnection(context.actorID, command);
  });
}

export async function adoptDeploymentModelConnection(input: {
  role: "planning" | "build";
  commandID: string;
  version: number;
}) {
  "use server";
  return factoryFunction(async () => {
    const command = z
      .object({
        role: z.enum(["planning", "build"]),
        commandID: z.uuid(),
        version: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.models.adoptDeployment(context.actorID, command);
  });
}

export async function selectModelRole(input: z.input<typeof modelRoleConnectionInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = modelRoleConnectionInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.models.selectRole(context.actorID, command, context.signal);
  });
}
