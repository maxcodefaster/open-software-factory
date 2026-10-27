import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import {
  externalAccessInput,
  publishRelease,
} from "../../../../packages/project-domain/src/release";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getProjectReleases = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.releases.view(context.actorID, z.uuid().parse(projectID));
    });
  });
export const publishProjectRelease = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof publishRelease>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.releases.publish(
        context.actorID,
        z.uuid().parse(projectID),
        publishRelease.parse(input),
      );
    });
  });
export const reconcileProjectRelease = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, id: string]) => args)
  .handler(async ({ data: [projectID, id] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.releases.reconcile(
        context.actorID,
        z.uuid().parse(projectID),
        z.uuid().parse(id),
      );
    });
  });
export const createReleaseAccess = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof externalAccessInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.releases.createAccess(
        context.actorID,
        z.uuid().parse(projectID),
        externalAccessInput.parse(input),
      );
    });
  });
export const revokeReleaseAccess = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, id: string]) => args)
  .handler(async ({ data: [projectID, id] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.releases.revokeAccess(
        context.actorID,
        z.uuid().parse(projectID),
        z.uuid().parse(id),
      );
    });
  });
export const rotateReleaseAccess = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, id: string, commandID: string]) => args)
  .handler(async ({ data: [projectID, id, commandID] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.releases.rotateAccess(
        context.actorID,
        z.uuid().parse(projectID),
        z.uuid().parse(id),
        z.uuid().parse(commandID),
      );
    });
  });
export const endProjectPublication = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, id: string]) => args)
  .handler(async ({ data: [projectID, id] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.releases.end(context.actorID, z.uuid().parse(projectID), z.uuid().parse(id));
    });
  });
