import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerWebSocket } from "bun";
import { createDatabase } from "../../../packages/db/src/client";
import { createForgejoAccess } from "../../../packages/forge/src/access";
import { createForgejoClient } from "../../../packages/forge/src/forge";
import { createForgejoReleases } from "../../../packages/forge/src/releases";
import { projectImportOrigins } from "../../../packages/project-domain/src/setup";
import { hashConnectorToken } from "../../../packages/runtime-domain/src/identity";
import { SystemContractError } from "../../../packages/system-contract/src/system-contract";
import { createAccountRevocation } from "./access/account-revocation";
import { runtimeWriteAuthorityIn } from "./access/change-writer";
import { createAccessController } from "./access/controller";
import { createForgeAccessReconciliation } from "./access/forge";
import { createForgeIdentityRoutes } from "./access/forge-routes";
import { createIdentityConfiguration } from "./access/identity-configuration";
import { createProjectAppPreviews } from "./access/previews";
import { createAccessRevocation } from "./access/revocation";
import { createRuntimeAccess } from "./access/runtime";
import { createAccessService } from "./access/service";
import { createChangeWriterController } from "./access/writer-controller";
import { createWriterService } from "./access/writer-service";
import { createBuildBrowserController } from "./agent/browser-controller";
import { createBuildBrowserEndpoint } from "./agent/browser-endpoint";
import { createCandidateReviewController } from "./agent/candidate-review";
import { createAgentController } from "./agent/controller";
import { createOpenCodeClient } from "./agent/opencode-client";
import { createAgentService } from "./agent/service";
import { createAttachmentRoutes } from "./attachments/routes";
import { createAttachmentStore } from "./attachments/store";
import { createAttachmentTools } from "./attachments/tools";
import { createBootstrapService } from "./bootstrap/service";
import { factoryBuildDirectory } from "./build-directory";
import { createChangeController } from "./change/controller";
import { createTicketDocumentController } from "./change/document";
import { createTicketService } from "./change/service";
import { createTicketTrashController } from "./change/trash";
import { CommandError } from "./command-error";
import { createDeliveryController } from "./delivery/controller";
import { createDeliveryService } from "./delivery/service";
import { createEnvironmentController } from "./environments/controller";
import { createOpenBaoEnvironmentSecrets } from "./environments/openbao";
import { createRuntimeEnvironmentEndpoint } from "./environments/runtime";
import { createEnvironmentService } from "./environments/service";
import { json, sameFactoryOrigin } from "./http";
import { serveFactory } from "./http-listener";
import { installationInMaintenance } from "./installation/maintenance";
import { createKnowledgeController } from "./knowledge/controller";
import { factoryForgeSource } from "./knowledge/forge-source";
import { createKnowledgeService } from "./knowledge/service";
import { createWikiSourceUpdates } from "./knowledge/source-updates";
import { createMCPConnections } from "./mcp/connections";
import { createMCPOAuthCallback } from "./mcp/oauth-callback";
import { createMCPSecrets } from "./mcp/secrets";
import { createMCPService } from "./mcp/service";
import { createMCPSourceEndpoint } from "./mcp/sources";
import { createModelConnections } from "./models/connections";
import { createModelSettingsController } from "./models/controller";
import { createModelRelay } from "./models/relay";
import { createOpenBaoModelSecrets } from "./models/secrets";
import { createModelService } from "./models/service";
import { createMonitoringController } from "./monitoring/controller";
import { createMonitoringRoutes } from "./monitoring/routes";
import { createInputService } from "./monitoring/service";
import { createMonitoringWorker } from "./monitoring/worker";
import { createUIPreferenceController } from "./preferences/controller";
import { projectModelConnection } from "./project-agent/adapter";
import { createProjectAgentController } from "./project-agent/controller";
import { createConversationService } from "./project-agent/service";
import { createProjectService } from "./projects/service";
import { createReleaseController } from "./releases/controller";
import { createReleaseSecrets } from "./releases/secrets";
import { factoryRequestURL } from "./request-origin";
import { createVisualReviewController } from "./review/controller";
import { createReviewMedia } from "./review/media";
import { createReviewMediaRoutes } from "./review/media-routes";
import { createReviewService } from "./review/service";
import { appTimeoutResponse } from "./runtime/app-timeout";
import { createRuntimeWriterBoundary } from "./runtime/browser-writer";
import { createRuntimeController } from "./runtime/controller";
import {
  previewBridgeResponse,
  previewRendererResponse,
  scopeRuntimeEmbedding,
} from "./runtime/embedding";
import {
  runtimeSourcePath,
  serveRuntimeRepository,
  validRuntimeSourceCapability,
} from "./runtime/git-http";
import {
  appRuntimeSocketContext,
  RuntimeHub,
  type RuntimeSocketData,
  scopeTheiaConnectionCookie,
  theiaConnectionToken,
} from "./runtime/hub";
import { createIdleCompute } from "./runtime/idle";
import { createProjectPreparation } from "./runtime/project-preparation";
import { createExecutionReserve } from "./runtime/reserve-controller";
import { createRuntimeService } from "./runtime/service";
import { appRuntimeOrigin } from "./runtime-origins";
import { createServerFunctionEndpoint } from "./server-functions/endpoint";
import { createProjectSetupController } from "./setup/controller";
import { createSetupInspection } from "./setup/inspection";
import { createSetupReadiness } from "./setup/readiness";
import { createImportSecrets } from "./setup/secrets";
import { createSetupService } from "./setup/service";
import { createSkillController } from "./skills/controller";
import { createSkillService } from "./skills/service";
import { createStaticAssets } from "./static-assets";
import { usageCatalogue } from "./usage/rates";
import { createRecordedOpenCodeUsage } from "./usage/record-opencode";
import { createUsageService } from "./usage/service";
import { createDeveloperIDEController } from "./workspace/developer-ide-controller";
import {
  createDeveloperIDEEdge,
  type DeveloperEditorSocketData,
} from "./workspace/developer-ide-edge";
import { createDeveloperIDERuntime } from "./workspace/developer-ide-runtime";
import { createWorkspaceService } from "./workspace/service";
import { createWorkspaceSourceController } from "./workspace/source-controller";
import { createWorkspaceSourceProtocol } from "./workspace/source-protocol";
import { handleZeroMutate, handleZeroQuery } from "./zero/http";

const { FACTORY_ADMIN_PASSWORD, FACTORY_AUTH_SECRET, FACTORY_HOST, FACTORY_ZERO_CACHE_URL } =
  process.env;
