import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  environmentWrite,
  type ProjectEnvironment,
  projectEnvironment,
} from "../../../../packages/project-domain/src/environment";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getEnvironment = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, environment: ProjectEnvironment]) => args)
  .handler(async ({ data: [projectID, environment] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const scope = projectEnvironment.parse(environment);
      const context = factoryFunctionContext();
      return context.environments.get(project, context.actorID, scope);
    });
  });

export const saveEnvironment = createServerFn({ method: "POST" })
  .validator(
    (
      args: [
        projectID: string,
        environment: ProjectEnvironment,
        input: z.input<typeof environmentWrite>,
      ],
    ) => args,
  )
  .handler(async ({ data: [projectID, environment, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const scope = projectEnvironment.parse(environment);
      const command = environmentWrite
        .refine(
          (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2_097_152,
          {
            message: "Environment settings are too large",
          },
        )
        .parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.environments.save(project, context.actorID, scope, command);
    });
  });

export const discardEnvironmentSave = createServerFn({ method: "POST" })
  .validator(
    (args: [projectID: string, environment: ProjectEnvironment, commandID: string]) => args,
  )
  .handler(async ({ data: [projectID, environment, commandID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const scope = projectEnvironment.parse(environment);
      const command = z.uuid().parse(commandID);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.environments.discard(project, context.actorID, scope, command);
    });
  });
