import { z } from "zod";
import {
  externalAccessInput,
  publishRelease,
} from "../../../../packages/project-domain/src/release";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getProjectReleases(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.releases.view(context.actorID, z.uuid().parse(projectID));
  });
}
export async function publishProjectRelease(
  projectID: string,
  input: z.input<typeof publishRelease>,
) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.releases.publish(
      context.actorID,
      z.uuid().parse(projectID),
      publishRelease.parse(input),
    );
  });
}
export async function reconcileProjectRelease(projectID: string, id: string) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.releases.reconcile(
      context.actorID,
      z.uuid().parse(projectID),
      z.uuid().parse(id),
    );
  });
}
export async function createReleaseAccess(
  projectID: string,
  input: z.input<typeof externalAccessInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    return context.releases.createAccess(
      context.actorID,
      z.uuid().parse(projectID),
      externalAccessInput.parse(input),
    );
  });
}
export async function revokeReleaseAccess(projectID: string, id: string) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    return context.releases.revokeAccess(
      context.actorID,
      z.uuid().parse(projectID),
      z.uuid().parse(id),
    );
  });
}
export async function rotateReleaseAccess(projectID: string, id: string, commandID: string) {
  "use server";
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
}
export async function endProjectPublication(projectID: string, id: string) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.releases.end(context.actorID, z.uuid().parse(projectID), z.uuid().parse(id));
  });
}
