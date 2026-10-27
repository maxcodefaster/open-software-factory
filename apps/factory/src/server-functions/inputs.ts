import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import type {
  monitoringChange,
  monitoringSave,
} from "../../../../packages/conversation-domain/src/monitoring";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getProjectInputs = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const context = factoryFunctionContext();
      return context.inputs.get(context.actorID, project);
    });
  });
export const saveProjectInput = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof monitoringSave>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.inputs.save(context.actorID, project, input);
    });
  });
export const disableProjectInput = createServerFn({ method: "POST" })
  .validator(
    (args: [projectID: string, id: string, input: z.input<typeof monitoringChange>]) => args,
  )
  .handler(async ({ data: [projectID, id, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.inputs.disable(context.actorID, project, identity, input);
    });
  });
export const rotateProjectInput = createServerFn({ method: "POST" })
  .validator(
    (args: [projectID: string, id: string, input: z.input<typeof monitoringChange>]) => args,
  )
  .handler(async ({ data: [projectID, id, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.inputs.rotate(context.actorID, project, identity, input);
    });
  });
