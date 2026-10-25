import { factoryFunction, factoryFunctionContext } from "./context";

export async function getBootstrap() {
  "use server";
  return factoryFunction(async () => factoryFunctionContext().readBootstrap());
}

export async function getModelAvailability() {
  "use server";
  return factoryFunction(async () => ({
    modelRelayConfigured: await factoryFunctionContext().bootstrap.modelAvailability(),
  }));
}
