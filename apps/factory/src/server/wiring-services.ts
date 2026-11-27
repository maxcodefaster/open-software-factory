import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createDatabase } from "#db/client";
import { createForgejoClient } from "#forge/forge";
import { createWriterService } from "../access/writer-service";
import { createAgentService } from "../agent/service";
import { createBootstrapService } from "../bootstrap/service";
import { factoryBuildDirectory } from "../build-directory";
import { createTicketService } from "../change/service";
import { createDeliveryService } from "../delivery/service";
import { createEnvironmentService } from "../environments/service";
import { createInboxService } from "../inbox/service";
import { installationInMaintenance } from "../installation/maintenance";
import { createKnowledgeService } from "../knowledge/service";
import { createExternalFactoryMCP } from "../mcp/external";
import { createMCPService } from "../mcp/service";
import { createInputService } from "../monitoring/service";
import { createConversationService } from "../project-agent/service";
import { createRepositoryMirrorController } from "../repository-mirrors/controller";
import { createReviewService } from "../review/service";
import { createRuntimeService } from "../runtime/service";
import { createServerFunctionEndpoint } from "../server-functions/endpoint";
import { createSetupService } from "../setup/service";
import { createStaticAssets } from "../static-assets";
import { createWorkspaceService } from "../workspace/service";
import type { ServerConfig } from "./config";
import { createPageHint } from "./page-hints";
import type { PlatformSubsystem } from "./wiring-platform";
import type { ProductSubsystem } from "./wiring-product";
import type { RuntimeSubsystem } from "./wiring-runtime";

export type ServicesWiringInput = {
  config: ServerConfig;
  database: ReturnType<typeof createDatabase>;
  runtimeSecret: string;
  planningCacheEpoch?: string;
  platform: PlatformSubsystem;
  runtime: RuntimeSubsystem;
  product: ProductSubsystem;
};

/**
 * Wires external-facing service surfaces: bootstrap, external Factory MCP,
 * compiled server-function RPC endpoint, and static client assets.
 */