const factoryHost = FACTORY_HOST ?? "127.0.0.1";
const factoryOrigin = new URL(process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000").origin;
const forgeAPIURL = process.env["FACTORY_FORGEJO_API_URL"];
if (!forgeAPIURL) throw new Error("Configure the Factory Forgejo API before starting the server");
const forgeTransportOrigin = new URL(forgeAPIURL).origin;
const forgePublicOrigin = new URL(process.env["FACTORY_FORGEJO_PUBLIC_URL"] ?? forgeAPIURL).origin;
const { FACTORY_STARTUP_ID } = process.env;
const startupID = FACTORY_STARTUP_ID ?? crypto.randomUUID();
if (
  !["127.0.0.1", "localhost", "::1"].includes(factoryHost) &&
  (!FACTORY_AUTH_SECRET || !FACTORY_ADMIN_PASSWORD)
) {
  throw new Error(
    "FACTORY_AUTH_SECRET and FACTORY_ADMIN_PASSWORD are required outside a loopback listener",
  );
}
const database = createDatabase();
void usageCatalogue.refresh();
const ticketDocuments = createTicketDocumentController(database);
const runtimeSecret = FACTORY_AUTH_SECRET ?? "local-development-secret-change-before-production";
const factoryAuth = createIdentityConfiguration(database, runtimeSecret, undefined, [
  "https://login.microsoftonline.com",
  ...(process.env["FACTORY_IDENTITY_ALLOWED_ORIGINS"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? []),
]);
await factoryAuth.bootstrap();
const accessController = createAccessController(database);
const forgeAccess = process.env["FACTORY_FORGEJO_ADMIN_TOKEN"]
  ? createForgeAccessReconciliation({
      database,
      forge: createForgejoAccess({
        apiURL: process.env["FACTORY_FORGEJO_API_URL"]!,
        token: process.env["FACTORY_FORGEJO_ADMIN_TOKEN"]!,
      }),
      owner: process.env["FACTORY_FORGEJO_OWNER"]!,
      origin: new URL(process.env["FACTORY_FORGEJO_API_URL"]!).origin,
    })
  : undefined;
let runtimeController: ReturnType<typeof createRuntimeController>;
let changeController: ReturnType<typeof createChangeController>;
let agentController: ReturnType<typeof createAgentController>;
let buildBrowserController: ReturnType<typeof createBuildBrowserController>;
let deliveryController: ReturnType<typeof createDeliveryController>;
let knowledgeController: ReturnType<typeof createKnowledgeController>;
let projectAgentController: ReturnType<typeof createProjectAgentController>;
const uiPreferenceController = createUIPreferenceController(database);
const modelSettingsController = createModelSettingsController(database);
const modelConnections = createModelConnections(
  database,
  createOpenBaoModelSecrets(),
  runtimeSecret,
  process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [],
);
const modelService = createModelService({
  settings: modelSettingsController,
  connections: modelConnections,
  access: accessController,
  signingKey: runtimeSecret,
});
await modelConnections
  .recover()
  .catch(() => console.error("Model connection save recovery is unavailable"));
const environmentSecrets = createOpenBaoEnvironmentSecrets();
const environmentController = createEnvironmentController(
  database,
  environmentSecrets,
  runtimeSecret,
);
const runtimeEnvironmentEndpoint = createRuntimeEnvironmentEndpoint(database, environmentSecrets);
await environmentController
  .recover()
  .catch(() => console.error("Environment save recovery is unavailable"));
const skillService = createSkillService(createSkillController(database), accessController);
const mcpConnections = createMCPConnections(
  database,
  createMCPSecrets(),
  runtimeSecret,
  factoryOrigin,
);
const mcpOAuthCallback = createMCPOAuthCallback(mcpConnections);
await mcpConnections.recover().catch(() => console.error("MCP credential recovery is unavailable"));
const usageService = createUsageService(database);
const runtimeHub = new RuntimeHub(async (attemptID, phase, error) => {
  await runtimeController.status(attemptID, phase, error);
  try {
    agentController?.runtimeActivityChanged();
    if (phase === "ready") {
      if (agentController) await agentController.recoverRuntimeCommits(attemptID);
      if (agentController) await agentController.dispatchRuntimePending(attemptID);
      if (buildBrowserController) await buildBrowserController.recover(attemptID);
    }
  } catch {
    // Persistence succeeded. Dependent recovery must not reject that status
    // and interrupt healthy compute. Pending admissions have their own drain.
    console.error("Runtime work reconciliation needs another observation");
  }
});
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
buildBrowserController = createBuildBrowserController(database, runtimeHub, runtimeSecret);
const mcpSourceEndpoint = createMCPSourceEndpoint(database, mcpConnections, buildBrowserController);
const buildBrowserEndpoint = createBuildBrowserEndpoint(
  buildBrowserController,
  createCandidateReviewController(database),
  visualReview,
  createAttachmentTools(database, attachmentStore),
);
const runtimeAccess = createRuntimeAccess(database, (token) => runtimeHub.revokeAccess(token));
const workspaceSources = createWorkspaceSourceController(database, runtimeSecret);
const reserveImages = {
  staging: process.env["FACTORY_RUNTIME_HOST_IMAGE"],
  verification: process.env["FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE"],
};
if (!reserveImages.staging || !reserveImages.verification)
  throw new Error("Exact runtime role images are required before execution reserve admission");
const executionReserve = createExecutionReserve(database, {
  staging: reserveImages.staging,
  verification: reserveImages.verification,
});
runtimeController = createRuntimeController(
  database,
  runtimeHub,
  runtimeSecret,
  workspaceSources,
  undefined,
  undefined,
  executionReserve,
);
const releaseController = createReleaseController({
  database,
  signingKey: runtimeSecret,
  secrets: createReleaseSecrets(),
  runtime: runtimeController,
  forge: createForgejoClient({ apiURL: forgeAPIURL, token: process.env["FACTORY_FORGEJO_TOKEN"]! }),
  publication: createForgejoReleases({
    apiURL: forgeAPIURL,
    token: process.env["FACTORY_FORGEJO_TOKEN"]!,
    ...(process.env["FACTORY_FORGEJO_ADMIN_TOKEN"]
      ? { adminToken: process.env["FACTORY_FORGEJO_ADMIN_TOKEN"] }
      : {}),
  }),
  apiURL: forgeAPIURL,
  publicURL: forgePublicOrigin,
  owner: process.env["FACTORY_FORGEJO_OWNER"]!,
});
const sourceProtocol = createWorkspaceSourceProtocol(workspaceSources);
const projectAppPreviews = createProjectAppPreviews(database, (id) => runtimeHub.appChannels(id));
const idleCompute = createIdleCompute(database, runtimeHub, runtimeController);
const developerEditors = createDeveloperIDEController(database);
const developerIDEEdge = createDeveloperIDEEdge(
  database,
  developerEditors,
  workspaceSources,
  factoryOrigin,
  createDeveloperIDERuntime(database, runtimeController, runtimeHub, runtimeAccess, {
    view: (changeID, userID) => changeWriters.view(changeID, userID),
    takeOver: (...args) => changeWriters.takeOver(...args),
    activity: (changeID, userID, epoch, kind) =>
      changeWriters.activity(changeID, userID, epoch, kind),
    request: (...args) => changeWriters.request(...args),
    release: (...args) => changeWriters.release(...args),
    approve: (...args) => changeWriters.approve(...args),
    takeIdle: (...args) => changeWriters.takeIdle(...args),
  }),
);
const revokeAccountAccess = createAccountRevocation({
  database,
  sweepRuntime: () => runtimeAccess.sweep(),
  reconcileEditor: (userID) => developerIDEEdge.sweep(userID),
  reconcileSources: (userID) => workspaceSources.reconcileUserAccess(userID),
  stopRuntime: (attemptID) => runtimeController.stop(attemptID),
  stopAgent: async (changeID) => agentController?.stop(changeID),
  reconcileForge: async (userID) => forgeAccess?.reconcile(userID),
});
const accessRevocation = createAccessRevocation(database, revokeAccountAccess);
const forgeIdentityRoutes = createForgeIdentityRoutes({
  database,
  identity: factoryAuth,
  forgeOrigin: forgePublicOrigin,
  discoveryURL:
    process.env["FACTORY_FORGE_DISCOVERY_URL"] ??
    `${factoryOrigin}/api/auth/.well-known/openid-configuration`,
  reconcile: accessRevocation.drain,
});
const accessService = createAccessService({
  database,
  identity: factoryAuth,
  async revokeMember(projectID, userID) {
    await runtimeAccess.revokeMember(projectID, userID);
    await workspaceSources.revokeMember(projectID, userID);
    await developerEditors.revokeMember(projectID, userID);
    developerIDEEdge.revokeUser(userID);
  },
  revokeAccount: revokeAccountAccess,
  forgeOrigin: forgeAccess ? forgePublicOrigin : undefined,
});
const observeRecoveredRuntimes = await runtimeController.recover();
await workspaceSources.recover();
await developerEditors.recover();
changeController = createChangeController(
  database,
  runtimeController,
  async (changeID) => {
    await agentController?.dispatchPending(changeID);
  },
  async (changeID) => {
    if (!forgeAccess) throw new CommandError("unavailable", "Forge protection is not configured");
    // Native branch creation itself is a protected write. Only the existing
    // Factory control identity may create it; developers remain excluded.
    await forgeAccess.protectChange(changeID, [process.env["FACTORY_FORGEJO_OWNER"]!]);
  },
);
await changeController.recover();
await buildBrowserController.recover();
const changeWriters = createChangeWriterController({
  database,
  runtime: runtimeController,
  stopAgent: (changeID) => agentController.stop(changeID),
  agentUsername: process.env["FACTORY_FORGEJO_OWNER"]!,
  fenceSource: workspaceSources.fenceChange,
  protect: async (changeID, writers) => {
    if (!forgeAccess)
      throw new CommandError("unavailable", "Forge writing authority is not configured");
    await forgeAccess.protectChange(changeID, writers);
  },
});
agentController = createAgentController(
  database,
  runtimeHub,
  runtimeController,
  buildBrowserController,
  changeWriters,
);
await agentController.recover();
deliveryController = createDeliveryController(
  database,
  runtimeController,
  agentController,
  async (changeID) => {
    if (!forgeAccess)
      throw new CommandError("unavailable", "Forge branch retirement is not configured");
    await forgeAccess.protectChange(changeID, []);
  },
);
const ticketTrash = createTicketTrashController(
  database,
  runtimeController,
  agentController,
  deliveryController,
);
await ticketTrash.recover();
await deliveryController.recover();
knowledgeController = createKnowledgeController(database);
await knowledgeController.recover();
projectAgentController = createProjectAgentController(
  database,
  changeController,
  knowledgeController,
  mcpConnections,
  (conversationID, contextID) => agentController.retainedMessages(conversationID, contextID),
);
await projectAgentController.recover();
const monitoringController = createMonitoringController(
  database,
  runtimeSecret,
  factoryOrigin,
  (projectId) => {
    void monitoringWorker.project(projectId).catch(() => {});
  },
);
const monitoringWorker = createMonitoringWorker(database, {
  mcp: mcpConnections,
  code: knowledgeController,
  changes: changeController,
  agent: agentController,
  delivery: deliveryController,
  signingKey: runtimeSecret,
});
const monitoringRoutes = createMonitoringRoutes(monitoringController);
await monitoringWorker.recover();
await accessRevocation.start();

function sameRuntimeOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return (
    origin !== null && new URL(origin).origin === factoryRequestURL(request, factoryOrigin).origin
  );
}

async function runtimeReady(attemptID: string) {
  const attempts = await database.client<Array<{ ready: boolean }>>`
    SELECT state = 'ready' AS ready FROM factory.runtime_attempt WHERE id = ${attemptID}
  `;
  return attempts[0]?.ready === true;
}

async function requireSession(request: Request) {
  return factoryAuth.session(request);
}

const preparationForge = createForgejoClient({
  apiURL: process.env["FACTORY_FORGEJO_API_URL"]!,
  token: process.env["FACTORY_FORGEJO_TOKEN"]!,
});
const projectPreparation = createProjectPreparation({
  database,
  start: (id) => runtimeController.startProjectPrebuild(id),
  finish: (id) => runtimeController.status(id, "stopped"),
  expire: (id) =>
    runtimeController.status(
      id,
      "failed",
      "Project image preparation exceeded its twelve-minute bound; normal startup remains available",
    ),
  head: async (projectID) => {
    const [project] = await database.client<
      Array<{ url: string }>
    >`SELECT repository_url AS url FROM factory.project WHERE id=${projectID}`;
    if (!project) throw new Error("Project not found");
    const repository = factoryForgeSource(
      project.url,
      process.env["FACTORY_FORGEJO_API_URL"]!,
      process.env["FACTORY_FORGEJO_OWNER"]!,
    );
    return (await preparationForge.getDefaultBranch(repository)).headSha;
  },
});
const wikiSourceUpdates = createWikiSourceUpdates({
  database,
  forge: createForgejoClient({
    apiURL: process.env["FACTORY_FORGEJO_API_URL"]!,
    token: process.env["FACTORY_FORGEJO_TOKEN"]!,
  }),
  apiURL: process.env["FACTORY_FORGEJO_API_URL"]!,
  owner: process.env["FACTORY_FORGEJO_OWNER"]!,
  receiverURL:
    process.env["FACTORY_WIKI_WEBHOOK_URL"] ??
    process.env["FACTORY_BASE_URL"] ??
    `http://127.0.0.1:${process.env["FACTORY_PORT"] ?? "3000"}`,
  signingKey: process.env["FACTORY_WIKI_WEBHOOK_SECRET"] ?? runtimeSecret,
  reconcile: (projectID) => knowledgeController.reconcile(projectID),
  prepareProject: projectPreparation.ensure,
});
const projectService = createProjectService({
  database,
  localRepositoryOrigin: new URL(process.env["FACTORY_FORGEJO_API_URL"] ?? "").origin,
  ensureStaging: (projectID, userID) => runtimeController.ensureStaging(projectID, userID),
  generateKnowledge: (projectID, userID) => knowledgeController.generate(projectID, userID),
  ensureKnowledgeHook: async (projectID) => {
    await wikiSourceUpdates.ensure(projectID);
    await projectPreparation.ensure(projectID);
  },
  forgeOwner: process.env["FACTORY_FORGEJO_OWNER"]!,
});
const setupReadiness = createSetupReadiness({
  database,
  environments: environmentController,
  signingKey: runtimeSecret,
  requiredVariables: async (projectID) => {
    const [project] = await database.client<
      { slug: string }[]
    >`SELECT slug FROM factory.project WHERE id=${projectID}`;
    if (!project) throw new Error("Project not found");
    const repository = { owner: process.env["FACTORY_FORGEJO_OWNER"]!, name: project.slug };
    const head = await preparationForge.getDefaultBranch(repository);
    const inventory = await preparationForge.listFiles(repository, head.headSha);
    const configurations = inventory
      .filter(
        (file) => /^\.devcontainer\/.*(?:\.json|\.ya?ml)$/.test(file.path) && file.size <= 64000,
      )
      .slice(0, 32);
    const { requiredEnvironmentVariables } = await import("./setup/configuration");
    return requiredEnvironmentVariables(
      await Promise.all(
        configurations.map((file) => preparationForge.getFile(repository, file.path, head.headSha)),
      ),
    );
  },
  protection: async (projectID) => {
    const [project] = await database.client<
      { slug: string; branch: string }[]
    >`SELECT slug,default_branch AS branch FROM factory.project WHERE id=${projectID}`;
    if (!project) throw new Error("Project not found");
    await preparationForge.ensureDefaultBranchProtection(
      { owner: process.env["FACTORY_FORGEJO_OWNER"]!, name: project.slug },
      project.branch,
    );
    await preparationForge.protectSetupWorkflow(
      { owner: process.env["FACTORY_FORGEJO_OWNER"]!, name: project.slug },
      project.branch,
    );
  },
  hook: async (projectID) => {
    await wikiSourceUpdates.ensure(projectID);
    const [hook] =
      await database.client`SELECT hook_state FROM factory.wiki_source_update WHERE project_id=${projectID}`;
    if (hook?.["hook_state"] !== "ready") throw new Error("Repository hook needs retry");
  },
  wiki: async (projectID, userID, automatic) => {
    const generation = await knowledgeController.generate(projectID, userID, automatic);
    if (!generation) throw new Error("Wiki generation was not admitted");
    return z.uuid().parse(generation["id"]);
  },
  prepare: async (projectID) => {
    await projectPreparation.ensure(projectID);
    const images = await database.client<
      { id: string; environment: string }[]
    >`SELECT DISTINCT ON(environment) id,environment FROM factory.project_image_preparation WHERE project_id=${projectID} ORDER BY environment,created_at DESC`;
    const development = images.find((image) => image.environment === "development")?.id;
    const preview = images.find((image) => image.environment === "main-preview")?.id;
    if (!development || !preview) throw new Error("Image preparation was not admitted");
    return { development, preview };
  },
  preview: async (projectID, userID) => {
    const attempt = await runtimeController.ensureStaging(projectID, userID);
    if (!attempt) throw new Error("Main-Preview was not admitted");
    return attempt.id;
  },
});
const projectSetup = createProjectSetupController({
  database,
  forge: preparationForge,
  forgeOwner: process.env["FACTORY_FORGEJO_OWNER"]!,
  forgeOrigin: new URL(process.env["FACTORY_FORGEJO_API_URL"]!).origin,
  secrets: createImportSecrets(),
  signingKey: runtimeSecret,
  importOrigins: projectImportOrigins(process.env["FACTORY_GIT_IMPORT_ORIGINS"]),
  onCreated: async (projectID, userID) => {
    // Configuration confirmation owns runtime readiness. Creation itself keeps
    // planning available without starting arbitrary imported Project code.
    const [intent] =
      await database.client`SELECT kind FROM factory.project_repository_intent WHERE project_id=${projectID}`;
    void setupReadiness
      .start(projectID, userID, intent?.["kind"] === "starter")
      .catch(() => console.error("Project preparation needs attention"));
    if (intent?.["kind"] === "import")
      void setupInspection
        .start(projectID, userID, projectID)
        .catch(() => console.error("Project configuration inspection needs attention"));
  },
});
const setupInspection = createSetupInspection({
  database,
  forge: preparationForge,
  forgeURL: process.env["FACTORY_FORGEJO_API_URL"]!,
  forgeOwner: process.env["FACTORY_FORGEJO_OWNER"]!,
  model: async (projectID, userID, sql) => {
    const modelID = await modelSettingsController.resolve("planning", sql, { projectID, userID });
    const reference = await modelConnections.reference("planning", sql);
    return {
      modelID,
      connectionID: reference?.connectionID ?? null,
      connectionVersion: reference?.version ?? null,
    };
  },
  connection: async (reference) =>
    reference.connectionID && reference.connectionVersion
      ? modelConnections.resolve(reference.connectionID, reference.connectionVersion)
      : projectModelConnection(),
  ready: async (projectID, userID) => {
    await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,command_id,state)
      VALUES(${projectID},'configuration',${crypto.randomUUID()},'ready')
      ON CONFLICT(project_id,task) DO UPDATE SET state='ready',failure=NULL`;
    void setupReadiness
      .start(projectID, userID, false)
      .catch(() => console.error("Confirmed Project preparation needs attention"));
  },
});
await setupInspection
  .recover()
  .catch(() => console.error("Project inspection recovery is unavailable"));
await projectSetup.recover().catch(() => console.error("Project setup recovery is unavailable"));
await setupReadiness
  .recover()
  .catch(() => console.error("Project preparation recovery is unavailable"));

const buildDirectory = factoryBuildDirectory();
const planningCacheURL =
  process.env["FACTORY_ZERO_CACHE_PUBLIC_URL"] ?? FACTORY_ZERO_CACHE_URL ?? "http://127.0.0.1:4948";
const bootstrapService = createBootstrapService({
  policy: () => factoryAuth.policy,
  preference: uiPreferenceController.get,
  planningCacheURL,
  forgeOrigins: { browser: forgePublicOrigin, transport: forgeTransportOrigin },
  async modelAvailability() {
    return Boolean(
      (process.env["FACTORY_MODEL_BASE_URL"] && process.env["FACTORY_MODEL_API_KEY"]) ||
        (await database.client.begin((sql) => modelConnections.reference("build", sql))),
    );
  },
});
const serverFunctionEntry = pathToFileURL(resolve(buildDirectory, "server/entry.js")).href;
const serverFunctions: typeof import("./server-functions/entry") = await import(
  serverFunctionEntry
);
const serverFunctionEndpoint = createServerFunctionEndpoint({
  origin: factoryOrigin,
  session: requireSession,
  services: {
    releases: releaseController,
    projects: projectService,
    delivery: createDeliveryService({ access: accessController, controller: deliveryController }),
    runtime: createRuntimeService({
      database,
      access: accessController,
      changes: changeController,
      runtime: runtimeController,
      previews: projectAppPreviews,
      closeBrowser: (id) => buildBrowserController.closeChange(id),
      cancelDelivery: (id) => deliveryController.cancel(id),
      revokeAttempt: (id) => runtimeAccess.revokeAttempt(id),
      suspendAttempt: (id) => runtimeHub.suspend(id),
    }),
    agent: createAgentService({ access: accessController, controller: agentController }),
    conversations: createConversationService({
      access: accessController,
      controller: projectAgentController,
    }),
    tickets: createTicketService({
      database,
      access: accessController,
      documents: ticketDocuments,
      trash: ticketTrash,
      changes: changeController,
      agent: agentController,
    }),
    usage: usageService,
    models: modelService,
    environments: createEnvironmentService(environmentController, projectPreparation.ensure),
    access: accessService,
    bootstrap: bootstrapService,
    setup: createSetupService({
      database,
      drafts: projectSetup,
      inspection: setupInspection,
      readiness: setupReadiness,
    }),
    skills: skillService,
    mcp: createMCPService(mcpConnections),
    inputs: createInputService(monitoringController, accessController),
    writer: createWriterService(changeWriters, accessController),
    review: createReviewService({
      controller: visualReview,
      access: accessController,
      admit: (changeID, userID, sql, text, commandID) =>
        agentController.admitPromptIn(sql, changeID, userID, text, commandID),
      dispatchPending: (changeID) => agentController.dispatchPending(changeID),
    }),
    attachments: attachmentStore,
    workspaces: createWorkspaceService({
      sources: workspaceSources,
      editors: developerEditors,
      revokeEditor: (userID) => developerIDEEdge.revokeUser(userID),
    }),
    knowledge: createKnowledgeService({
      controller: knowledgeController,
      access: accessController,
      observeRetry: (projectID, userID, generationID) =>
        setupReadiness.observeWikiRetry(projectID, userID, generationID),
    }),
  },
  maintenance: () =>
    process.env["FACTORY_HELM_RELEASE"]
      ? installationInMaintenance(database)
      : Promise.resolve(false),
  requireFresh: (request) => factoryAuth.requireFresh(request),
  handle: serverFunctions.handleServerFunctionRequest,
  publicFunctionIDs: serverFunctions.publicFunctionIDs,
});
const staticAssets = createStaticAssets(resolve(buildDirectory, "client"));

async function route(request: Request) {
  const publicationCredentials = new URL(request.url).pathname.match(
    /^\/internal\/releases\/([0-9a-f-]{36})\/credentials$/,
  );
  if (publicationCredentials) {
    return releaseController
      .credentials(request, publicationCredentials[1]!)
      .catch(() => new Response(null, { status: 503, headers: { "cache-control": "no-store" } }));
  }
  if (
    process.env["FACTORY_HELM_RELEASE"] &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    new URL(request.url).pathname.startsWith("/api/") &&
    !new URL(request.url).pathname.startsWith("/api/auth/") &&
    new URL(request.url).pathname !== "/api/zero/query" &&
    (await installationInMaintenance(database))
  )
    return json(
      {
        error:
          "Factory is being updated. Your saved work is retained. Try again after maintenance.",
      },
      503,
      { "retry-after": "30" },
    );
  const url = factoryRequestURL(request, factoryOrigin);
  try {
    if (url.pathname === "/_server" || url.pathname.startsWith("/_server/"))
      return await serverFunctionEndpoint(request);
    const monitoringIntake = await monitoringRoutes.intake(request);
    if (monitoringIntake) return monitoringIntake;
    const runtimeEnvironment = url.pathname.match(
      /^\/internal\/runtime-environment\/([0-9a-f-]{36})$/,
    );
    if (runtimeEnvironment?.[1]) return runtimeEnvironmentEndpoint(request, runtimeEnvironment[1]);
    const projectImage = url.pathname.match(/^\/internal\/project-image\/([0-9a-f-]{36})$/);
    if (projectImage?.[1]) return projectPreparation.endpoint(request, projectImage[1]);
    const sourceEvent = url.pathname.match(/^\/api\/wiki\/source-events\/([0-9a-f-]{36})$/);
    if (sourceEvent?.[1]) return await wikiSourceUpdates.receive(request, sourceEvent[1]);
    if (developerIDEEdge.matches(url.pathname)) return await developerIDEEdge.route(request);
    const sourceRepository = url.pathname.match(
      /^\/internal\/workspace-source\/([0-9a-f-]{36})\/([1-9][0-9]*)\/([0-9a-f]{64})(?:\/|$)/,
    );
    if (sourceRepository?.[1] && sourceRepository[2] && sourceRepository[3]) {
      const prefix = `/internal/workspace-source/${sourceRepository[1]}/${sourceRepository[2]}/${sourceRepository[3]}`;
      return workspaceSources.repository(
        request,
        sourceRepository[1],
        sourceRepository[2],
        sourceRepository[3],
        prefix,
      );
    }
    const modelRelay = url.pathname.match(
      /^\/internal\/model\/([0-9a-f-]+)\/v1\/(chat\/completions|responses|messages)$/,
    );
    const browserTool = url.pathname.match(
      /^\/internal\/build-browser\/([0-9a-f-]+)\/([0-9a-f-]+)$/,
    );
    if (browserTool?.[1] && browserTool[2])
      return buildBrowserEndpoint(request, { attemptID: browserTool[1], turnID: browserTool[2] });
    const sourceTool = url.pathname.match(/^\/internal\/mcp\/([0-9a-f-]+)\/([0-9a-f-]+)$/);
    if (sourceTool?.[1] && sourceTool[2])
      return mcpSourceEndpoint(request, sourceTool[1], sourceTool[2]);
    if (modelRelay) {
      const [, attemptID, suffix] = modelRelay;
      if (!attemptID || !suffix) return new Response("Not found", { status: 404 });
      return relayModel(request, attemptID, suffix);
    }
    if (url.pathname === "/api/auth/.well-known/openid-configuration" && request.method === "GET")
      return json(await factoryAuth.discovery());
    if (url.pathname.startsWith("/api/auth/")) return factoryAuth.handler(request);
    if (url.pathname === "/api/zero/query" && request.method === "POST") {
      return handleZeroQuery(request, database, await requireSession(request));
    }
    if (url.pathname === "/api/zero/mutate" && request.method === "POST") {
      if (!sameFactoryOrigin(request))
        return json({ error: "Factory command origin is invalid" }, 403);
      return handleZeroMutate(request, database, await requireSession(request));
    }
    if (
      url.pathname.startsWith("/api/") &&
      request.method !== "GET" &&
      !sameFactoryOrigin(request)
    ) {
      return json({ error: "Factory command origin is invalid" }, 403);
    }
    if (url.pathname.startsWith("/api/attachments/")) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      return (
        (await attachmentRoutes(request, session.user.id)) ?? new Response(null, { status: 404 })
      );
    }
    if (url.pathname === "/health/ready") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405 });
      return json({ ready: true, planningCacheURL }, 200, {
        "x-open-factory": "ready",
        "x-open-factory-startup": startupID,
        "cache-control": "no-store",
      });
    }
    if (url.pathname.startsWith("/api/")) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      await accessController.authorizeAPI(request, session.user.id);
      const forgeIdentityResponse = await forgeIdentityRoutes(request, session.user.id);
      if (forgeIdentityResponse) return forgeIdentityResponse;
      const reviewMediaResponse = await reviewMediaRoutes(request, session.user.id);
      if (reviewMediaResponse) return reviewMediaResponse;
      const mcpResponse = await mcpOAuthCallback(request, session.user.id);
      if (mcpResponse) return mcpResponse;
      const sourceResponse = await sourceProtocol(request, session.user.id);
      if (sourceResponse) return sourceResponse;
    }
    if (url.pathname === "/api/developer-ide/access" && request.method === "GET") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const workspaceID = url.searchParams.get("workspace") ?? undefined;
      if (workspaceID && !/^[a-f0-9-]{36}$/.test(workspaceID))
        return json({ error: "Workspace identity is invalid" }, 400);
      return Response.redirect(
        await developerIDEEdge.issue(
          session.user.id,
          session.session.id,
          url.searchParams.get("embed") === "1",
          workspaceID,
        ),
        302,
      );
    }
    if (url.pathname === "/api/runtime-access" && request.method === "GET") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const path = url.searchParams.get("path");
      const parsed = path?.match(
        /^\/runtime\/([0-9a-f-]+)\/(app|ide|preview\/(app(?:-[a-z][a-z0-9-]{0,26})?))\//,
      );
      const attemptID = parsed?.[1];
      const route = parsed?.[2];
      const previewChannel = parsed?.[3];
      const channel = route === "ide" ? "ide" : "app";
      if (!path || !attemptID || !route) {
        return json({ error: "Runtime path is invalid" }, 400);
      }
      await accessController.requireRuntime(session.user.id, attemptID, channel);
      if (!(await runtimeReady(attemptID))) return json({ error: "Runtime is not ready" }, 409);
      if (previewChannel && !runtimeHub.hasAppChannel(attemptID, previewChannel)) {
        return json({ error: "Declared App is not available" }, 404);
      }
      const token = await runtimeAccess.issue({
        attemptID,
        channel,
        userID: session.user.id,
        sessionID: session.session.id,
        expires: Date.now() + 8 * 60 * 60 * 1_000,
        mode: url.searchParams.get("embed") === "1" ? "embedded" : "top-level",
      });
      const destination = new URL(path, process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000");
      destination.host = new URL(appRuntimeOrigin(factoryOrigin, attemptID, channel)).host;
      destination.searchParams.set("factory-grant", token);
      return Response.redirect(destination, 302);
    }
    const channelRequest = url.pathname.match(/^\/runtime\/([0-9a-f-]+)\/(app|ide)(\/.*)?$/);
    if (channelRequest) {
      const [, attemptID, channel, suffix] = channelRequest;
      if (!attemptID || (channel !== "app" && channel !== "ide"))
        return new Response("Not found", { status: 404 });
      const redeemed = await runtimeAccess.redeem(
        url,
        attemptID,
        channel,
        `/runtime/${attemptID}/${channel}/`,
      );
      if (redeemed) return redeemed;
      const accessToken = await runtimeAccess.authorize(request, attemptID, channel);
      if (!accessToken) {
        return json({ error: "Runtime access required" }, 401);
      }
      if (!(await runtimeReady(attemptID))) return json({ error: "Runtime is not ready" }, 409);
      if (channel === "ide" && suffix === "/__factory/processes") {
        return json(await runtimeController.processOutput(attemptID));
      }
      if (channel === "app" && suffix === "/__factory/review-bridge.js" && request.method === "GET")
        return previewBridgeResponse(factoryOrigin);
      if (
        channel === "app" &&
        suffix === "/__factory/review-renderer.js" &&
        request.method === "GET"
      )
        return previewRendererResponse();
      const processAction =
        channel === "ide"
          ? suffix?.match(
              /^\/__factory\/processes\/(app(?:-[a-z][a-z0-9-]{0,26})?)\/(start|stop|restart)$/,
            )
          : undefined;
      if (processAction && request.method === "POST") {
        if (!sameRuntimeOrigin(request)) return json({ error: "Runtime origin is invalid" }, 403);
        const process = processAction[1];
        const action = processAction[2] as "start" | "stop" | "restart";
        if (!process) return json({ error: "Declared App is required" }, 400);
        try {
          const userID = await runtimeAccess.user(accessToken);
          return database.client.begin(async (sql) => {
            await runtimeWriteAuthorityIn(sql, attemptID, userID);
            return json(await runtimeController.processAction(attemptID, process, action));
          });
        } catch (cause) {
          return json(
            { error: cause instanceof Error ? cause.message : "Process action failed" },
            409,
          );
        }
      }
      const terminalClose =
        channel === "ide"
          ? suffix?.match(/^\/__factory\/terminals\/([a-zA-Z0-9_-]{1,64})$/)
          : undefined;
      if (terminalClose && request.method === "DELETE") {
        if (!sameRuntimeOrigin(request)) return json({ error: "Runtime origin is invalid" }, 403);
        const terminalID = terminalClose[1];
        if (!terminalID) return json({ error: "Terminal session is required" }, 400);
        try {
          const userID = await runtimeAccess.user(accessToken);
          return database.client.begin(async (sql) => {
            await runtimeWriteAuthorityIn(sql, attemptID, userID);
            return json(await runtimeController.closeTerminal(attemptID, terminalID));
          });
        } catch (cause) {
          return json(
            { error: cause instanceof Error ? cause.message : "Terminal close failed" },
            409,
          );
        }
      }
      const path = `${suffix || "/"}${url.search}`;
      const response = await runtimeHub.request(
        attemptID,
        channel,
        request,
        path,
        async (send) => {
          if (!runtimeAccess.has(accessToken))
            throw new CommandError("forbidden", "Runtime access revoked");
          send();
        },
        accessToken,
      );
      return channel === "ide"
        ? scopeTheiaConnectionCookie(response, `/runtime/${attemptID}/ide/`)
        : scopeRuntimeEmbedding(
            response,
            factoryOrigin,
            `/runtime/${attemptID}/app/__factory/review-bridge.js`,
          );
    }
    const appPreviewRequest = url.pathname.match(
      /^\/runtime\/([0-9a-f-]+)\/preview\/(app(?:-[a-z][a-z0-9-]{0,26})?)(\/.*)?$/,
    );
    if (appPreviewRequest) {
      const [, attemptID, appChannel, suffix] = appPreviewRequest;
      if (!attemptID || !appChannel) return new Response("Not found", { status: 404 });
      const redeemed = await runtimeAccess.redeem(
        url,
        attemptID,
        "app",
        `/runtime/${attemptID}/preview/${appChannel}/`,
      );
      if (redeemed) return redeemed;
      const accessToken = await runtimeAccess.authorize(request, attemptID, "app");
      if (!accessToken) {
        return json({ error: "Runtime access required" }, 401);
      }
      if (!(await runtimeReady(attemptID))) return json({ error: "Runtime is not ready" }, 409);
      if (!runtimeHub.hasAppChannel(attemptID, appChannel)) {
        return json({ error: "Declared App is not available" }, 404);
      }
      if (suffix === "/__factory/review-bridge.js" && request.method === "GET")
        return previewBridgeResponse(factoryOrigin);
      if (suffix === "/__factory/review-renderer.js" && request.method === "GET")
        return previewRendererResponse();
      const response = await runtimeHub.request(
        attemptID,
        appChannel,
        request,
        `${suffix || "/"}${url.search}`,
        async (send) => {
          if (!runtimeAccess.has(accessToken))
            throw new CommandError("forbidden", "Runtime access revoked");
          send();
        },
        accessToken,
      );
      return scopeRuntimeEmbedding(
        response,
        factoryOrigin,
        `/runtime/${attemptID}/preview/${appChannel}/__factory/review-bridge.js`,
      );
    }
    const runtimeSource = url.pathname.match(
      /^\/internal\/runtime-source\/([a-z0-9-]+)\/([0-9a-f]{64})(\/.*)?$/,
    );
    if (runtimeSource) {
      const attemptID = runtimeSource[1];
      const capability = runtimeSource[2];
      if (!attemptID || !capability || !validRuntimeSourceCapability(attemptID, capability))
        return new Response("Not found", { status: 404 });
      const rows = await database.client<Array<{ repositoryUrl: string }>>`
        SELECT project.repository_url AS "repositoryUrl"
        FROM factory.runtime_attempt attempt
        JOIN factory.project project ON project.id = attempt.project_id
        WHERE attempt.id = ${attemptID}
          AND attempt.state IN ('create-intended', 'starting')
          AND attempt.stop_intended_at IS NULL
      `;
      const repository = rows[0];
      if (!repository) return new Response("Not found", { status: 404 });
      return serveRuntimeRepository(
        request,
        repository.repositoryUrl.startsWith("file://")
          ? `file://${runtimeSourcePath(attemptID)}`
          : repository.repositoryUrl,
        `/internal/runtime-source/${attemptID}/${capability}`,
      );
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return staticAssets(request);
  } catch (cause) {
    if (cause instanceof CommandError)
      return json({ error: cause.message, code: cause.code }, cause.status);
    if (cause instanceof z.ZodError)
      return json({ error: "Invalid command. Check the entered values." }, 400);
    console.error(cause);
    if (cause instanceof SystemContractError) return json({ error: cause.message }, 422);
    return appTimeoutResponse(request, cause) ?? json({ error: "Factory command failed" }, 500);
  }
}

