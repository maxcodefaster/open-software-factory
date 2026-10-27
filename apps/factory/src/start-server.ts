import { configureServerFunctionsServer } from "@solidjs/web/server-functions/server";
import { createStartHandler, defaultStreamHandler } from "@tanstack/solid-start/server";

// Environment commands have a 2 MiB input limit, plus the native argument envelope.
configureServerFunctionsServer({ bodySizeLimit: 2_097_152 + 8192 });

export {
  compiledFunctionID,
  factoryFunctions,
  functionIDs,
  publicFunctionIDs,
} from "./server-functions/entry";
export default { fetch: createStartHandler(defaultStreamHandler) };
