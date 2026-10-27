import { createServerFn } from "@tanstack/solid-start";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getBootstrap = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => factoryFunctionContext().readBootstrap());
  });

export const getModelAvailability = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => ({
      modelRelayConfigured: await factoryFunctionContext().bootstrap.modelAvailability(),
    }));
  });
