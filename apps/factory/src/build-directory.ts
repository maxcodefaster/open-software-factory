import { resolve } from "node:path";

// The production image uses dist. Owned source-run proofs select one immutable
// build so another developer or test build cannot replace their client/handler.
export function factoryBuildDirectory(directory = process.env["FACTORY_BUILD_DIRECTORY"]) {
  return directory ? resolve(directory) : resolve(import.meta.dirname, "../dist");
}
