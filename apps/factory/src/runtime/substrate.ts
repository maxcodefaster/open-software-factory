import type { DatabaseTransaction } from "#db/client";
import type { SubstrateCall } from "#runtime-kubernetes/substrate-control";
import type {
  CodingRuntimeShutdown,
  PendingWriterHandoff,
  RetainedStopTarget,
} from "../agent/runtime-api";
import type { SubstrateSourceHandoff } from "../workspace/source-api";
import type { RuntimeHub } from "./hub";
import {
  createSubstrateExecContext,
  type Database,
  type SubstrateConfiguration,
  type SubstrateIsolatedConfiguration,
  type SubstrateVerificationConfiguration,
} from "./substrate-exec-helpers";
import {
  settleInputStop,
  stoppedWorkRetainedIn,
  supportsInitialSourceRole,
} from "./substrate-exec-input-stop";
import { authorizeConnectorRequest, recoverExecution } from "./substrate-exec-recovery";
import {
  getExecution,
  resumeExecution,
  startExecution,
  stopExecution,
  suspendExecution,
} from "./substrate-exec-workspace";

export {
  requireDurableROOTFS,
  requireSubstrateActor,
  type SubstrateConfiguration,
  type SubstrateIsolatedConfiguration,
  type SubstrateVerificationConfiguration,
  substrateActorSelector,
  substrateTemplateSHA256,
} from "./substrate-exec-helpers";

// One concrete facade. Substrate owns transitions; Factory retains only its
// existing Attempt intent, an immutable native binding, and observed outcomes.
// Construction performs no database writes or external calls.
export function createSubstrateExecution(
  database: Database,
  hub: RuntimeHub,
  secret: string,
  input:
    | SubstrateConfiguration
    | SubstrateVerificationConfiguration
    | SubstrateIsolatedConfiguration,
  shutdownCoding: CodingRuntimeShutdown,
  rpc?: SubstrateCall,
  sources?: SubstrateSourceHandoff,
) {
  const ctx = createSubstrateExecContext(
    database,
    hub,
    secret,
    input,
    shutdownCoding,
    rpc,
    sources,
  );
  return {
    matchesProject: (id: string) => id === ctx.config.projectID,
    matchesAttempt: (id: string) => id === ctx.attemptID,
    async stoppedWorkRetainedIn(sql: DatabaseTransaction, stopID: string) {
      return stoppedWorkRetainedIn(ctx, sql, stopID);
    },
    async supportsInitialSourceRole(sql: DatabaseTransaction) {
      return supportsInitialSourceRole(ctx, sql);
    },
    async settleInputStop(target: RetainedStopTarget, signal: AbortSignal) {
      return settleInputStop(ctx, target, signal);
    },
    async recover() {
      return recoverExecution(ctx);
    },
    async start(userID: string) {
      return startExecution(ctx, userID);
    },
    async get() {
      return getExecution(ctx);
    },
    async resume(userID: string, sourceOnly = false) {
      return resumeExecution(ctx, userID, sourceOnly);
    },
    async suspend() {
      return suspendExecution(ctx);
    },
    async stop(handoff?: PendingWriterHandoff) {
      return stopExecution(ctx, handoff);
    },
    async authorizeConnector(request: Request) {
      return authorizeConnectorRequest(ctx, request);
    },
  };
}
