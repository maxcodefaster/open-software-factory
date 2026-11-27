import { eq } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { runtimeAttempt } from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import type { SubstrateCall } from "#runtime-kubernetes/substrate-control";
import { createAccessController } from "../access/api";
import {
  createCodingRuntimeShutdown,
  type PendingWriterHandoff,
  type RetainedStopTarget,
} from "../agent/runtime-api";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { requireSetupReady } from "../setup/execution-gate";
import type { SubstrateSourceHandoff } from "../workspace/source-api";
import {
  authorizePersonalWorkspaceStart,
  createProjectRecoveryTrigger,
  createStopReconciler,
  type PersonalStartRecorder,
  pauseRuntimeAttempt,
  resolveChangeProject,
  resolvePromotionProject,
  resolvePublicationProject,
  resolveVerificationProject,
  selectRuntimeOwner,
  stopRuntimeAttempt,
} from "./controller-lifecycle";
import {
  createProjectRepositoryReader,
  createStatusObserver,
  resolveVerificationJobHandle,
} from "./controller-observation";
import {
  closeWorkspaceTerminal,
  getRuntimeAttempt,
  listRuntimeAttempts,
  readProcessOutput,
  runProcessAction,
} from "./controller-views";
import type { RuntimeHub } from "./hub";
import type { createSubstrateCapacity } from "./substrate-capacity";
import { createSubstrateIsolated } from "./substrate-isolated";
import { createSubstrateVerification } from "./substrate-verification";
import {
  configuredSubstrateInstallation,
  createSubstrateWorkspaces,
  type SubstrateInstallationConfiguration,
  substrateInstallationConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-workspaces";

type Database = ReturnType<typeof createDatabase>;

export type RuntimeControllerOptions = {
  configuration?: SubstrateInstallationConfiguration;
  call?: SubstrateCall;
  provisionerCall?: SubstrateCall;
  sources?: SubstrateSourceHandoff;
  capacity?: Pick<ReturnType<typeof createSubstrateCapacity>, "ensure" | "requireReady">;
  stopCoding?: (changeID: string, handoff?: PendingWriterHandoff) => Promise<unknown>;
};

// Factory owns commands, authority and persisted intent. There is exactly one
// execution backend: the admitted official Substrate Actor adapter.
export function createRuntimeController(
  database: Database,
  hub: RuntimeHub,
  connectorSecret: string,
  options: RuntimeControllerOptions = {},
) {
  const selected = options.configuration ?? configuredSubstrateInstallation();
  if (!selected) throw new Error("Factory requires its Substrate installation configuration");
  const installation = substrateInstallationConfiguration(selected);
  const {
    FACTORY_FORGEJO_API_URL,
    FACTORY_FORGEJO_PUBLIC_URL,
    FACTORY_FORGEJO_TOKEN,
    FACTORY_FORGEJO_OWNER,
  } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER)
    throw new Error("Forgejo configuration is required");
  const forgeBinding = {
    apiURL: FACTORY_FORGEJO_API_URL,
    publicURL: FACTORY_FORGEJO_PUBLIC_URL,
    owner: FACTORY_FORGEJO_OWNER,
  };
  const forge = createForgejoClient({
    apiURL: FACTORY_FORGEJO_API_URL,
    token: FACTORY_FORGEJO_TOKEN,
  });
  const repository = createProjectRepositoryReader(forge, FACTORY_FORGEJO_OWNER);
  const shutdownCoding = createCodingRuntimeShutdown(database, hub);
  const projects = new Map<
    string,
    {
      workspaces: ReturnType<typeof createSubstrateWorkspaces>;
      verification: ReturnType<typeof createSubstrateVerification>;
      isolated: ReturnType<typeof createSubstrateIsolated>;
    }
  >();

  function project(projectID: string) {
    const existing = projects.get(projectID);
    if (existing) return existing;
    const configuration = substrateWorkspaceConfiguration({ ...installation, projectID });
    const owners = {
      workspaces: createSubstrateWorkspaces(
        database,
        hub,
        connectorSecret,
        configuration,
        options.call,
        options.provisionerCall,
        repository.readWorkspaceConfiguration,
        options.sources,
        options.capacity,
        shutdownCoding,
      ),
      verification: createSubstrateVerification(
        database,
        hub,
        connectorSecret,
        configuration,
        options.call,
        options.provisionerCall,
        options.capacity,
        shutdownCoding,
        repository.readWorkspaceConfiguration,
      ),
      isolated: createSubstrateIsolated(
        database,
        hub,
        connectorSecret,
        configuration,
        repository.readContract,
        options.call,
        options.provisionerCall,
        options.capacity,
        shutdownCoding,
        repository.readWorkspaceConfiguration,
      ),
    };
    projects.set(projectID, owners);
    return owners;
  }

  async function execution(attemptID: string) {
    const [attempt] = await database.db
      .select({
        projectID: runtimeAttempt.projectId,
        isolatedKind: runtimeAttempt.isolatedKind,
      })
      .from(runtimeAttempt)
      .where(eq(runtimeAttempt.id, attemptID));
    if (!attempt) throw new CommandError("not-found", "Runtime Attempt not found");
    const owner = selectRuntimeOwner(project(attempt.projectID), attempt.isolatedKind);
    const runtime = await owner.forAttempt(attemptID);
    if (!runtime) throw new Error("Runtime Attempt requires its persisted Substrate owner binding");
    return runtime;
  }

  const observer = createStatusObserver(database, hub, execution);
  const reconcileStops = createStopReconciler(database, async (id) =>
    (await execution(id)).recover(),
  );

  return {
    reconcileStops,
    async supportsInitialSourceRole(attemptID: string, sql: DatabaseTransaction) {
      const [attempt] = await drizzleTransaction(sql)
        .select({ projectID: runtimeAttempt.projectId })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.id, attemptID));
      if (!attempt) return false;
      const owner = await project(attempt.projectID).workspaces.forAttempt(attemptID, sql);
      return owner ? owner.supportsInitialSourceRole(sql) : false;
    },
    async settleRetainedInputStop(target: RetainedStopTarget, signal: AbortSignal) {
      return (await execution(target.attemptID)).settleInputStop(target, signal);
    },
    async authorizeConnector(request: Request) {
      const attemptID = request.headers.get("x-factory-runtime-attempt");
      if (!attemptID) return false;
      try {
        return await (await execution(attemptID)).authorizeConnector(request);
      } catch {
        return false;
      }
    },
    async admitNativeCapacity() {
      await options.capacity?.ensure();
    },
    recover() {
      return createProjectRecoveryTrigger(database, (projectID) => {
        const owners = project(projectID);
        for (const owner of [owners.workspaces, owners.verification, owners.isolated])
          void owner.recover().catch(reportFailure("Native runtime observation is unavailable"));
      });
    },
    async start(
      projectID: string,
      userID: string,
      selectedWorkspaceID?: string,
      recordStart?: PersonalStartRecorder,
    ) {
      await authorizePersonalWorkspaceStart(database, projectID, userID, selectedWorkspaceID);
      return this.get(
        await project(projectID).workspaces.start(
          userID,
          undefined,
          selectedWorkspaceID,
          recordStart,
        ),
      );
    },
    async startPersisted(changeID: string, userID: string) {
      const projectID = await resolveChangeProject(database, changeID);
      return this.get(await project(projectID).workspaces.start(userID, changeID));
    },
    async ensureStaging(projectID: string, userID: string) {
      await requireSetupReady(database.client, projectID);
      return this.get(await project(projectID).isolated.stage(userID));
    },
    async startVerification(verificationID: string, userID: string) {
      const projectID = await resolveVerificationProject(database, verificationID, userID);
      if (!projectID) return null;
      await resolveVerificationJobHandle(database, forge, forgeBinding, verificationID);
      return this.get(await project(projectID).verification.start(verificationID, userID));
    },
    async startPublication(publicationID: string, userID: string) {
      const projectID = await resolvePublicationProject(database, publicationID);
      return this.get(await project(projectID).isolated.publish(publicationID, userID));
    },
    async startStagingReplacement(promotionID: string, userID: string) {
      const projectID = await resolvePromotionProject(database, promotionID);
      return this.get(await project(projectID).isolated.stage(userID, promotionID));
    },
    async resumeForApp(attemptID: string, userID: string) {
      await createAccessController(database).requireRuntime(userID, attemptID, "app");
      await (await execution(attemptID)).resume(userID);
      return this.get(attemptID);
    },
    async resumeForSource(attemptID: string, userID: string) {
      await (await execution(attemptID)).resume(userID, true);
      return this.get(attemptID);
    },
    async pause(attemptID: string) {
      await pauseRuntimeAttempt(
        database,
        async () => (await execution(attemptID)).suspend(),
        attemptID,
      );
      return this.get(attemptID);
    },
    /** Internal final compute cleanup and writer fencing; ordinary user halt uses pause(). */
    async stop(attemptID: string, handoff?: PendingWriterHandoff) {
      await stopRuntimeAttempt(
        database,
        hub,
        {
          clearReconnect: observer.clearReconnect,
          get: (id) => this.get(id),
          stopNative: async (id, pending) => (await execution(id)).stop(pending),
          stopCoding: options.stopCoding,
        },
        attemptID,
        handoff,
      );
      return this.get(attemptID);
    },
    get(attemptID: string) {
      return getRuntimeAttempt(database, async (id) => (await execution(id)).get(), attemptID);
    },
    list(projectID: string | undefined, userID: string) {
      return listRuntimeAttempts(database, projectID, userID);
    },
    processOutput(attemptID: string) {
      return readProcessOutput(database, hub, attemptID);
    },
    processAction(
      attemptID: string,
      process: string,
      action: "start" | "stop" | "restart",
      actionOptions?: {
        beforeSend?: (send: () => void) => Promise<void>;
        waitForReady?: boolean;
        signal?: AbortSignal;
      },
    ) {
      return runProcessAction(database, hub, attemptID, process, action, actionOptions);
    },
    closeTerminal(attemptID: string, terminalID: string) {
      return closeWorkspaceTerminal(database, hub, attemptID, terminalID);
    },
    status: observer.status,
  };
}
