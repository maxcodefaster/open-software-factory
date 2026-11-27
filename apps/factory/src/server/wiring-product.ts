import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { createDatabase } from "#db/client";
import { operation, project as projectTable } from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { createChangeWriterController } from "../access/writer-controller";
import { createAgentController } from "../agent/controller";
import { createChangeController } from "../change/controller";
import { createTicketDocumentController } from "../change/document";
import { createImplementationOrders } from "../change/implementation-orders";
import { createTicketTrashController } from "../change/trash";
import { CommandError } from "../command-error";
import { createDeliveryController } from "../delivery/controller";
import { createChangeIntegration } from "../delivery/integration";
import { reportFailure } from "../failure-log";
import { createKnowledgeController } from "../knowledge/controller";
import { createWikiSourceUpdates } from "../knowledge/source-updates";
import { installationPlanningConnection } from "../models/resolver";
import { createMonitoringController } from "../monitoring/controller";
import { createMonitoringRoutes } from "../monitoring/routes";
import { createMonitoringWorker } from "../monitoring/worker";
import { createProjectAgentController } from "../project-agent/controller";
import { createProjectService } from "../projects/service";
import { createProjectSetupController } from "../setup/controller";
import { createSetupInspection } from "../setup/inspection";
import { createSetupReadiness } from "../setup/readiness";
import { createImportSecrets } from "../setup/secrets";
import type { ServerConfig } from "./config";
import type { WiringHooks } from "./wiring-hooks";
import type { PlatformSubsystem } from "./wiring-platform";
import type { RuntimeSubsystem } from "./wiring-runtime";

export type ProductWiringInput = {
  config: ServerConfig;
  database: ReturnType<typeof createDatabase>;
  runtimeSecret: string;
  platform: PlatformSubsystem;
  runtime: RuntimeSubsystem;
  hooks: WiringHooks;
};

/**
 * Wires product workflows: changes, writers, coding agent, delivery, knowledge,
 * project planning agent, monitoring, project setup/readiness and registration,
 * completing all cross-subsystem hook bindings and recovery in exact startup order.
 */
