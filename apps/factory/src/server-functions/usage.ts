import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { executionPolicyCommand } from "../../../../packages/conversation-domain/src/execution-policy";
import {
  currentComputeView,
  usageSettingsView,
} from "../../../../packages/conversation-domain/src/usage-view";
import { contractRateCommand } from "../usage/contract-rates";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getUsage = createServerFn({ method: "POST" })
  .validator((args: [projectID: string | null]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return usageSettingsView.parse(
        await context.usage.get(context.actorID, z.uuid().nullable().parse(projectID)),
      );
    });
  });

export const getCurrentCompute = createServerFn({ method: "POST" })
  .validator((args: [projectID: string | null]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return currentComputeView.parse(
        await context.usage.compute(context.actorID, z.uuid().nullable().parse(projectID)),
      );
    });
  });

export const saveUsage = createServerFn({ method: "POST" })
  .validator(
    (args: [projectID: string | null, input: z.input<typeof executionPolicyCommand>]) => args,
  )
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      const project = z.uuid().nullable().parse(projectID);
      const command = executionPolicyCommand.parse(input);
      await context.beforeWrite(true);
      await context.usage.set(context.actorID, project, command);
    });
  });

export const getContractPrices = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.usage.rates(context.actorID);
    });
  });

export const saveContractPrices = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof contractRateCommand>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = contractRateCommand.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      await context.usage.setRate(context.actorID, command);
    });
  });
