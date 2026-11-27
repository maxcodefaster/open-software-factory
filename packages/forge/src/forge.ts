import { createForgejoDiagnostics } from "./diagnostics";
import { createForgeActions } from "./forge-actions";
import { createForgeBranches } from "./forge-branches";
import { createForgeFiles } from "./forge-files";
import { createForgeHooks, type RepositoryPushHook } from "./forge-hooks";
import {
  createForgeTransport,
  ForgeAmbiguousWriteError,
  type ForgeClientOptions,
  ForgeConflictError,
} from "./forge-http";
import { createForgePullRequests } from "./forge-pulls";
import { createForgeSetup } from "./forge-setup";
import { createForgejoPushMirrors } from "./mirrors";

export { ForgeAmbiguousWriteError, ForgeConflictError, type RepositoryPushHook };

export function createForgejoClient(options: ForgeClientOptions) {
  const transport = createForgeTransport(options);
  const branches = createForgeBranches(transport);
  const files = createForgeFiles(transport, branches);
  const pulls = createForgePullRequests(transport, branches, files);
  const setup = createForgeSetup(transport, branches, files);
  const hooks = createForgeHooks(transport);
  const actions = createForgeActions(transport);

  return {
    pushMirrors: createForgejoPushMirrors(transport.send),
    ...setup,
    ...hooks,
    ...branches,
    ...pulls,
    ...files,
    ...createForgejoDiagnostics(transport.response, options.token),
    ...actions,
  };
}