export async function wireServices({
  config,
  database,
  runtimeSecret,
  planningCacheEpoch,
  platform,
  runtime,
  product,
}: ServicesWiringInput) {
  const { factoryOrigin, planningCacheURL } = config;
  const {
    apiURL: forgeAPIURL,
    owner: forgeOwner,
    token: forgeToken,
    transportOrigin: forgeTransportOrigin,
    publicOrigin: forgePublicOrigin,
  } = config.forge;

  const buildDirectory = factoryBuildDirectory();
  const externalMCP = createExternalFactoryMCP({
    database,
    factoryAuth: platform.factoryAuth,
    factoryOrigin,
    workspaceSources: runtime.workspaceSources,
    workspaceSharing: runtime.workspaceSharing,
    workspaceCommands: runtime.workspaceCommands,
    workspaceFiles: runtime.workspaceFiles,
    runtimeController: runtime.runtimeController,
    workspaceCollaboration: runtime.workspaceCollaboration,
    runtimeAccess: runtime.runtimeAccess,
    workspaceSubmission: runtime.workspaceSubmission,
    runtimeHub: runtime.runtimeHub,
    projects: product.projectService,
    writers: product.changeWriters,
  });

  const bootstrapService = createBootstrapService({
    policy: () => platform.factoryAuth.policy,
    preference: platform.uiPreferenceController.get,
    planningCacheURL,
    signingKey: runtimeSecret,
    ...(planningCacheEpoch ? { planningCacheEpoch } : {}),
    forgeOrigins: { browser: forgePublicOrigin, transport: forgeTransportOrigin },
    async modelAvailability() {
      return Boolean(
        config.fallbackModelConfigured ||
          (await database.client.begin((sql) => platform.modelConnections.reference("build", sql))),
      );
    },
  });

  const serverFunctionEntry = pathToFileURL(resolve(buildDirectory, "server/entry.js")).href;
  const serverFunctions: typeof import("../start-server") = await import(serverFunctionEntry);
  const serverFunctionEndpoint = createServerFunctionEndpoint({
    origin: factoryOrigin,
    session: platform.requireSession,
    services: {
      repositoryMirrors: createRepositoryMirrorController({
        database,
        forge: createForgejoClient({ apiURL: forgeAPIURL, token: forgeToken }),
        apiURL: forgeAPIURL,
        publicURL: forgePublicOrigin,
        owner: forgeOwner,
        signingKey: runtimeSecret,
        allowedOrigins: config.gitImportOrigins,
      }),
      learning: platform.learningService,
      inbox: createInboxService(database),
      releases: runtime.releaseController,
      projects: product.projectService,
      delivery: createDeliveryService({
        access: platform.accessController,
        controller: product.deliveryController,
      }),
      runtime: createRuntimeService({
        database,
        access: platform.accessController,
        changes: product.changeController,
        runtime: runtime.runtimeController,
        previews: runtime.projectAppPreviews,
        closeBrowser: (id) => runtime.buildBrowserController.closeChange(id),
        cancelDelivery: (id) => product.deliveryController.cancel(id),
        revokeAttempt: (id) => runtime.runtimeAccess.revokeAttempt(id),
        suspendAttempt: (id) => runtime.runtimeHub.suspend(id),
      }),
      agent: createAgentService({
        access: platform.accessController,
        controller: product.agentController,
      }),
      conversations: createConversationService({
        access: platform.accessController,
        controller: product.projectAgentController,
      }),
      tickets: createTicketService({
        database,
        access: platform.accessController,
        documents: product.ticketDocuments,
        trash: product.ticketTrash,
        changes: product.changeController,
        agent: product.agentController,
        planning: product.projectAgentController,
      }),
      usage: platform.usageService,
      models: platform.modelService,
      environments: createEnvironmentService(platform.environmentController),
      access: runtime.accessService,
      bootstrap: bootstrapService,
      setup: createSetupService({
        database,
        drafts: product.projectSetup,
        inspection: product.setupInspection,
        readiness: product.setupReadiness,
      }),
      skills: platform.skillService,
      mcp: createMCPService(platform.mcpConnections),
      inputs: createInputService(product.monitoringController, platform.accessController),
      writer: createWriterService(product.changeWriters, platform.accessController),
      review: createReviewService({
        controller: runtime.visualReview,
        access: platform.accessController,
        admit: (changeID, userID, sql, text, commandID) =>
          product.agentController.admitPromptIn(sql, changeID, userID, text, commandID),
        dispatchPending: (changeID) => product.agentController.dispatchPending(changeID),
      }),
      attachments: runtime.attachmentStore,
      workspaces: createWorkspaceService({
        sources: runtime.workspaceSources,
        editors: runtime.developerEditors,
        revokeEditor: (userID) => runtime.developerIDEEdge.revokeUser(userID),
        sharing: runtime.workspaceSharing,
        collaboration: runtime.workspaceCollaboration,
        submission: runtime.workspaceSubmission,
        database,
      }),
      knowledge: createKnowledgeService({
        controller: product.knowledgeController,
        access: platform.accessController,
        observeRetry: (projectID, userID, generationID) =>
          product.setupReadiness.observeWikiRetry(projectID, userID, generationID),
      }),
    },
    maintenance: () =>
      config.helmRelease ? installationInMaintenance(database) : Promise.resolve(false),
    requireFresh: (request) => platform.factoryAuth.requireFresh(request),
    handle: async (request, options) => serverFunctions.default.fetch(request, options),
    publicFunctionIDs: serverFunctions.publicFunctionIDs,
    functionIDs: serverFunctions.functionIDs,
  });

  const clientDirectory = resolve(buildDirectory, "client");
  const pageHint = createPageHint(clientDirectory);
  const staticAssets = createStaticAssets(clientDirectory, async (request) => {
    const response = await serverFunctions.default.fetch(request, { context: {} });
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    if (pageHint) response.headers.append("link", pageHint);
    return response;
  });

  return {
    externalMCP,
    serverFunctionEndpoint,
    staticAssets,
    startFetch: serverFunctions.default.fetch,
  };
}
