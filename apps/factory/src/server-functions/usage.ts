import { z } from "zod";
import { executionPolicyCommand } from "../../../../packages/conversation-domain/src/execution-policy";
import {
  currentComputeView,
  usageSettingsView,
} from "../../../../packages/conversation-domain/src/usage-view";
import { contractRateCommand } from "../usage/contract-rates";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getUsage(projectID: string | null) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return usageSettingsView.parse(
      await context.usage.get(context.actorID, z.uuid().nullable().parse(projectID)),
    );
  });
}

export async function getCurrentCompute(projectID: string | null) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return currentComputeView.parse(
      await context.usage.compute(context.actorID, z.uuid().nullable().parse(projectID)),
    );
  });
}

export async function saveUsage(
  projectID: string | null,
  input: z.input<typeof executionPolicyCommand>,
) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    const project = z.uuid().nullable().parse(projectID);
    const command = executionPolicyCommand.parse(input);
    await context.beforeWrite(true);
    await context.usage.set(context.actorID, project, command);
  });
}

export async function getContractPrices() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.usage.rates(context.actorID);
  });
}

export async function saveContractPrices(input: z.input<typeof contractRateCommand>) {
  "use server";
  return factoryFunction(async () => {
    const command = contractRateCommand.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    await context.usage.setRate(context.actorID, command);
  });
}
