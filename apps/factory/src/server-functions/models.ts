import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  modelConnectionWrite,
  modelRoleConnectionInput,
} from "../../../../packages/conversation-domain/src/model-connection";
import {
  personalModelInput,
  projectModelInput,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import { modelDefaultsInput } from "../../../../packages/conversation-domain/src/model-settings";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getModelSettings = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.models.get(context.actorID);
    });
  });

export const saveModelSettings = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof modelDefaultsInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = modelDefaultsInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.models.set(context.actorID, command);
    });
  });

export const getProjectModels = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const context = factoryFunctionContext();
      return context.models.inherited(context.actorID, project);
    });
  });

export const saveProjectModels = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof projectModelInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const command = projectModelInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.models.setProject(context.actorID, project, command);
    });
  });

export const savePersonalModels = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof personalModelInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const command = personalModelInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.models.setPersonal(context.actorID, project, command);
    });
  });

export const getModelConnections = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.models.catalogue(context.actorID);
    });
  });

export const getModelConnection = createServerFn({ method: "POST" })
  .validator((args: [connectionID: string]) => args)
  .handler(async ({ data: [connectionID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(connectionID);
      const context = factoryFunctionContext();
      return context.models.connection(context.actorID, id);
    });
  });

export const saveModelConnection = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof modelConnectionWrite>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = modelConnectionWrite.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.models.saveConnection(context.actorID, command);
    });
  });

export const adoptDeploymentModelConnection = createServerFn({ method: "POST" })
  .validator(
    (
      args: [
        input: {
          role: "planning" | "build";
          commandID: string;
          version: number;
        },
      ],
    ) => args,
  )
  .handler(async ({ data: [input] }) => {
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
  });

export const selectModelRole = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof modelRoleConnectionInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = modelRoleConnectionInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.models.selectRole(context.actorID, command, context.signal);
    });
  });
