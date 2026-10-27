import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  createRegisterProjectInput,
  type RegisterProjectInput,
} from "../../../../packages/project-domain/src/project";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getProjects = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.projects.list(context.actorID);
    });
  });
export const registerProject = createServerFn({ method: "POST" })
  .validator((args: [input: RegisterProjectInput]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      // Source-origin validation belongs to the service's configured Forgejo.
      const value = createRegisterProjectInput().extend({ repositoryUrl: z.url() }).parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.projects.register(context.actorID, value);
    });
  });