const { FACTORY_PORT } = process.env;
type FactorySocketData = RuntimeSocketData | DeveloperEditorSocketData;
const runtimeWriter = createRuntimeWriterBoundary(runtimeHub, async (data, send) => {
  if (data.kind !== "browser" || !data.accessToken)
    throw new Error("Interactive identity is required");
  const userID = await runtimeAccess.user(data.accessToken);
  await database.client.begin(async (sql) => {
    await runtimeWriteAuthorityIn(sql, data.attemptID, userID);
    if (!runtimeAccess.has(data.accessToken!)) throw new Error("Interactive access revoked");
    send();
  });
});
const servers = serveFactory<FactorySocketData>(factoryHost, {
  port: Number(FACTORY_PORT ?? 3000),
  idleTimeout: 180,
  async fetch(request, server) {
    const url = factoryRequestURL(request, factoryOrigin);
    if (/^\/internal\/build-browser\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(url.pathname))
      // Cold image preparation has its own 180-second bound, followed by the
      // bounded container and cold Chrome setup. Do not time out transport first.
      server.timeout(request, 270);
    if (
      developerIDEEdge.matches(url.pathname) &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      try {
        const data = url.pathname.includes("/__factory/")
          ? await developerIDEEdge.executionSocketData(request)
          : await developerIDEEdge.socketData(request);
        if (data instanceof Response) return data;
        if (!server.upgrade(request, { data }))
          return json({ error: "Editor connection failed" }, 500);
        return undefined;
      } catch (cause) {
        if (cause instanceof CommandError) return json({ error: cause.message }, cause.status);
        return json({ error: "Editor connection unavailable" }, 503);
      }
    }
    if (url.pathname === "/internal/runtime-connect") {
      const data = runtimeHub.authorize(request, hashConnectorToken);
      if (!data) return new Response("Unauthorized", { status: 401 });
      if (
        !server.upgrade(request, {
          data,
          headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
        })
      ) {
        return new Response("Upgrade failed", { status: 500 });
      }
      return undefined;
    }
    const factoryTerminalSocket = url.pathname.match(
      /^\/runtime\/([0-9a-f-]+)\/ide\/__factory\/terminal\/([a-zA-Z0-9_-]{1,64})$/,
    );
    if (factoryTerminalSocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const attemptID = factoryTerminalSocket[1];
      const terminalID = factoryTerminalSocket[2];
      const accessToken = attemptID
        ? await runtimeAccess.authorize(request, attemptID, "ide")
        : undefined;
      if (!attemptID || !accessToken) {
        return new Response("Runtime access required", { status: 401 });
      }
      if (!(await runtimeReady(attemptID))) {
        return new Response("Runtime is not ready", { status: 409 });
      }
      if (
        !server.upgrade(request, {
          data: {
            kind: "browser",
            attemptID,
            channel: "terminal",
            path: `/${terminalID}`,
            accessToken,
          },
        })
      ) {
        return new Response("Upgrade failed", { status: 500 });
      }
      return undefined;
    }
    const appPreviewSocket = url.pathname.match(
      /^\/runtime\/([0-9a-f-]+)\/preview\/(app(?:-[a-z][a-z0-9-]{0,26})?)(\/.*)?$/,
    );
    if (appPreviewSocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const [, attemptID, appChannel, suffix] = appPreviewSocket;
      const accessToken = attemptID
        ? await runtimeAccess.authorize(request, attemptID, "app")
        : undefined;
      if (!attemptID || !appChannel || !accessToken) {
        return new Response("Runtime access required", { status: 401 });
      }
      if (!(await runtimeReady(attemptID))) {
        return new Response("Runtime is not ready", { status: 409 });
      }
      if (!runtimeHub.hasAppChannel(attemptID, appChannel)) {
        return new Response("Declared App is not available", { status: 404 });
      }
      const socketContext = appRuntimeSocketContext(request, `${suffix || "/"}${url.search}`);
      if (
        !server.upgrade(request, {
          ...(socketContext.protocol
            ? { headers: { "sec-websocket-protocol": socketContext.protocol } }
            : {}),
          data: {
            kind: "browser",
            attemptID,
            channel: appChannel,
            path: `${suffix || "/"}${url.search}`,
            ...socketContext,
            accessToken,
          },
        })
      ) {
        return new Response("Upgrade failed", { status: 500 });
      }
      return undefined;
    }
    const channelSocket = url.pathname.match(/^\/runtime\/([0-9a-f-]+)\/(app|ide)(\/.*)?$/);
    if (channelSocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const [, attemptID, channel, suffix] = channelSocket;
      if (!attemptID || (channel !== "app" && channel !== "ide"))
        return new Response("Not found", { status: 404 });
      const accessToken = await runtimeAccess.authorize(request, attemptID, channel);
      if (!accessToken) return new Response("Runtime access required", { status: 401 });
      if (!(await runtimeReady(attemptID)))
        return new Response("Runtime is not ready", { status: 409 });
      const path = `${suffix || "/"}${url.search}`;
      const connectionToken = channel === "ide" ? theiaConnectionToken(request.headers) : undefined;
      const socketContext: { headers?: Record<string, string>; protocol?: string } =
        channel === "app" ? appRuntimeSocketContext(request, path) : {};
      if (
        !server.upgrade(request, {
          ...(socketContext.protocol
            ? { headers: { "sec-websocket-protocol": socketContext.protocol } }
            : {}),
          data: {
            kind: "browser",
            attemptID,
            channel,
            path,
            accessToken,
            ...socketContext,
            ...(connectionToken ? { theiaConnectionToken: connectionToken } : {}),
          },
        })
      )
        return new Response("Upgrade failed", { status: 500 });
      return undefined;
    }
    return route(request);
  },
  websocket: {
    maxPayloadLength: 12 << 20,
    open(socket) {
      if (socket.data.kind === "developer-editor") {
        developerIDEEdge.open(socket as ServerWebSocket<DeveloperEditorSocketData>);
        return;
      }
      if (
        socket.data.kind === "browser" &&
        socket.data.accessToken &&
        !runtimeAccess.has(socket.data.accessToken)
      ) {
        socket.close(1008, "Runtime access revoked");
        return;
      }
      runtimeWriter.open(socket as ServerWebSocket<RuntimeSocketData>);
    },
    message(socket, message) {
      if (socket.data.kind === "developer-editor")
        developerIDEEdge.message(socket as ServerWebSocket<DeveloperEditorSocketData>, message);
      else runtimeWriter.message(socket as ServerWebSocket<RuntimeSocketData>, message);
    },
    close(socket) {
      if (socket.data.kind === "developer-editor")
        developerIDEEdge.close(socket as ServerWebSocket<DeveloperEditorSocketData>);
      else runtimeWriter.close(socket as ServerWebSocket<RuntimeSocketData>);
    },
  },
});

