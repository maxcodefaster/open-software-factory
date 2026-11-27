import { factorySigningSecret } from "#auth/signing-secret";
import { createDatabase } from "#db/client";
import { configuredSubstrateInstallation } from "../runtime/substrate-workspaces";
import { usageCatalogue } from "../usage/rates";
import { readServerConfig } from "./config";
import { createWiringHooks } from "./wiring-hooks";
import { wirePlatform } from "./wiring-platform";
import { wireProduct } from "./wiring-product";
import { wireRuntime } from "./wiring-runtime";
import { wireServices } from "./wiring-services";

export async function createFactoryApplication() {
  const config = readServerConfig();
  const nativeSetup = configuredSubstrateInstallation();
  if (!nativeSetup) throw new Error("Factory requires its Substrate installation configuration");

  const database = createDatabase();
  void usageCatalogue.refresh();
  const runtimeSecret = factorySigningSecret();
  const hooks = createWiringHooks();

  const platform = await wirePlatform({ config, database, runtimeSecret });
  const runtime = await wireRuntime({
    config,
    database,
    runtimeSecret,
    nativeSetup,
    platform,
    hooks,
  });
  const product = await wireProduct({
    config,
    database,
    runtimeSecret,
    platform,
    runtime,
    hooks,
  });
  const services = await wireServices({
    config,
    database,
    runtimeSecret,
    ...(config.planningCacheEpoch ? { planningCacheEpoch: config.planningCacheEpoch } : {}),
    platform,
    runtime,
    product,
  });

  return {
    accessController: platform.accessController,
    agentController: product.agentController,
    attachmentRoutes: runtime.attachmentRoutes,
    attachmentStore: runtime.attachmentStore,
    buildBrowserController: runtime.buildBrowserController,
    buildBrowserEndpoint: runtime.buildBrowserEndpoint,
    database,
    demandRuntime: runtime.demandRuntime,
    developerIDEEdge: runtime.developerIDEEdge,
    deliveryController: product.deliveryController,
    environmentController: platform.environmentController,
    environmentSecrets: platform.environmentSecrets,
    factoryAuth: platform.factoryAuth,
    factoryHost: config.factoryHost,
    factoryOrigin: config.factoryOrigin,
    forgeIdentityRoutes: runtime.forgeIdentityRoutes,
    idleCompute: runtime.idleCompute,
    implementationOrders: product.implementationOrders,
    knowledgeController: product.knowledgeController,
    learningWorker: platform.learningWorker,
    mcpConnections: platform.mcpConnections,
    mcpOAuthCallback: platform.mcpOAuthCallback,
    mcpSourceEndpoint: runtime.mcpSourceEndpoint,
    externalMCP: services.externalMCP,
    workspaceTransferRoutes: runtime.workspaceTransferRoutes,
    monitoringRoutes: product.monitoringRoutes,
    monitoringWorker: product.monitoringWorker,
    observeRecoveredRuntimes: runtime.observeRecoveredRuntimes,
    planningCacheURL: config.planningCacheURL,
    projectAgentController: product.projectAgentController,
    projectSetup: product.projectSetup,
    setupReadiness: product.setupReadiness,
    relayModel: runtime.relayModel,
    releaseController: runtime.releaseController,
    requireSession: platform.requireSession,
    reviewMedia: runtime.reviewMedia,
    reviewMediaRoutes: runtime.reviewMediaRoutes,
    runtimeAccess: runtime.runtimeAccess,
    runtimeController: runtime.runtimeController,
    runtimeEnvironmentEndpoint: runtime.runtimeEnvironmentEndpoint,
    runtimeHub: runtime.runtimeHub,
    runtimeReady: runtime.runtimeReady,
    sameRuntimeOrigin: runtime.sameRuntimeOrigin,
    serverFunctionEndpoint: services.serverFunctionEndpoint,
    sourceProtocol: runtime.sourceProtocol,
    startupID: config.startupID,
    staticAssets: services.staticAssets,
    startFetch: services.startFetch,
    wikiSourceUpdates: product.wikiSourceUpdates,
    workspaceSources: runtime.workspaceSources,
    workspaceSharing: runtime.workspaceSharing,
    workspaceCommands: runtime.workspaceCommands,
    accessRevocation: runtime.accessRevocation,
    workspaceCollaboration: runtime.workspaceCollaboration,
    workspaceSubmission: runtime.workspaceSubmission,
    workspaceFiles: runtime.workspaceFiles,
  };
}
export type FactoryApplication = Awaited<ReturnType<typeof createFactoryApplication>>;
