import { z } from "zod";
import {
  createRegisterProjectInput,
  type RegisterProjectInput,
} from "../../../../packages/project-domain/src/project";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getProjects() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.projects.list(context.actorID);
  });
}
export async function registerProject(input: RegisterProjectInput) {
  "use server";
  return factoryFunction(async () => {
    // Source-origin validation belongs to the service's configured Forgejo.
    const value = createRegisterProjectInput().extend({ repositoryUrl: z.url() }).parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.projects.register(context.actorID, value);
  });
}
