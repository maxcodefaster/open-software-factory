import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { implementationInput } from "../../../packages/change-domain/src/implementation";
import {
  changeAgentPromptInput,
  changeAgentResumeInput,
  changeAgentStartInput,
  changeAgentStopConfirmationInput,
} from "../../../packages/conversation-domain/src/agent-turn";
import {
  candidateReviewRetryInput,
  verificationResumeInput,
} from "../../../packages/conversation-domain/src/candidate-review";
import {
  conversationMessageInput,
  conversationModeCommandInput,
  interviewAnswerCommandInput,
} from "../../../packages/conversation-domain/src/conversation";
import { confirmEpicProposalInput } from "../../../packages/conversation-domain/src/epic-proposal";
import { modelDefaultsInput } from "../../../packages/conversation-domain/src/model-settings";
import { createDatabase } from "../../../packages/db/src/client";
import { createForgejoAccess } from "../../../packages/forge/src/access";
import { createForgejoClient } from "../../../packages/forge/src/forge";
import { identityConfigurationWrite } from "../../../packages/identity-domain/src/configuration";
import { isDesktopBackgroundKey } from "../../../packages/interface-domain/src/background";
import { knowledgeEditInput } from "../../../packages/knowledge-domain/src/knowledge";
import {
  projectImportOrigins,
  setupInspectionCommand,
  setupTask,
} from "../../../packages/project-domain/src/setup";
import {
  ticketDocumentInput,
  ticketFollowUpInput,
} from "../../../packages/requirement-domain/src/document";
import { requirementContentInput } from "../../../packages/requirement-domain/src/requirement";
import { hashConnectorToken } from "../../../packages/runtime-domain/src/identity";
import { SystemContractError } from "../../../packages/system-contract/src/system-contract";
import { createAccountRevocation } from "./access/account-revocation";
import { runtimeWriteAuthorityIn, workspaceWriteAuthorityIn } from "./access/change-writer";
import { createAccessController } from "./access/controller";
import { createForgeAccessReconciliation } from "./access/forge";
import { createForgeIdentityRoutes } from "./access/forge-routes";
import { createIdentityConfiguration } from "./access/identity-configuration";
import { createProjectAppPreviews } from "./access/previews";
import { createAccessRevocation } from "./access/revocation";
import { createAccessRoutes } from "./access/routes";
import { createRuntimeAccess } from "./access/runtime";
import { createChangeWriterController } from "./access/writer-controller";
import { agentActivityResponse } from "./agent/activity-response";
import { createBuildBrowserController } from "./agent/browser-controller";
import { createBuildBrowserEndpoint } from "./agent/browser-endpoint";
import { createCandidateReviewController } from "./agent/candidate-review";
import { createAgentController } from "./agent/controller";
import { createOpenCodeClient } from "./agent/opencode-client";
import { createChangeController } from "./change/controller";
import { createTicketDocumentController } from "./change/document";
import { createTicketTrashController } from "./change/trash";
import { CommandError } from "./command-error";
import { createDeliveryController } from "./delivery/controller";
import { createEnvironmentController } from "./environments/controller";
import { createOpenBaoEnvironmentSecrets } from "./environments/openbao";
import { createEnvironmentRoutes } from "./environments/routes";
import { createRuntimeEnvironmentEndpoint } from "./environments/runtime";
import { json, sameFactoryOrigin } from "./http";
import { installationInMaintenance } from "./installation/maintenance";
import { appRuntimeOrigin } from "./runtime-origins";
import { serveFactory } from "./http-listener";
import { createKnowledgeController } from "./knowledge/controller";
import { factoryForgeSource } from "./knowledge/forge-source";
import { createWikiSourceUpdates } from "./knowledge/source-updates";
import { createModelConnectionRoutes } from "./models/connection-routes";
import { createModelConnections } from "./models/connections";
import { createModelSettingsController } from "./models/controller";
import { createModelRelay } from "./models/relay";
import { createProjectModelRoutes } from "./models/routes";
import { createOpenBaoModelSecrets } from "./models/secrets";
import { createUIPreferenceController } from "./preferences/controller";
import { projectModelConnection } from "./project-agent/adapter";
import { createProjectAgentController } from "./project-agent/controller";
import { projectResponseStream } from "./project-agent/stream-response";
import { createProjectRoute } from "./routes/projects";
import { appTimeoutResponse } from "./runtime/app-timeout";
import { createRuntimeWriterBoundary } from "./runtime/browser-writer";
import { createRuntimeController } from "./runtime/controller";
import { scopeRuntimeEmbedding } from "./runtime/embedding";
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
import { createProjectSetupController } from "./setup/controller";
import { createSetupInspection } from "./setup/inspection";
import { createSetupReadiness } from "./setup/readiness";
import { createProjectSetupRoutes } from "./setup/routes";
import { createImportSecrets } from "./setup/secrets";
import { createSkillController } from "./skills/controller";
import { createSkillRoutes } from "./skills/routes";
import { usageCatalogue } from "./usage/rates";
import { createRecordedOpenCodeUsage } from "./usage/record-opencode";
import { createUsageRoutes } from "./usage/routes";
import { createDeveloperIDEController } from "./workspace/developer-ide-controller";
import {
  createDeveloperIDEEdge,
  type DeveloperEditorSocketData,
} from "./workspace/developer-ide-edge";
import { createDeveloperIDERoutes } from "./workspace/developer-ide-routes";
import { createDeveloperIDERuntime } from "./workspace/developer-ide-runtime";
import { createWorkspaceSourceController } from "./workspace/source-controller";
import { createWorkspaceSourceRoutes } from "./workspace/source-routes";
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
const projectModelRoutes = createProjectModelRoutes(modelSettingsController);
const modelConnections = createModelConnections(
  database,
  createOpenBaoModelSecrets(),
  runtimeSecret,
  process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [],
);
const modelConnectionRoutes = createModelConnectionRoutes(
  modelConnections,
  accessController.requireSystemManager,
  runtimeSecret,
);
await modelConnections
  .recover()
  .catch(() => console.error("Model connection save recovery is unavailable"));
