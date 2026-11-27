import { eq } from "drizzle-orm";
import type { createDatabase } from "#db/client";
import { runtimeAttempt } from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { createForgejoReleases } from "#forge/releases";
import { createAccountRevocation } from "../access/account-revocation";
import { createForgeIdentityRoutes } from "../access/forge-routes";
import { createProjectAppPreviews } from "../access/previews";
import { createAccessRevocation } from "../access/revocation";
import { createRuntimeAccess } from "../access/runtime";
import { createAccessService } from "../access/service";
import { createBuildBrowserController } from "../agent/browser-controller";
import { createBuildBrowserEndpoint } from "../agent/browser-endpoint";
import { createCandidateReviewController } from "../agent/candidate-review";
import { createOpenCodeClient } from "../agent/opencode-adapter";
import { createReviewExecutionReader } from "../agent/review-execution";
import { createVerificationTools } from "../agent/verification-tools";
import { createAttachmentRoutes } from "../attachments/routes";
import { createAttachmentStore } from "../attachments/store";
import { createAttachmentTools } from "../attachments/tools";
import { CommandError } from "../command-error";
import { createRuntimeEnvironmentEndpoint } from "../environments/runtime";
import { logFailure, reportFailure } from "../failure-log";
import { createMCPSourceEndpoint } from "../mcp/sources";
import { createModelRelay } from "../models/relay";
import { createReleaseController } from "../releases/controller";
import { createReleaseSecrets } from "../releases/secrets";
import { factoryRequestURL } from "../request-origin";
import { createVisualReviewController } from "../review/controller";
import { createReviewMedia } from "../review/media";
import { createReviewMediaRoutes } from "../review/media-routes";
import { createSubstrateBrowsers } from "../runtime/browser-api";
import { createRuntimeController } from "../runtime/controller";
import { createRuntimeDemand } from "../runtime/demand";
import { RuntimeHub } from "../runtime/hub";
import { createIdleCompute } from "../runtime/idle";
import { createSubstrateCapacity } from "../runtime/substrate-capacity";
import type { SubstrateInstallationConfiguration } from "../runtime/substrate-workspaces";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import { createWorkspaceCollaboration } from "../workspace/collaboration";
import { createWorkspaceCommands } from "../workspace/commands";
import { createWorkspaceComputeAccess } from "../workspace/compute-access";
import { createWorkspaceContainerFiles } from "../workspace/container-files";
import { createDeveloperIDEController } from "../workspace/developer-ide-controller";
import { createDeveloperIDEEdge } from "../workspace/developer-ide-edge";
import { createDeveloperIDERuntime } from "../workspace/developer-ide-runtime";
import { createWorkspaceSharing } from "../workspace/sharing";
import { createWorkspaceSourceController } from "../workspace/source-controller";
import { createWorkspaceSourceProtocol } from "../workspace/source-protocol";
import { createWorkspaceSubmission } from "../workspace/submission";
import { createSubstrateSources } from "../workspace/substrate-source";
import { createWorkspaceTransferRoutes } from "../workspace/transfer-routes";
import type { ServerConfig } from "./config";
import type { WiringHooks } from "./wiring-hooks";
import type { PlatformSubsystem } from "./wiring-platform";

export type RuntimeWiringInput = {
  config: ServerConfig;
  database: ReturnType<typeof createDatabase>;
  runtimeSecret: string;
  nativeSetup: SubstrateInstallationConfiguration;
  platform: PlatformSubsystem;
  hooks: WiringHooks;
};

/**
 * Wires native Substrate runtime hub, workspaces, sources, developer IDE,
 * build browser, media/attachments, releases and access revocation.
 */
