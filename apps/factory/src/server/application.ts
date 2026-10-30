import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoAccess } from "../../../../packages/forge/src/access";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import { createForgejoReleases } from "../../../../packages/forge/src/releases";
import { projectImportOrigins } from "../../../../packages/project-domain/src/setup";
import { createAccountRevocation } from "../access/account-revocation";
import { createAccessController } from "../access/controller";
import { createForgeAccessReconciliation } from "../access/forge";
import { createForgeIdentityRoutes } from "../access/forge-routes";
import { createIdentityConfiguration } from "../access/identity-configuration";
import { createProjectAppPreviews } from "../access/previews";
import { createAccessRevocation } from "../access/revocation";
import { createRuntimeAccess } from "../access/runtime";
import { createAccessService } from "../access/service";
import { createChangeWriterController } from "../access/writer-controller";
import { createWriterService } from "../access/writer-service";
import { createBuildBrowserController } from "../agent/browser-controller";
import { createBuildBrowserEndpoint } from "../agent/browser-endpoint";
import { createCandidateReviewController } from "../agent/candidate-review";
import { createAgentController } from "../agent/controller";
import { createOpenCodeClient } from "../agent/opencode-client";
import { createAgentService } from "../agent/service";
import { createVerificationTools } from "../agent/verification-tools";
import { createAttachmentRoutes } from "../attachments/routes";
import { createAttachmentStore } from "../attachments/store";
import { createAttachmentTools } from "../attachments/tools";
import { createBootstrapService } from "../bootstrap/service";
import { factoryBuildDirectory } from "../build-directory";
import { createChangeController } from "../change/controller";
import { createTicketDocumentController } from "../change/document";
import { createImplementationOrders } from "../change/implementation-orders";
import { createTicketService } from "../change/service";
import { createTicketTrashController } from "../change/trash";
import { CommandError } from "../command-error";
import { createDeliveryController } from "../delivery/controller";
import { createChangeIntegration } from "../delivery/integration";
import { createDeliveryService } from "../delivery/service";
import { createEnvironmentController } from "../environments/controller";
import { createOpenBaoEnvironmentSecrets } from "../environments/openbao";
import { createRuntimeEnvironmentEndpoint } from "../environments/runtime";
import { createEnvironmentService } from "../environments/service";
import { createInboxService } from "../inbox/service";
import { installationInMaintenance } from "../installation/maintenance";
import { createKnowledgeController } from "../knowledge/controller";
import { factoryForgeSource } from "../knowledge/forge-source";
import { createKnowledgeService } from "../knowledge/service";
import { createWikiSourceUpdates } from "../knowledge/source-updates";
import { createLearningService } from "../learning/service";
import { createLearningWorker } from "../learning/worker";
import { createMCPConnections } from "../mcp/connections";
import { createMCPOAuthCallback } from "../mcp/oauth-callback";
import { createMCPSecrets } from "../mcp/secrets";
import { createMCPService } from "../mcp/service";
import { createMCPSourceEndpoint } from "../mcp/sources";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { createModelRelay } from "../models/relay";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { createModelService } from "../models/service";
import { createMonitoringController } from "../monitoring/controller";
import { createMonitoringRoutes } from "../monitoring/routes";
import { createInputService } from "../monitoring/service";
import { createMonitoringWorker } from "../monitoring/worker";
import { createUIPreferenceController } from "../preferences/controller";
import { projectModelConnection } from "../project-agent/adapter";
import { createProjectAgentController } from "../project-agent/controller";
import { createConversationService } from "../project-agent/service";
import { createProjectService } from "../projects/service";
import { createReleaseController } from "../releases/controller";
import { createReleaseSecrets } from "../releases/secrets";
import { createRepositoryMirrorController } from "../repository-mirrors/controller";
import { factoryRequestURL } from "../request-origin";
import { createVisualReviewController } from "../review/controller";
import { createReviewMedia } from "../review/media";
import { createReviewMediaRoutes } from "../review/media-routes";
import { createReviewService } from "../review/service";
import { createRuntimeController } from "../runtime/controller";
import { createRuntimeDemand } from "../runtime/demand";
import { RuntimeHub } from "../runtime/hub";
import { createIdleCompute } from "../runtime/idle";
import { createProjectPreparation } from "../runtime/project-preparation";
import { createExecutionReserve } from "../runtime/reserve-controller";
import { createRuntimeService } from "../runtime/service";
import { createServerFunctionEndpoint } from "../server-functions/endpoint";
import { createProjectSetupController } from "../setup/controller";
import { createSetupInspection } from "../setup/inspection";
import { createSetupReadiness } from "../setup/readiness";
import { createImportSecrets } from "../setup/secrets";
import { createSetupService } from "../setup/service";
import { createSkillController } from "../skills/controller";
import { createSkillService } from "../skills/service";
import { createStaticAssets } from "../static-assets";
import { usageCatalogue } from "../usage/rates";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import { createUsageService } from "../usage/service";
import { createDeveloperIDEController } from "../workspace/developer-ide-controller";
import { createDeveloperIDEEdge } from "../workspace/developer-ide-edge";
import { createDeveloperIDERuntime } from "../workspace/developer-ide-runtime";
import { createWorkspaceService } from "../workspace/service";
import { createWorkspaceSourceController } from "../workspace/source-controller";
import { createWorkspaceSourceProtocol } from "../workspace/source-protocol";