observeRecoveredRuntimes();
void executionReserve.start();
idleCompute.start();
console.log(`Factory listening on ${servers[0]!.url}`);
let releasesReconciling = false;
setInterval(() => {
  if (releasesReconciling) return;
  releasesReconciling = true;
  void releaseController
    .recover()
    .catch(() => console.error("Release observation is unavailable"))
    .finally(() => {
      releasesReconciling = false;
    });
}, 5_000).unref();

setInterval(() => {
  void runtimeAccess.sweep().catch(() => console.error("Runtime access refresh failed"));
}, 60_000).unref();
setInterval(() => {
  void environmentSecrets
    .renew?.()
    .catch(() => console.error("Environment secret store renewal failed"));
  void environmentController
    .recover()
    .catch(() => console.error("Environment save recovery failed"));
}, 60 * 60_000).unref();
setInterval(() => {
  void developerIDEEdge.sweep().catch(() => console.error("Editor access refresh failed"));
}, 30_000).unref();
let projectSetupReconciling = false;
setInterval(() => {
  if (projectSetupReconciling) return;
  projectSetupReconciling = true;
  // Observe only already-admitted creates. Recovery cannot repeat an unconfirmed
  // repository/import write, and each setup retains its cross-process lock.
  void projectSetup
    .recover()
    .catch(() => console.error("Project setup observation is unavailable"))
    .finally(() => {
      projectSetupReconciling = false;
    });
}, 15_000).unref();
let knowledgeReconciling = false;
setInterval(() => {
  void runtimeController
    .drainComputeWaits()
    .catch(() => console.error("Compute wait reconciliation failed"));
  void agentController
    ?.dispatchReadyPending()
    .catch(() => console.error("Retained Build admission failed"));
}, 2_000).unref();
const reconcileKnowledge = async () => {
  if (knowledgeReconciling) return;
  knowledgeReconciling = true;
  try {
    await knowledgeController.reconcile();
  } catch {
    console.error("Wiki reconciliation failed");
  } finally {
    knowledgeReconciling = false;
  }
};
void reconcileKnowledge();
setInterval(() => void reconcileKnowledge(), 15 * 60_000).unref();
void reviewMedia.sweep().catch(() => console.error("Review media retention is unavailable"));
void attachmentStore.sweep().catch(() => console.error("Attachment cleanup is unavailable"));
setInterval(() => {
  void reviewMedia.sweep().catch(() => console.error("Review media retention is unavailable"));
  void attachmentStore.sweep().catch(() => console.error("Attachment cleanup is unavailable"));
}, 60_000).unref();
void wikiSourceUpdates.repair().catch(() => console.error("Wiki hook reconciliation failed"));
setInterval(
  () =>
    void wikiSourceUpdates.repair().catch(() => console.error("Wiki hook reconciliation failed")),
  15 * 60_000,
).unref();
setInterval(
  () => void wikiSourceUpdates.drain().catch(() => console.error("Wiki event admission failed")),
  2_000,
).unref();
setInterval(
  () =>
    void projectPreparation
      .drain()
      .catch(() => console.error("Project image preparation needs retry")),
  2_000,
).unref();
let mcpRecovering = false;
setInterval(() => {
  if (mcpRecovering) return;
  mcpRecovering = true;
  void mcpConnections
    .recover()
    .catch(() => console.error("MCP credential recovery is unavailable"))
    .finally(() => {
      mcpRecovering = false;
    });
}, 30_000).unref();

import { z } from "zod";
