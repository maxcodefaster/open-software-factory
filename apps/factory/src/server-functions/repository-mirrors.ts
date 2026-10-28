import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  repositoryMirrorCommand,
  repositoryMirrorCreate,
  repositoryMirrorRemove,
} from "../../../../packages/project-domain/src/repository-mirror";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getRepositoryMirrorProjects = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.repositoryMirrors.projects(context.actorID);
    }),
  );
export const getRepositoryMirrors = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.repositoryMirrors.get(context.actorID, z.uuid().parse(projectID));
    }),
  );
export const createRepositoryMirror = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof repositoryMirrorCreate>]) => args)
  .handler(async ({ data: [projectID, input] }) =>
    factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        command = repositoryMirrorCreate.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.repositoryMirrors.create(context.actorID, project, command);
    }),
  );
export const removeRepositoryMirror = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof repositoryMirrorRemove>]) => args)
  .handler(async ({ data: [projectID, input] }) =>
    factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        command = repositoryMirrorRemove.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.repositoryMirrors.remove(context.actorID, project, command);
    }),
  );
export const syncRepositoryMirrors = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof repositoryMirrorCommand>]) => args)
  .handler(async ({ data: [projectID, input] }) =>
    factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        command = repositoryMirrorCommand.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.repositoryMirrors.sync(context.actorID, project, command.commandID);
    }),
  );
export const acknowledgeRepositoryMirrorOperation = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof repositoryMirrorCommand>]) => args)
  .handler(async ({ data: [projectID, input] }) =>
    factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        command = repositoryMirrorCommand.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.repositoryMirrors.acknowledge(context.actorID, project, command.commandID);
    }),
  );