export async function createFactoryApplication() {
  const { FACTORY_ADMIN_PASSWORD, FACTORY_AUTH_SECRET, FACTORY_HOST, FACTORY_ZERO_CACHE_URL } =
    process.env;
  const factoryHost = FACTORY_HOST ?? "127.0.0.1";
  const factoryOrigin = new URL(process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000").origin;
  const forgeAPIURL = process.env["FACTORY_FORGEJO_API_URL"];
  if (!forgeAPIURL) throw new Error("Configure the Factory Forgejo API before starting the server");
  const forgeOwner = process.env["FACTORY_FORGEJO_OWNER"];
  const forgeToken = process.env["FACTORY_FORGEJO_TOKEN"];
  const forgeAdminToken = process.env["FACTORY_FORGEJO_ADMIN_TOKEN"];
  if (!forgeOwner || !forgeToken)
    throw new Error("Configure the Factory Forgejo owner and token before starting the server");
  const forgeTransportOrigin = new URL(forgeAPIURL).origin;
  const forgePublicOrigin = new URL(process.env["FACTORY_FORGEJO_PUBLIC_URL"] ?? forgeAPIURL)
    .origin;
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
  const ticketDocuments = createTicketDocumentController(database, (sql, input) =>
    projectAgentController.admitTechnicalIn(sql, input),
  );
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
  const forgeAccess = forgeAdminToken
    ? createForgeAccessReconciliation({
        database,
        forge: createForgejoAccess({
          apiURL: forgeAPIURL,
          token: forgeAdminToken,
        }),
        owner: forgeOwner,
        origin: new URL(forgeAPIURL).origin,
      })
    : undefined;
  let runtimeController: ReturnType<typeof createRuntimeController>;
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
  await mcpConnections
    .recover()
    .catch(() => console.error("MCP credential recovery is unavailable"));
  const usageService = createUsageService(database);
  const learningService = createLearningService(database);
  const learningWorker = createLearningWorker(database, { signingKey: runtimeSecret });
  const runtimeHub = new RuntimeHub(async (attemptID, phase, error) => {
    await runtimeController.status(attemptID, phase, error);
    try {
      agentController?.runtimeActivityChanged();
      if (phase === "ready") {
        if (agentController) await agentController.recoverRuntimeWork(attemptID);
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
  const mcpSourceEndpoint = createMCPSourceEndpoint(
    database,
    mcpConnections,
    buildBrowserController,
  );
  const buildBrowserEndpoint = createBuildBrowserEndpoint(
    buildBrowserController,
    createCandidateReviewController(database),
    visualReview,
    createAttachmentTools(database, attachmentStore),
    createVerificationTools(database),
  );
  const runtimeAccess = createRuntimeAccess(database, (token) => runtimeHub.revokeAccess(token));
  const workspaceSources = createWorkspaceSourceController(database, runtimeSecret);
  const reserveImages = {
    staging: process.env["FACTORY_RUNTIME_HOST_IMAGE"],
    verification: process.env["FACTORY_RUNTIME_HOST_IMAGE"],
  };
  if (!reserveImages.staging || !reserveImages.verification)
    throw new Error("An exact runtime image is required before execution reserve admission");
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
    forge: createForgejoClient({
      apiURL: forgeAPIURL,
      token: forgeToken,
    }),
    publication: createForgejoReleases({
      apiURL: forgeAPIURL,
      token: forgeToken,
      ...(process.env["FACTORY_FORGEJO_ADMIN_TOKEN"]
        ? { adminToken: process.env["FACTORY_FORGEJO_ADMIN_TOKEN"] }
        : {}),
    }),
    apiURL: forgeAPIURL,
    publicURL: forgePublicOrigin,
    owner: forgeOwner,
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
      await developerIDEEdge.revokeUser(userID);
    },
    revokeAccount: revokeAccountAccess,
    forgeOrigin: forgeAccess ? forgePublicOrigin : undefined,
  });
  const observeRecoveredRuntimes = await runtimeController.recover();
  await workspaceSources.recover();
  await developerEditors.recover();
  const changeController: ReturnType<typeof createChangeController> = createChangeController(
    database,
    runtimeController,
    async (changeID) => {
      await agentController?.dispatchPending(changeID);
    },
    async (changeID) => {
      if (!forgeAccess) throw new CommandError("unavailable", "Forge protection is not configured");
      // Native branch creation itself is a protected write. Only the existing
      // Factory control identity may create it; developers remain excluded.
      await forgeAccess.protectChange(changeID, [forgeOwner]);
    },
  );
  await changeController.recover();
  await buildBrowserController.recover();
  const changeWriters = createChangeWriterController({
    database,
    runtime: runtimeController,
    stopAgent: (changeID) => agentController.stop(changeID),
    agentUsername: forgeOwner,
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
  const implementationOrders = createImplementationOrders(
    database,
    changeController,
    agentController,
  );
  deliveryController = createDeliveryController(
    database,
    runtimeController,
    agentController,
    async (changeID) => {
      if (!forgeAccess)
        throw new CommandError("unavailable", "Forge branch retirement is not configured");
      await forgeAccess.protectChange(changeID, []);
    },
    undefined,
    createChangeIntegration(database, runtimeHub, agentController, runtimeController),
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

  const demandRuntime = createRuntimeDemand(runtimeController, runtimeHub);

  async function requireSession(request: Request) {
    return factoryAuth.session(request);
  }

  const preparationForge = createForgejoClient({
    apiURL: forgeAPIURL,
    token: forgeToken,
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
      const repository = factoryForgeSource(project.url, forgeAPIURL, forgeOwner);
      return (await preparationForge.getDefaultBranch(repository)).headSha;
    },
  });
  const wikiSourceUpdates = createWikiSourceUpdates({
    database,
    forge: createForgejoClient({
      apiURL: forgeAPIURL,
      token: forgeToken,
    }),
    apiURL: forgeAPIURL,
    owner: forgeOwner,
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
    forgeOwner: forgeOwner,
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
      const repository = { owner: forgeOwner, name: project.slug };
      const head = await preparationForge.getDefaultBranch(repository);
      const inventory = await preparationForge.listFiles(repository, head.headSha);
      const configurations = inventory
        .filter(
          (file) => /^\.devcontainer\/.*(?:\.json|\.ya?ml)$/.test(file.path) && file.size <= 64000,
        )
        .slice(0, 32);
      const { requiredEnvironmentVariables } = await import("../setup/configuration");
      return requiredEnvironmentVariables(
        await Promise.all(
          configurations.map((file) =>
            preparationForge.getFile(repository, file.path, head.headSha),
          ),
        ),
      );
    },
    protection: async (projectID) => {
      const [project] = await database.client<
        { slug: string; branch: string }[]
      >`SELECT slug,default_branch AS branch FROM factory.project WHERE id=${projectID}`;
      if (!project) throw new Error("Project not found");
      await preparationForge.ensureDefaultBranchProtection(
        { owner: forgeOwner, name: project.slug },
        project.branch,
      );
      await preparationForge.protectSetupWorkflow(
        { owner: forgeOwner, name: project.slug },
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
    forgeOwner: forgeOwner,
    forgeOrigin: new URL(forgeAPIURL).origin,
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
    forgeURL: forgeAPIURL,
    forgeOwner: forgeOwner,
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
    process.env["FACTORY_ZERO_CACHE_PUBLIC_URL"] ??
    FACTORY_ZERO_CACHE_URL ??
    "http://127.0.0.1:4948";
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
  const serverFunctions: typeof import("../start-server") = await import(serverFunctionEntry);
  const serverFunctionEndpoint = createServerFunctionEndpoint({
    origin: factoryOrigin,
    session: requireSession,
    services: {
      repositoryMirrors: createRepositoryMirrorController({
        database,
        forge: createForgejoClient({ apiURL: forgeAPIURL, token: forgeToken }),
        apiURL: forgeAPIURL,
        publicURL: forgePublicOrigin,
        owner: forgeOwner,
        signingKey: runtimeSecret,
        allowedOrigins: projectImportOrigins(process.env["FACTORY_GIT_IMPORT_ORIGINS"]),
      }),
      learning: learningService,
      inbox: createInboxService(database),
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
        planning: projectAgentController,
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
    handle: async (request, options) => serverFunctions.default.fetch(request, options),
    publicFunctionIDs: serverFunctions.publicFunctionIDs,
    functionIDs: serverFunctions.functionIDs,
  });
  const staticAssets = createStaticAssets(resolve(buildDirectory, "client"), async (request) => {
    const response = await serverFunctions.default.fetch(request, { context: {} });
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  });
  return {
    accessController,
    agentController,
    attachmentRoutes,
    attachmentStore,
    buildBrowserEndpoint,
    database,
    demandRuntime,
    developerIDEEdge,
    deliveryController,
    environmentController,
    environmentSecrets,
    executionReserve,
    factoryAuth,
    factoryHost,
    factoryOrigin,
    forgeIdentityRoutes,
    idleCompute,
    implementationOrders,
    knowledgeController,
    learningWorker,
    mcpConnections,
    mcpOAuthCallback,
    mcpSourceEndpoint,
    monitoringRoutes,
    monitoringWorker,
    observeRecoveredRuntimes,
    planningCacheURL,
    projectPreparation,
    projectAgentController,
    projectSetup,
    relayModel,
    releaseController,
    requireSession,
    reviewMedia,
    reviewMediaRoutes,
    runtimeAccess,
    runtimeController,
    runtimeEnvironmentEndpoint,
    runtimeHub,
    runtimeReady,
    sameRuntimeOrigin,
    serverFunctionEndpoint,
    sourceProtocol,
    startupID,
    staticAssets,
    startFetch: serverFunctions.default.fetch,
    wikiSourceUpdates,
    workspaceSources,
    accessRevocation,
  };
}
export type FactoryApplication = Awaited<ReturnType<typeof createFactoryApplication>>;