export async function wireProduct({
  config,
  database,
  runtimeSecret,
  platform,
  runtime,
  hooks,
}: ProductWiringInput) {
  const { factoryOrigin } = config;
  const {
    apiURL: forgeAPIURL,
    owner: forgeOwner,
    token: forgeToken,
    transportOrigin: forgeTransportOrigin,
    publicOrigin: forgePublicOrigin,
  } = config.forge;
  const {
    forgeAccess,
    modelSettingsController,
    modelConnections,
    environmentController,
    mcpConnections,
  } = platform;
  const {
    runtimeHub,
    runtimeController,
    buildBrowserController,
    workspaceSources,
    accessRevocation,
  } = runtime;

  const ticketDocuments = createTicketDocumentController(database, (sql, input) =>
    hooks.admitTechnical(sql, input),
  );

  const changeController = createChangeController(
    database,
    runtimeController,
    (changeID) => hooks.dispatchPendingCoding(changeID),
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
    stopAgent: (changeID) => hooks.stopAgent(changeID),
    agentUsername: forgeOwner,
    fenceSource: workspaceSources.fenceChange,
    protect: async (changeID, writers) => {
      if (!forgeAccess)
        throw new CommandError("unavailable", "Forge writing authority is not configured");
      await forgeAccess.protectChange(changeID, writers);
    },
  });
  hooks.registerWriterAccess(changeWriters);

  const agentController = createAgentController(
    database,
    runtimeHub,
    runtimeController,
    buildBrowserController,
    changeWriters,
    (target, signal) => runtimeController.settleRetainedInputStop(target, signal),
  );
  hooks.registerAgent({
    stopCoding: (changeID, handoff) => agentController.stop(changeID, handoff),
    onRuntimeActivity: () => agentController.runtimeActivityChanged(),
    onRuntimeReady: async (attemptID) => {
      await agentController.recoverRuntimeWork(attemptID);
      await agentController.dispatchRuntimePending(attemptID);
    },
    dispatchPendingCoding: (changeID) => agentController.dispatchPending(changeID),
  });
  await agentController.recover();

  const implementationOrders = createImplementationOrders(
    database,
    changeController,
    agentController,
  );
  const deliveryController = createDeliveryController(
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

  const knowledgeController = createKnowledgeController(database);
  await knowledgeController.recover();

  const projectAgentController = createProjectAgentController(
    database,
    knowledgeController,
    mcpConnections,
    (conversationID, contextID) => agentController.retainedMessages(conversationID, contextID),
  );
  hooks.registerAdmitTechnical((sql, input) => projectAgentController.admitTechnicalIn(sql, input));
  await projectAgentController.recover();

  const monitoringController = createMonitoringController(
    database,
    runtimeSecret,
    factoryOrigin,
    (projectID) => hooks.onMonitoringTrigger(projectID),
  );
  const monitoringWorker = createMonitoringWorker(database, {
    mcp: mcpConnections,
    code: knowledgeController,
    changes: changeController,
    agent: agentController,
    delivery: deliveryController,
    signingKey: runtimeSecret,
  });
  hooks.registerMonitoringTrigger((projectID) => {
    void monitoringWorker.project(projectID).catch(reportFailure("Monitoring project run"));
  });
  const monitoringRoutes = createMonitoringRoutes(monitoringController);
  await monitoringWorker.recover();
  await accessRevocation.start();

  const preparationForge = createForgejoClient({
    apiURL: forgeAPIURL,
    token: forgeToken,
  });
  const wikiSourceUpdates = createWikiSourceUpdates({
    database,
    forge: createForgejoClient({
      apiURL: forgeAPIURL,
      token: forgeToken,
    }),
    apiURL: forgeAPIURL,
    publicURL: forgePublicOrigin,
    owner: forgeOwner,
    receiverURL: config.wiki.receiverURL,
    signingKey: config.wiki.webhookSecret ?? runtimeSecret,
    reconcile: (projectID) => knowledgeController.reconcile(projectID),
  });

  const setupReadiness = createSetupReadiness({
    database,
    environments: environmentController,
    signingKey: runtimeSecret,
    requiredVariables: async (projectID) => {
      const [project] = await database.db
        .select({ slug: projectTable.slug, configuration: projectTable.actorTemplatePath })
        .from(projectTable)
        .where(eq(projectTable.id, projectID));
      if (!project) throw new Error("Project not found");
      const repository = { owner: forgeOwner, name: project.slug };
      const head = await preparationForge.getDefaultBranch(repository);
      const { readRequiredEnvironmentVariables } = await import("../setup/configuration");
      return readRequiredEnvironmentVariables(project.configuration, (path) =>
        preparationForge.getFile(repository, path, head.headSha),
      );
    },
    protection: async (projectID) => {
      const [project] = await database.db
        .select({ slug: projectTable.slug, branch: projectTable.defaultBranch })
        .from(projectTable)
        .where(eq(projectTable.id, projectID));
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
      const [hook] = await database.db
        .select({ state: operation.state })
        .from(operation)
        .where(
          and(
            eq(operation.kind, "knowledge.source_update"),
            eq(operation.scopeType, "project"),
            eq(operation.idempotencyKey, `knowledge.source_update:${projectID}`),
          ),
        );
      if (hook?.state !== "ready") throw new Error("Repository hook needs retry");
    },
    wiki: async (projectID, userID, automatic) => {
      const generation = await knowledgeController.generate(projectID, userID, automatic);
      if (!generation) throw new Error("Wiki generation was not admitted");
      return z.uuid().parse(generation["id"]);
    },
    preview: async (projectID, userID) => {
      const attempt = await runtimeController.ensureStaging(projectID, userID);
      if (!attempt) throw new Error("Main-Preview was not admitted");
      return attempt.id;
    },
  });

  const setupInspection = createSetupInspection({
    database,
    forge: preparationForge,
    forgeURL: forgeAPIURL,
    forgePublicURL: forgePublicOrigin,
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
        : installationPlanningConnection(),
    ready: async (projectID, userID) => {
      await database.db
        .insert(operation)
        .values({
          id: crypto.randomUUID(),
          kind: "projects.setup_readiness",
          scopeType: "project",
          scopeId: projectID,
          idempotencyKey: `projects.setup_readiness:${projectID}:configuration`,
          state: "ready",
          payload: { task: "configuration", commandId: crypto.randomUUID() },
          createdBy: userID,
          completedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: operation.idempotencyKey,
          set: {
            state: "ready",
            error: null,
            completedAt: sql`COALESCE(${operation.completedAt}, now())`,
            updatedAt: sql`now()`,
          },
        });
      void setupReadiness
        .start(projectID, userID, false)
        .catch(reportFailure("Confirmed Project preparation needs attention"));
    },
  });

  hooks.registerProjectRegistered(async (projectID, userID, recovering) => {
    await setupReadiness.start(projectID, userID, false, recovering);
    await setupInspection.start(projectID, userID, projectID);
  });

  const projectSetup = createProjectSetupController({
    database,
    forge: preparationForge,
    forgeOwner: forgeOwner,
    forgeOrigin: forgeTransportOrigin,
    secrets: createImportSecrets(),
    signingKey: runtimeSecret,
    importOrigins: config.gitImportOrigins,
    onCreated: async (projectID, userID) => {
      // Configuration confirmation owns runtime readiness. Creation itself keeps
      // planning available without starting arbitrary imported Project code.
      const [intent] = await database.db
        .select({ kind: sql<string>`${operation.payload}->>'kind'` })
        .from(operation)
        .where(
          and(
            eq(operation.kind, "projects.repository_intent"),
            eq(operation.scopeType, "project"),
            eq(operation.idempotencyKey, `projects.repository_intent:${projectID}`),
          ),
        );
      void setupReadiness
        .start(projectID, userID, intent?.kind === "starter")
        .catch(reportFailure("Project preparation needs attention"));
      if (intent?.kind === "import")
        void setupInspection
          .start(projectID, userID, projectID)
          .catch(reportFailure("Project configuration inspection needs attention"));
    },
  });

  const projectService = createProjectService({
    database,
    localRepositoryOrigin: forgeTransportOrigin,
    publicRepositoryOrigin: forgePublicOrigin,
    readDefaultBranch: async (repository) =>
      (await preparationForge.getDefaultBranch(repository)).name,
    onRegistered: (projectID, userID, recovering) =>
      hooks.onProjectRegistered(projectID, userID, recovering),
    forgeOwner: forgeOwner,
  });

  await setupInspection
    .recover()
    .catch(reportFailure("Project inspection recovery is unavailable"));
  await projectSetup.recover().catch(reportFailure("Project setup recovery is unavailable"));
  await setupReadiness
    .recover()
    .catch(reportFailure("Project preparation recovery is unavailable"));
  await projectService.recover().catch(reportFailure("Registered Project recovery is unavailable"));

  return {
    ticketDocuments,
    changeController,
    changeWriters,
    agentController,
    implementationOrders,
    deliveryController,
    ticketTrash,
    knowledgeController,
    projectAgentController,
    monitoringController,
    monitoringWorker,
    monitoringRoutes,
    wikiSourceUpdates,
    projectService,
    setupReadiness,
    projectSetup,
    setupInspection,
  };
}

export type ProductSubsystem = Awaited<ReturnType<typeof wireProduct>>;