const environmentSecrets = createOpenBaoEnvironmentSecrets();
const environmentController = createEnvironmentController(
  database,
  environmentSecrets,
  runtimeSecret,
);
const environmentRoutes = createEnvironmentRoutes(environmentController);
const runtimeEnvironmentEndpoint = createRuntimeEnvironmentEndpoint(database, environmentSecrets);
await environmentController
  .recover()
  .catch(() => console.error("Environment save recovery is unavailable"));
const skillRoutes = createSkillRoutes(createSkillController(database));
const usageRoutes = createUsageRoutes(database, factoryAuth);
const runtimeHub = new RuntimeHub(async (attemptID, phase, error) => {
  await runtimeController.status(attemptID, phase, error);
  agentController?.runtimeActivityChanged();
  if (phase === "ready" && agentController) await agentController.recoverRuntimeCommits(attemptID);
  if (phase === "ready" && agentController) await agentController.dispatchRuntimePending(attemptID);
  if (phase === "ready" && buildBrowserController) await buildBrowserController.recover(attemptID);
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
buildBrowserController = createBuildBrowserController(database, runtimeHub, runtimeSecret);
const buildBrowserEndpoint = createBuildBrowserEndpoint(
  buildBrowserController,
  createCandidateReviewController(database),
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
const sourceRoutes = createWorkspaceSourceRoutes(workspaceSources);
const projectAppPreviews = createProjectAppPreviews(database, (id) => runtimeHub.appChannels(id));
const idleCompute = createIdleCompute(database, runtimeHub, runtimeController);
const developerEditors = createDeveloperIDEController(database);
const developerIDERoutes = createDeveloperIDERoutes(developerEditors, (userID) =>
  developerIDEEdge.revokeUser(userID),
);
const developerIDEEdge = createDeveloperIDEEdge(
  database,
  developerEditors,
  workspaceSources,
  factoryOrigin,
  createDeveloperIDERuntime(database, runtimeController, runtimeHub, runtimeAccess, {
    view: (changeID, userID) => changeWriters.view(changeID, userID),
    takeOver: (changeID, userID, commandID) => changeWriters.takeOver(changeID, userID, commandID),
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
const accessRoutes = createAccessRoutes(
  database,
  factoryAuth,
  async (projectID, userID) => {
    await runtimeAccess.revokeMember(projectID, userID);
    await workspaceSources.revokeMember(projectID, userID);
    await developerEditors.revokeMember(projectID, userID);
    developerIDEEdge.revokeUser(userID);
  },
  revokeAccountAccess,
  forgeAccess ? forgePublicOrigin : undefined,
);
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
);
await projectAgentController.recover();
await accessRevocation.start();

function sameRuntimeOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && new URL(origin).origin === new URL(request.url).origin;
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
const projects = createProjectRoute({
  database,
  localRepositoryOrigin: new URL(process.env["FACTORY_FORGEJO_API_URL"] ?? "").origin,
  session: requireSession,
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
const projectSetupRoutes = createProjectSetupRoutes(projectSetup);
await setupInspection
  .recover()
  .catch(() => console.error("Project inspection recovery is unavailable"));
await projectSetup.recover().catch(() => console.error("Project setup recovery is unavailable"));
await setupReadiness
  .recover()
  .catch(() => console.error("Project preparation recovery is unavailable"));

async function route(request: Request) {
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
  const url = new URL(request.url);
  try {
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
    if (url.pathname === "/api/session") {
      const session = await factoryAuth.session(request);
      return json(
        {
          session,
          identity: factoryAuth.policy,
          uiPreference: session
            ? await uiPreferenceController.get(session.user.id)
            : { desktopBackgroundKey: "river-landscape" },
          zeroCacheURL:
            process.env["FACTORY_ZERO_CACHE_PUBLIC_URL"] ??
            FACTORY_ZERO_CACHE_URL ??
            "http://127.0.0.1:4948",
          forgeOrigins: {
            browser: forgePublicOrigin,
            transport: forgeTransportOrigin,
          },
          modelRelayConfigured: Boolean(
            (process.env["FACTORY_MODEL_BASE_URL"] && process.env["FACTORY_MODEL_API_KEY"]) ||
              (await database.client.begin((sql) => modelConnections.reference("build", sql))),
          ),
        },
        200,
        {
          "x-open-factory": "ready",
          "x-open-factory-startup": startupID,
        },
      );
    }
    if (url.pathname.startsWith("/api/")) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      await accessController.authorizeAPI(request, session.user.id);
      if (url.pathname === "/api/security/configuration") {
        await accessController.requireSystemManager(session.user.id);
        if (request.method === "GET") return json(await factoryAuth.view(session.user.id));
        try {
          await factoryAuth.requireFresh(request);
        } catch {
          throw new CommandError("forbidden", "Sign in again before changing security settings");
        }
        if (request.method === "PUT")
          return json(
            await factoryAuth.save(
              session.user.id,
              identityConfigurationWrite.parse(await request.json()),
            ),
          );
        return new Response(null, { status: 405 });
      }
      const identityActivation = url.pathname.match(
        /^\/api\/security\/configuration\/([0-9a-f-]{36})\/activate$/,
      );
      if (identityActivation?.[1] && request.method === "POST") {
        await accessController.requireSystemManager(session.user.id);
        try {
          await factoryAuth.requireFresh(request);
        } catch {
          throw new CommandError("forbidden", "Sign in again before changing security settings");
        }
        return json(await factoryAuth.activate(session.user.id, identityActivation[1]));
      }
      const forgeIdentityResponse = await forgeIdentityRoutes(request, session.user.id);
      if (forgeIdentityResponse) return forgeIdentityResponse;
      const response = await accessRoutes(request, session.user.id);
      if (response) return response;
      const usageResponse = await usageRoutes(request, session.user.id);
      if (usageResponse) return usageResponse;
      const modelResponse = await projectModelRoutes(request, session.user.id);
      if (modelResponse) return modelResponse;
      const environmentResponse = await environmentRoutes(request, session.user.id);
      if (environmentResponse) {
        if (request.method === "PUT" && environmentResponse.ok) {
          const projectID = url.pathname.split("/")[3];
          if (projectID)
            void projectPreparation
              .ensure(projectID)
              .catch(() => console.error("Project image preparation admission needs retry"));
        }
        return environmentResponse;
      }
      const skillResponse = await skillRoutes(request, session.user.id);
      if (skillResponse) return skillResponse;
      const sourceResponse = await sourceRoutes(request, session.user.id);
      if (sourceResponse) return sourceResponse;
      const editorResponse = await developerIDERoutes(request, session.user.id);
      if (editorResponse) return editorResponse;
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
    if (url.pathname === "/api/ui-preference") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      if (request.method === "GET") return json(await uiPreferenceController.get(session.user.id));
      if (request.method === "PUT") {
        const body = (await request.json().catch(() => null)) as {
          desktopBackgroundKey?: unknown;
        } | null;
        if (!isDesktopBackgroundKey(body?.desktopBackgroundKey)) {
          return json({ error: "Desktop Background is invalid" }, 400);
        }
        return json(await uiPreferenceController.set(session.user.id, body.desktopBackgroundKey));
      }
      return new Response(null, { status: 405 });
    }
    if (url.pathname === "/api/projects") return projects(request);
    if (url.pathname.startsWith("/api/project-setup")) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      return projectSetupRoutes(request, session.user.id);
    }
    const inspection = url.pathname.match(
      /^\/api\/projects\/([a-f0-9-]{36})\/setup\/inspection(?:\/(confirm|stop))?$/,
    );
    if (inspection?.[1]) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = inspection[1];
      if (request.method === "GET" && !inspection[2])
        return json(await setupInspection.view(projectID, session.user.id));
      if (request.method === "POST") {
        const body = setupInspectionCommand.parse(await request.json());
        return json(
          inspection[2] === "stop"
            ? await setupInspection.stop(projectID, session.user.id, body.id)
            : inspection[2] === "confirm"
              ? await setupInspection.confirm(projectID, session.user.id, body.id)
              : await setupInspection.start(projectID, session.user.id, body.id, {
                  ...(body.parentID ? { parentID: body.parentID } : {}),
                  answers: body.answers,
                }),
        );
      }
      return new Response(null, { status: 405 });
    }
    const setupProgress = url.pathname.match(
      /^\/api\/projects\/([a-f0-9-]{36})\/setup(?:\/(retry))?$/,
    );
    if (setupProgress?.[1]) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const id = setupProgress[1];
      if (request.method === "GET") return json(await setupReadiness.status(id, session.user.id));
      if (request.method === "POST" && setupProgress[2]) {
        const body = z
          .object({ task: setupTask })
          .strict()
          .parse(await request.json());
        const [intent] =
          await database.client`SELECT kind FROM factory.project_repository_intent WHERE project_id=${id}`;
        await setupReadiness.retry(id, session.user.id, body.task, intent?.["kind"] === "starter");
        return json(await setupReadiness.status(id, session.user.id));
      }
      return new Response(null, { status: 405 });
    }
    if (url.pathname.startsWith("/api/model-connections")) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      return (
        (await modelConnectionRoutes(request, session.user.id)) ??
        new Response(null, { status: 404 })
      );
    }
    if (url.pathname === "/api/model-settings" || url.pathname === "/api/model-settings/check") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      if (url.pathname.endsWith("/check")) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        return json(await modelSettingsController.checkConnection());
      }
      if (request.method === "GET") return json(await modelSettingsController.get());
      if (request.method === "PUT") {
        const input = modelDefaultsInput.safeParse(await request.json().catch(() => null));
        if (!input.success) return json({ error: "Model settings are invalid" }, 400);
        return json(await modelSettingsController.set(input.data, session.user.id));
      }
      return new Response(null, { status: 405 });
    }
    const projectConversation = url.pathname.match(
      /^\/api\/projects\/([0-9a-f-]+)\/conversation(?:\/(message|mode|answer))?$/,
    );
    if (projectConversation) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = projectConversation[1];
      const action = projectConversation[2];
      if (!projectID) return json({ error: "Project is required" }, 400);
      if (!action && request.method === "GET") {
        const ticketID = url.searchParams.get("ticketId") ?? undefined;
        if (ticketID && !/^[0-9a-f-]{36}$/.test(ticketID)) {
          return json({ error: "Ticket is invalid" }, 400);
        }
        return json(await projectAgentController.get(projectID, ticketID, session.user.id));
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (action === "message") {
        const parsed = conversationMessageInput.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
        if (request.headers.get("accept")?.includes("text/event-stream"))
          return projectResponseStream((observer) =>
            projectAgentController.message(
              projectID,
              parsed.data.ticketId,
              parsed.data.text,
              session.user.id,
              parsed.data.commandId,
              parsed.data.intent,
              observer,
            ),
          );
        return json(
          await projectAgentController.message(
            projectID,
            parsed.data.ticketId,
            parsed.data.text,
            session.user.id,
            parsed.data.commandId,
            parsed.data.intent,
          ),
          201,
        );
      }
      if (action === "mode") {
        const parsed = conversationModeCommandInput.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
        return json(
          await projectAgentController.setMode(
            projectID,
            parsed.data.ticketId,
            parsed.data.mode,
            session.user.id,
          ),
        );
      }
      if (action === "answer") {
        const parsed = interviewAnswerCommandInput.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
        return json(
          await projectAgentController.answer(
            projectID,
            parsed.data.ticketId,
            parsed.data.questionEntryId,
            parsed.data.answer,
            session.user.id,
            parsed.data.commandId,
          ),
          201,
        );
      }
      return new Response(null, { status: 404 });
    }
    const knowledgeGeneration = url.pathname.match(
      /^\/api\/projects\/([0-9a-f-]+)\/knowledge\/generation$/,
    );
    if (knowledgeGeneration) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = knowledgeGeneration[1];
      if (!projectID) return json({ error: "Project is required" }, 400);
      if (request.method === "GET") return json(await knowledgeController.generation(projectID));
      if (request.method === "POST") {
        const generation = await knowledgeController.generate(projectID, session.user.id);
        if (generation)
          await setupReadiness.observeWikiRetry(
            projectID,
            session.user.id,
            z.uuid().parse(generation["id"]),
          );
        return json(generation, 202);
      }
      return new Response(null, { status: 405 });
    }
    const knowledgeSearch = url.pathname.match(
      /^\/api\/projects\/([0-9a-f-]+)\/knowledge\/search$/,
    );
    if (knowledgeSearch && request.method === "GET") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = knowledgeSearch[1];
      if (!projectID) return json({ error: "Project is required" }, 400);
      return json({
        results: await knowledgeController.search(
          projectID,
          url.searchParams.get("q") ?? "",
          session.user.id,
        ),
      });
    }
    const repositoryDocuments = url.pathname.match(
      /^\/api\/projects\/([0-9a-f-]+)\/knowledge\/documents$/,
    );
    if (repositoryDocuments) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = repositoryDocuments[1];
      if (!projectID) return json({ error: "Project is required" }, 400);
      if (request.method === "GET") {
        await accessController.requireDevelopment(session.user.id, projectID);
        const path = url.searchParams.get("path");
        if (path) return json(await knowledgeController.document(projectID, path));
        return json(await knowledgeController.documents(projectID));
      }
      return new Response(null, { status: 405 });
    }
    const knowledgePageRoute = url.pathname.match(
      /^\/api\/knowledge\/pages\/([0-9a-f-]+)(?:\/(revisions|archive|restore|sources))?$/,
    );
    if (knowledgePageRoute) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const pageID = knowledgePageRoute[1];
      const action = knowledgePageRoute[2];
      if (!pageID) return json({ error: "Knowledge Page is required" }, 400);
      if (action === "revisions" && request.method === "GET") {
        return json({ revisions: await knowledgeController.history(pageID, session.user.id) });
      }
      if (action === "sources" && request.method === "GET")
        return json(await knowledgeController.sources(pageID, session.user.id));
      if (action === "restore" && request.method === "POST") {
        const parsed = z
          .object({ revisionID: z.uuid(), expectedVersion: z.number().int().positive() })
          .safeParse(await request.json().catch(() => null));
        if (!parsed.success)
          return json({ error: "Revision and current page version are required" }, 400);
        return json(
          await knowledgeController.restore(
            pageID,
            parsed.data.revisionID,
            parsed.data.expectedVersion,
            session.user.id,
          ),
        );
      }
      if (action === "archive" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          expectedVersion?: unknown;
        } | null;
        if (!body || typeof body.expectedVersion !== "number") {
          return json({ error: "Knowledge Page version is required" }, 400);
        }
        return json(
          await knowledgeController.archive(pageID, body.expectedVersion, session.user.id),
        );
      }
      if (!action && request.method === "PUT") {
        const parsed = knowledgeEditInput.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
        return json(await knowledgeController.edit(pageID, parsed.data, session.user.id));
      }
      return new Response(null, { status: 405 });
    }
    const agentRoute = url.pathname.match(
      /^\/api\/changes\/([0-9a-f-]+)\/agent(?:\/(activity|start|resume|prompt|request-changes|stop|check-stop))?$/,
    );
    const writerRoute = url.pathname.match(/^\/api\/changes\/([0-9a-f-]{36})\/writer$/);
    if (writerRoute?.[1]) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      if (request.method === "GET")
        return json(await changeWriters.view(writerRoute[1], session.user.id));
      if (request.method === "POST") {
        const { commandID } = z
          .object({ commandID: z.uuid() })
          .strict()
          .parse(await request.json());
        return json(await changeWriters.takeOver(writerRoute[1], session.user.id, commandID));
      }
      return new Response(null, { status: 405 });
    }
    if (agentRoute) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const [, changeID, action] = agentRoute;
      if (!changeID) return json({ error: "Change is required" }, 400);
      if (action === "activity" && request.method === "GET")
        return agentActivityResponse({
          signal: request.signal,
          authorize: async () => {
            const current = await requireSession(request);
            if (!current || current.user.id !== session.user.id)
              throw new CommandError("forbidden", "Build activity access ended");
            await accessController.authorizeAPI(request, current.user.id);
          },
          read: () => agentController.get(changeID),
          subscribe: async (notify) => agentController.subscribeActivity(changeID, notify),
        });
      if (!action && request.method === "GET")
        return json(
          await agentController.get(changeID, undefined, url.searchParams.get("history") !== "0"),
        );
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (action === "start") {
        const parsed = changeAgentStartInput.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
        return json(
          await agentController.start(
            changeID,
            session.user.id,
            parsed.data.commandId,
            parsed.data.codingReasoning,
          ),
          202,
        );
      }
      if (action === "stop") return json(await agentController.stop(changeID), 202);
      if (action === "resume") {
        const parsed = changeAgentResumeInput.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "Resume request is invalid" }, 400);
        return json(
          await agentController.resume(
            changeID,
            session.user.id,
            parsed.data.commandId,
            parsed.data.pausedTurnId,
          ),
          202,
        );
      }
      if (action === "check-stop") {
        const parsed = changeAgentStopConfirmationInput.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
        return json(await agentController.recheckStop(changeID, parsed.data.stopId));
      }
      if (action === "prompt" || action === "request-changes") {
        const parsed = changeAgentPromptInput.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
        return json(
          await agentController.prompt(
            changeID,
            parsed.data.text,
            session.user.id,
            parsed.data.commandId,
          ),
          202,
        );
      }
      return new Response(null, { status: 404 });
    }
    const ticketDetail = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)$/);
    if (ticketDetail && request.method === "GET") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = ticketDetail[1];
      if (!ticketID) return json({ error: "Ticket is required" }, 400);
      const tickets = await database.client<Array<Record<string, unknown>>>`
        SELECT id, project_id AS "projectId", epic_id AS "epicId", converted_to_epic_id AS "convertedToEpicId", title, description, state, version::integer AS version,
          created_at AS "createdAt", updated_at AS "updatedAt", trashed_at AS "trashedAt",
          trash_stop_pending AS "trashStopPending", trash_error AS "trashError"
        FROM factory.ticket WHERE id = ${ticketID}
      `;
      const revisions = await database.client<Array<Record<string, unknown>>>`
        SELECT revision.id, revision.ticket_id AS "ticketId", revision.ordinal,
          revision.canonical_content AS "canonicalContent",
          revision.content_digest AS "contentDigest", revision.created_at AS "createdAt",
          approval.id AS "approvalId", approval.approved_at AS "approvedAt", author.name AS author
        FROM factory.requirement_revision revision
        LEFT JOIN auth."user" author ON author.id = revision.created_by
        LEFT JOIN factory.requirement_approval approval
          ON approval.requirement_revision_id = revision.id
        WHERE revision.ticket_id = ${ticketID} ORDER BY revision.ordinal DESC
      `;
      const documentRevisions = await database.client<Array<Record<string, unknown>>>`
        SELECT revision.id, revision.ordinal, revision.title, revision.description,
          revision.canonical_content AS "canonicalContent", revision.content_digest AS "contentDigest",
          revision.requirement_revision_id AS "requirementRevisionId", revision.created_at AS "createdAt", author.name AS author,
          revision.author_kind AS "authorKind", revision.proposal_entry_id AS "proposalEntryId",
          approval.id AS "approvalId"
        FROM factory.ticket_document_revision revision LEFT JOIN auth."user" author ON author.id = revision.created_by
        LEFT JOIN factory.requirement_approval approval ON approval.requirement_revision_id = revision.requirement_revision_id
          AND EXISTS(SELECT 1 FROM factory.requirement_revision scope WHERE scope.id=revision.requirement_revision_id AND scope.canonical_content=revision.canonical_content)
        WHERE revision.ticket_id = ${ticketID} ORDER BY revision.ordinal DESC`;
      const [origin] = await database.client<Array<{ id: string; title: string }>>`
        SELECT ticket.id, ticket.title FROM factory.ticket_follow_up follow JOIN factory.ticket ticket ON ticket.id = follow.source_ticket_id WHERE follow.ticket_id = ${ticketID}`;
      const followUps = await database.client<Array<{ id: string; title: string }>>`
        SELECT ticket.id, ticket.title FROM factory.ticket_follow_up follow JOIN factory.ticket ticket ON ticket.id = follow.ticket_id WHERE follow.source_ticket_id = ${ticketID}`;
      const [proposal] = await database.client<
        Array<{ id: string; payload: Record<string, unknown> }>
      >`
        SELECT entry.id,entry.payload FROM factory.conversation_entry entry
        JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id
        WHERE conversation.ticket_id=${ticketID} AND entry.kind='requirement'
          AND NOT EXISTS(SELECT 1 FROM factory.ticket_document_revision document WHERE document.proposal_entry_id=entry.id)
          AND NOT EXISTS(SELECT 1 FROM factory.conversation_entry newer WHERE newer.conversation_id=entry.conversation_id
            AND newer.kind='requirement' AND newer.ordinal>entry.ordinal)
        ORDER BY entry.ordinal DESC LIMIT 1`;
      const projectID = tickets[0]?.["projectId"];
      const visibleProposal =
        proposal?.payload["visibility"] !== "developer" ||
        (typeof projectID === "string" &&
          (await accessController.canDevelop(session.user.id, projectID)));
      return json({
        ticket: tickets[0] ?? null,
        revisions,
        documentRevisions,
        proposal:
          visibleProposal && proposal?.payload["base"] && proposal.payload["requirement"]
            ? { ...proposal.payload, id: proposal.id }
            : null,
        origin: origin ?? null,
        followUps,
      });
    }
    const epicConfirmation = url.pathname.match(
      /^\/api\/projects\/([0-9a-f-]+)\/epic-proposals\/([0-9a-f-]+)\/confirm$/,
    );
    if (epicConfirmation && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const parsed = confirmEpicProposalInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
      return json(
        await projectAgentController.confirmEpic(
          epicConfirmation[1]!,
          epicConfirmation[2]!,
          session.user.id,
          parsed.data,
        ),
        201,
      );
    }
    const documentSave = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)\/document$/);
    if (documentSave && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = documentSave[1];
      if (!ticketID) return json({ error: "Ticket is required" }, 400);
      const parsed = ticketDocumentInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
      return json(await ticketDocuments.save(ticketID, session.user.id, parsed.data), 201);
    }
    const ticketFollowUp = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)\/follow-up$/);
    if (ticketFollowUp && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = ticketFollowUp[1];
      if (!ticketID) return json({ error: "Ticket is required" }, 400);
      const parsed = ticketFollowUpInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
      return json(await ticketDocuments.followUp(ticketID, session.user.id, parsed.data), 201);
    }
    const trashCommand = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)\/(trash|restore)$/);
    if (trashCommand && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = trashCommand[1];
      if (!ticketID) return json({ error: "Ticket is required" }, 400);
      if (trashCommand[2] === "restore") {
        const parsed = z
          .object({ expectedVersion: z.number().int().positive() })
          .strict()
          .safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "Ticket version is required" }, 400);
        await ticketTrash.restore(ticketID, session.user.id, parsed.data.expectedVersion);
      } else await ticketTrash.trash(ticketID, session.user.id);
      return json({}, 202);
    }
    const revisionCreate = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)\/requirements$/);
    if (revisionCreate && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = revisionCreate[1];
      if (!ticketID) return json({ error: "Ticket is required" }, 400);
      const parsed = requirementContentInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, 400);
      return json(
        await changeController.createRevision(ticketID, parsed.data, session.user.id),
        201,
      );
    }
    const approvalCreate = url.pathname.match(
      /^\/api\/tickets\/([0-9a-f-]+)\/requirements\/([0-9a-f-]+)\/approve$/,
    );
    if (approvalCreate && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = approvalCreate[1];
      const revisionID = approvalCreate[2];
      if (!ticketID || !revisionID) return json({ error: "Requirement is required" }, 400);
      return json(await changeController.approve(ticketID, revisionID, session.user.id), 201);
    }
    const changeStart = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)\/change$/);
    if (changeStart && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = changeStart[1];
      if (!ticketID) return json({ error: "Ticket is required" }, 400);
      return json(await changeController.start(ticketID, session.user.id), 202);
    }
    const implementationStart = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)\/implement$/);
    if (implementationStart && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const ticketID = implementationStart[1];
      if (!ticketID) return json({ error: "Ticket is required" }, 400);
      const parsed = implementationInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "Implementation request is invalid" }, 400);
      if (parsed.data.codingReasoning) {
        const [ticket] = await database.client<Array<{ projectID: string }>>`
          SELECT project_id AS "projectID" FROM factory.ticket WHERE id=${ticketID}`;
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await accessController.requireDevelopment(session.user.id, ticket.projectID);
      }
      return json(
        await changeController.start(ticketID, session.user.id, {
          commandID: parsed.data.commandId,
          revisionID: parsed.data.revisionId,
          ...(parsed.data.codingReasoning ? { codingReasoning: parsed.data.codingReasoning } : {}),
          admitBuild: (sql, changeID) =>
            agentController.admitStartIn(
              sql,
              changeID,
              session.user.id,
              parsed.data.commandId,
              parsed.data.codingReasoning,
            ),
        }),
        202,
      );
    }
    if (url.pathname === "/api/changes" && request.method === "GET") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = url.searchParams.get("projectId");
      if (projectID && !/^[0-9a-f-]{36}$/i.test(projectID))
        return json({ error: "Invalid Project identity" }, 400);
      return json({
        changes: await changeController.list(projectID ?? undefined, session.user.id),
      });
    }
    const deliveryRoute = url.pathname.match(
      /^\/api\/changes\/([0-9a-f-]+)\/delivery(?:\/(approve|retry-review|resume-checks))?$/,
    );
    if (deliveryRoute) {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const changeID = deliveryRoute[1];
      const action = deliveryRoute[2];
      if (!changeID) return json({ error: "Change is required" }, 400);
      if (!action && request.method === "GET") return json(await deliveryController.get(changeID));
      if (action === "approve" && request.method === "POST") {
        return json(await deliveryController.approve(changeID, session.user.id), 202);
      }
      if (action === "retry-review" && request.method === "POST") {
        const input = candidateReviewRetryInput.parse(await request.json());
        return json(
          await deliveryController.retryReview(
            changeID,
            session.user.id,
            input.commandId,
            input.reviewId,
          ),
          202,
        );
      }
      if (action === "resume-checks" && request.method === "POST") {
        const input = verificationResumeInput.parse(await request.json());
        return json(
          await deliveryController.resumeChecks(
            changeID,
            session.user.id,
            input.commandId,
            input.verificationId,
            input.stopId,
          ),
          202,
        );
      }
      return new Response(null, { status: 405 });
    }
    const changeCancel = url.pathname.match(/^\/api\/changes\/([0-9a-f-]+)\/cancel$/);
    if (changeCancel && request.method === "POST") {
      if (!(await requireSession(request))) return json({ error: "Authentication required" }, 401);
      const changeID = changeCancel[1];
      if (!changeID) return json({ error: "Change is required" }, 400);
      await changeController.cancel(changeID);
      await buildBrowserController.closeChange(changeID);
      await deliveryController.cancel(changeID);
      return json(await changeController.get(changeID), 202);
    }
    const runtimeStart = url.pathname.match(
      /^\/api\/projects\/([0-9a-f-]+)\/(?:runtime|personal-workspace\/ensure)$/,
    );
    if (runtimeStart && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = runtimeStart[1];
      if (!projectID) return json({ error: "Project is required" }, 400);
      return json(await runtimeController.start(projectID, session.user.id), 202);
    }
    const stagingEnsure = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/staging\/ensure$/);
    if (stagingEnsure && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = stagingEnsure[1];
      if (!projectID) return json({ error: "Project is required" }, 400);
      return json(await runtimeController.ensureStaging(projectID, session.user.id), 202);
    }
    const ticketWorkspaceEnsure = url.pathname.match(
      /^\/api\/changes\/([0-9a-f-]+)\/ticket-workspace\/ensure$/,
    );
    if (ticketWorkspaceEnsure && request.method === "POST") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const changeID = ticketWorkspaceEnsure[1];
      if (!changeID) return json({ error: "Change is required" }, 400);
      const [workspace] = await database.client<
        { id: string }[]
      >`SELECT id FROM factory.development_workspace WHERE change_id=${changeID}`;
      if (!workspace)
        throw new CommandError(
          "conflict",
          "Prepare source and take over editing before starting compute",
        );
      await database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspace.id, session.user.id),
      );
      return json(await runtimeController.startPersisted(changeID, session.user.id), 202);
    }
    if (url.pathname === "/api/runtime-attempts" && request.method === "GET") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      const projectID = url.searchParams.get("projectId");
      if (projectID && !/^[0-9a-f-]{36}$/i.test(projectID))
        return json({ error: "Invalid Project identity" }, 400);
      return json({
        attempts: await runtimeController.list(projectID ?? undefined, session.user.id),
      });
    }
    const appPreviews = url.pathname.match(/^\/api\/projects\/([0-9a-f-]{36})\/app-previews$/);
    if (appPreviews?.[1] && request.method === "GET") {
      const session = await requireSession(request);
      if (!session) return json({ error: "Authentication required" }, 401);
      return json({ previews: await projectAppPreviews(appPreviews[1], session.user.id) });
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
    const runtimeStop = url.pathname.match(/^\/api\/runtime-attempts\/([a-z0-9-]+)\/stop$/);
    if (runtimeStop && request.method === "POST") {
      if (!(await requireSession(request))) return json({ error: "Authentication required" }, 401);
      const attemptID = runtimeStop[1];
      if (!attemptID) return json({ error: "Runtime Attempt is required" }, 400);
      try {
        return json(await runtimeController.stop(attemptID), 202);
      } finally {
        runtimeAccess.revokeAttempt(attemptID);
        runtimeHub.suspend(attemptID);
      }
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
        : scopeRuntimeEmbedding(response, factoryOrigin);
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
      return scopeRuntimeEmbedding(response, factoryOrigin);
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
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const dist = resolve(import.meta.dir, "../dist");
    const filePath = resolve(dist, path);
    if (!filePath.startsWith(`${dist}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(resolve(dist, "index.html")));
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
    const url = new URL(request.url);
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
void wikiSourceUpdates.repair();
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

import { z } from "zod";