export async function wireRuntime({
  config,
  database,
  runtimeSecret,
  nativeSetup,
  platform,
  hooks,
}: RuntimeWiringInput) {
  const { factoryOrigin } = config;
  const {
    apiURL: forgeAPIURL,
    owner: forgeOwner,
    token: forgeToken,
    adminToken: forgeAdminToken,
    publicOrigin: forgePublicOrigin,
    discoveryURL: forgeDiscoveryURL,
  } = config.forge;
  const { factoryAuth, forgeAccess, environmentSecrets, mcpConnections } = platform;

  const runtimeHub = new RuntimeHub(async (attemptID, phase, error) => {
    await hooks.runtimeStatus(attemptID, phase, error);
    try {
      hooks.onRuntimeActivity();
      if (phase === "ready") {
        await hooks.onRuntimeReady(attemptID);
      }
    } catch (cause) {
      // Persistence succeeded. Dependent recovery must not reject that status
      // and interrupt healthy compute. Pending admissions have their own drain.
      logFailure("Runtime work reconciliation needs another observation", cause, {
        component: "runtime-hub",
        attemptId: attemptID,
      });
    }
  });

  const runtimeEnvironmentEndpoint = createRuntimeEnvironmentEndpoint(
    database,
    environmentSecrets,
    runtimeSecret,
    runtimeHub,
  );
  const relayModel = createModelRelay(
    database,
    runtimeSecret,
    undefined,
    (turnID, attemptID, sessionID) =>
      createRecordedOpenCodeUsage(database).drain(
        turnID,
        createOpenCodeClient((request, path) =>
          runtimeHub.request(attemptID, "agent", request, path),
        ),
        sessionID,
      ),
  );

  const reviewMedia = createReviewMedia(database);
  const reviewMediaRoutes = createReviewMediaRoutes(reviewMedia);
  const attachmentStore = createAttachmentStore(database);
  const attachmentRoutes = createAttachmentRoutes(attachmentStore);
  const visualReview = createVisualReviewController(database, reviewMedia.bytes);

  const buildBrowserController = createBuildBrowserController(
    database,
    runtimeSecret,
    createSubstrateBrowsers(database, runtimeHub, runtimeSecret, nativeSetup),
  );
  hooks.registerBuildBrowserReady((attemptID) => buildBrowserController.recover(attemptID));

  const mcpSourceEndpoint = createMCPSourceEndpoint(
    database,
    mcpConnections,
    buildBrowserController,
  );
  const buildBrowserEndpoint = createBuildBrowserEndpoint(
    buildBrowserController,
    createCandidateReviewController(
      database,
      undefined,
      createReviewExecutionReader(database, runtimeHub, environmentSecrets),
    ),
    visualReview,
    createAttachmentTools(database, attachmentStore),
    createVerificationTools(database),
  );

  const runtimeAccess = createRuntimeAccess(database, (token) => runtimeHub.revokeAccess(token));
  const nativeSources = createSubstrateSources(database, runtimeHub);
  const workspaceSources = createWorkspaceSourceController(database, runtimeHub, nativeSources, {
    supportsInitialRole: (attemptID, sql) => hooks.supportsInitialSourceRole(attemptID, sql),
    wakeForAccess: (workspaceID, userID, signal, write = true) =>
      hooks.wakeForAccess(workspaceID, userID, signal, write),
  });
  const workspaceCollaboration = createWorkspaceCollaboration(database, workspaceSources);
  const workspaceSharing = createWorkspaceSharing(database, async (workspaceID, userID) => {
    workspaceCollaboration.revoke(workspaceID, userID);
    workspaceSources.revokeSharedMember(workspaceID, userID);
    await runtimeAccess.revokeWorkspaceMember(workspaceID, userID);
  });
  await workspaceSharing.recover().catch(reportFailure("Workspace access recovery is unavailable"));

  const nativeCapacity =
    nativeSetup.deployment === "fresh-workspaces"
      ? createSubstrateCapacity(database, nativeSetup)
      : undefined;
  const runtimeController = createRuntimeController(database, runtimeHub, runtimeSecret, {
    configuration: nativeSetup,
    stopCoding: (changeID, handoff) => hooks.stopCoding(changeID, handoff),
    sources: nativeSources,
    ...(nativeCapacity ? { capacity: nativeCapacity } : {}),
  });
  hooks.registerRuntime({
    runtimeStatus: (attemptID, phase, error) => runtimeController.status(attemptID, phase, error),
    supportsInitialSourceRole: (attemptID, sql) =>
      runtimeController.supportsInitialSourceRole(attemptID, sql),
    wakeForAccess: async (workspaceID, userID, signal, write = true) => {
      await createWorkspaceComputeAccess(
        database,
        runtimeHub,
        runtimeController,
        () => signal?.aborted ?? false,
      )(workspaceID, userID, write, undefined, signal, true);
    },
  });

  const workspaceCommands = createWorkspaceCommands(
    database,
    runtimeHub,
    runtimeController,
    runtimeSecret,
  );
  const workspaceFiles = createWorkspaceContainerFiles(
    database,
    runtimeHub,
    runtimeController,
    runtimeSecret,
  );
  const workspaceSubmission = createWorkspaceSubmission(
    database,
    runtimeHub,
    workspaceCollaboration,
    createForgejoClient({ apiURL: forgeAPIURL, token: forgeToken }),
    { username: forgeOwner, password: forgeToken },
    {
      fenceSource: workspaceSources.fenceChange,
      protect: async (changeID, writers) => {
        if (!forgeAccess)
          throw new CommandError("unavailable", "Forge writing authority is not configured");
        await forgeAccess.protectChange(changeID, writers);
      },
    },
  );
  const workspaceTransferRoutes = createWorkspaceTransferRoutes({
    identity: factoryAuth,
    files: workspaceFiles,
    origin: factoryOrigin,
  });

  const releaseController = createReleaseController({
    database,
    signingKey: runtimeSecret,
    secrets: createReleaseSecrets(),
    runtime: runtimeController,
    forge: createForgejoClient({
      apiURL: forgeAPIURL,
      token: forgeToken,
    }),
    publication: createForgejoReleases({
      apiURL: forgeAPIURL,
      token: forgeToken,
      ...(forgeAdminToken ? { adminToken: forgeAdminToken } : {}),
    }),
    apiURL: forgeAPIURL,
    publicURL: forgePublicOrigin,
    owner: forgeOwner,
  });

  const sourceProtocol = createWorkspaceSourceProtocol(workspaceSources);
  const projectAppPreviews = createProjectAppPreviews(
    database,
    (id) => runtimeHub.appChannels(id),
    (id, channel) => {
      const process = runtimeHub.processes(id).find((candidate) => candidate.name === channel);
      return process
        ? {
            state: process.state,
            ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
          }
        : undefined;
    },
  );
  const idleCompute = createIdleCompute(database, runtimeHub, runtimeController);

  const developerEditors = createDeveloperIDEController(database);
  const developerIDEEdge = createDeveloperIDEEdge(
    database,
    developerEditors,
    workspaceSources,
    factoryOrigin,
    createDeveloperIDERuntime(
      database,
      runtimeController,
      runtimeHub,
      runtimeAccess,
      hooks.writerAccess,
    ),
    workspaceCollaboration,
  );

  const revokeAccountAccess = createAccountRevocation({
    database,
    sweepRuntime: () => runtimeAccess.sweep(),
    reconcileEditor: (userID) => developerIDEEdge.sweep(userID),
    reconcileSources: (userID) => workspaceSources.reconcileUserAccess(userID),
    stopRuntime: (attemptID) => runtimeController.stop(attemptID),
    stopAgent: (changeID) => hooks.tryStopCoding(changeID),
    reconcileForge: async (userID) => forgeAccess?.reconcile(userID),
  });
  const accessRevocation = createAccessRevocation(database, revokeAccountAccess);
  const forgeIdentityRoutes = createForgeIdentityRoutes({
    database,
    identity: factoryAuth,
    forgeOrigin: forgePublicOrigin,
    discoveryURL: forgeDiscoveryURL,
    reconcile: accessRevocation.drain,
  });
  const accessService = createAccessService({
    database,
    identity: factoryAuth,
    async revokeMember(projectID, userID) {
      await runtimeAccess.revokeMember(projectID, userID);
      await workspaceSources.revokeMember(projectID, userID);
      await developerEditors.revokeMember(projectID, userID);
      await developerIDEEdge.revokeUser(userID);
    },
    revokeAccount: revokeAccountAccess,
    forgeOrigin: forgeAccess ? forgePublicOrigin : undefined,
    mcpAuthorization: factoryAuth,
  });

  const observeRecoveredRuntimes = await runtimeController.recover();
  await workspaceSources.recover();
  await developerEditors.recover();

  function sameRuntimeOrigin(request: Request) {
    const origin = request.headers.get("origin");
    return (
      origin !== null && new URL(origin).origin === factoryRequestURL(request, factoryOrigin).origin
    );
  }

  async function runtimeReady(attemptID: string) {
    const [attempt] = await database.db
      .select({ state: runtimeAttempt.state })
      .from(runtimeAttempt)
      .where(eq(runtimeAttempt.id, attemptID));
    return attempt?.state === "ready";
  }

  const demandRuntime = createRuntimeDemand(runtimeController, runtimeHub);

  return {
    runtimeHub,
    runtimeEnvironmentEndpoint,
    relayModel,
    reviewMedia,
    reviewMediaRoutes,
    attachmentStore,
    attachmentRoutes,
    visualReview,
    buildBrowserController,
    mcpSourceEndpoint,
    buildBrowserEndpoint,
    runtimeAccess,
    workspaceSources,
    workspaceCollaboration,
    workspaceSharing,
    runtimeController,
    workspaceCommands,
    workspaceFiles,
    workspaceSubmission,
    workspaceTransferRoutes,
    releaseController,
    sourceProtocol,
    projectAppPreviews,
    idleCompute,
    developerEditors,
    developerIDEEdge,
    accessRevocation,
    forgeIdentityRoutes,
    accessService,
    observeRecoveredRuntimes,
    sameRuntimeOrigin,
    runtimeReady,
    demandRuntime,
  };
}

export type RuntimeSubsystem = Awaited<ReturnType<typeof wireRuntime>>;
