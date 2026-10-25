import { configureServerFunctionsServer } from "@solidjs/web/server-functions/server";
import type { ServerFunction } from "@solidjs/web/server-functions/client";
import { getBootstrap } from "./bootstrap";

const bootstrapID = (getBootstrap as unknown as ServerFunction).id;
if (typeof bootstrapID !== "string" || !bootstrapID)
  throw new Error("Compiled public Bootstrap identity is missing");
export const publicFunctionIDs: ReadonlySet<string> = new Set([bootstrapID]);

// Environment commands previously admitted up to 2 MiB of JSON. Keep room for
// their argument envelope while the command validates its own 2 MiB limit.
configureServerFunctionsServer({ bodySizeLimit: 2_097_152 + 8192 });

export { handleServerFunctionRequest } from "virtual:solid-server-function-handler";
