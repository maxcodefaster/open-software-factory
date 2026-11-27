import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  change,
  changeCommitOperation,
  developmentWorkspace,
  operation as operationTable,
  project as projectModel,
  substrateProvision,
  ticket as ticketModel,
} from "#db/schema";
import { runtimeAgentProcess } from "#runtime-kubernetes/agent-process";
import {
  parseSubstrateProjectTemplate,
  type SubstrateProjectTemplate,
  SubstrateProjectTemplateError,
} from "#runtime-kubernetes/substrate-project-template";
import upstream from "../../../../upstream.json";
import { CommandError } from "../command-error";
import {
  admitInitialSourceSeedIn,
  type SourceStartupConfiguration,
  type SubstrateSourceHandoff,
} from "../workspace/source-api";
import { agentConfiguration } from "./agent-configuration";
import { runtimeAppOrigins } from "./app-origins";
import { resolveRepositoryRevision } from "./git-http";
import { substrateTemplateSHA256 } from "./substrate";
import { substrateWorkspaceGrantIn, substrateWorkspaceRevisionIn } from "./substrate-grant";
import {
  readProjectEnvironmentIn,
  renderBoundSubstrateTemplate,
  type SubstrateAssignmentChannel,
  type SubstrateAssignmentProcess,
  type SubstrateDatabase,
} from "./substrate-provisioning-shared";
import type { WorkspaceProvision, WorkspaceProvisionPhase } from "./substrate-workspace-phase";

export async function prepareWorkspaceProvisionPlan(options: {
  database: SubstrateDatabase;
  sql: SubstrateDatabase["client"];
  secret: string;
  phase: Extract<WorkspaceProvisionPhase, { phase: "resume-incomplete" | "fresh-generation" }>;
  workspaceID: string;
  userID: string;
  changeID: string | undefined;
  readConfiguration:
    | ((
        repository: string,
        revision: string,
        actorTemplatePath: string,
      ) => Promise<SourceStartupConfiguration>)
    | undefined;
  sources: SubstrateSourceHandoff | undefined;
  recordStart: ((sql: DatabaseTransaction, workspaceID: string) => Promise<void>) | undefined;
}) {
  const { database, sql, phase, workspaceID, userID, changeID, sources, recordStart } = options;
  const db = drizzleTransaction(sql);
  const { config, generation, attemptID } = phase;
  const prior = phase.phase === "resume-incomplete" ? phase.prior : undefined;
  let workspace = phase.workspace;
  let startRecorded = phase.startRecorded;

  const [ticket] = changeID
    ? await db
        .select({
          id: change.ticketId,
          revision: query<string>`coalesce((${db
            .select({ sha: changeCommitOperation.commitSha })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, change.id),
                eq(changeCommitOperation.state, "succeeded"),
              ),
            )
            .orderBy(desc(changeCommitOperation.sequence))
            .limit(1)}), ${change.baseSha})`,
          branch: change.branchName,
        })
        .from(change)
        .innerJoin(ticketModel, eq(ticketModel.id, change.ticketId))
        .innerJoin(
          operationTable,
          and(
            eq(operationTable.kind, "delivery.branch_create"),
            eq(operationTable.scopeType, "change"),
            eq(operationTable.scopeId, query<string>`${change.id}::text`),
          ),
        )
        .where(
          and(
            eq(change.id, changeID),
            eq(change.projectId, config.projectID),
            inArray(change.state, ["starting", "active", "failed"]),
            isNull(change.cancelRequestedAt),
            isNull(ticketModel.trashedAt),
            eq(operationTable.state, "succeeded"),
            eq(query<string | null>`${operationTable.result}->>'observedHeadSha'`, change.baseSha),
          ),
        )
    : [];
  if (changeID && !ticket)
    throw new CommandError("conflict", "Approved Ticket branch is not ready");
  const [project] = await db
    .select({
      repository: projectModel.repositoryUrl,
      branch: projectModel.defaultBranch,
      actorTemplatePath: projectModel.actorTemplatePath,
    })
    .from(projectModel)
    .where(eq(projectModel.id, config.projectID));
  if (!project) throw new CommandError("not-found", "Project not found");
  const revision = workspace
    ? await sql.begin(async (tx) => {
        await substrateWorkspaceGrantIn(database, tx, workspaceID, userID, true);
        return substrateWorkspaceRevisionIn(tx, workspaceID);
      })
    : (ticket?.revision ?? (await resolveRepositoryRevision(project.repository, project.branch)));
  const branch = workspace?.branch ?? ticket?.branch ?? project.branch;
  const actorTemplatePath = prior?.intent.actorTemplatePath ?? project.actorTemplatePath;
  if (!workspace && !changeID && recordStart) {
    // Keep the first explicit request observable even when Project
    // configuration is rejected before any native provisioning intent.
    await sql.begin(async (tx) => {
      await drizzleTransaction(tx).insert(developmentWorkspace).values({
        id: workspaceID,
        projectId: config.projectID,
        kind: "personal",
        ownerUserId: userID,
        sourceBranch: branch,
        sourceRevision: revision,
        createdBy: userID,
      });
      await recordStart(tx, workspaceID);
    });
    startRecorded = true;
    workspace = { owner: userID, changeID: null, branch };
  }
  const sourceConfiguration =
    !prior && workspace && sources?.startupConfiguration
      ? await sql.begin(async (tx) => {
          // Keep current execution authority locked through any exact
          // confirmed setup writes, just like ordinary Source saves.
          await substrateWorkspaceGrantIn(database, tx, workspaceID, userID, true);
          return sources.startupConfiguration?.(workspaceID, actorTemplatePath, tx);
        })
      : undefined;
  // null is authoritative absence in saved Source; only undefined means
  // no Source owner supplied configuration for this checkout.
  let startup: SourceStartupConfiguration;
  if (prior)
    startup = {
      systemContract: prior.intent.systemContract,
      actorTemplate: prior.intent.projectTemplate,
    };
  else if (sourceConfiguration !== undefined) startup = sourceConfiguration;
  else {
    if (!options.readConfiguration)
      throw new Error("Native Workspace requires the normal Project configuration reader");
    startup = await options.readConfiguration(project.repository, revision, actorTemplatePath);
  }
  const { systemContract, actorTemplate: projectTemplate } = startup;
  if (!projectTemplate)
    throw new CommandError("invalid", `Saved ${actorTemplatePath} is required for Workspace Start`);
  if (
    projectTemplate.path !== actorTemplatePath ||
    createHash("sha256").update(projectTemplate.content).digest("hex") !== projectTemplate.sha256
  )
    throw new CommandError("unavailable", "Project ActorTemplate version is unconfirmed");
  let nativeProject: SubstrateProjectTemplate;
  try {
    nativeProject = parseSubstrateProjectTemplate(projectTemplate.content);
  } catch (cause) {
    if (cause instanceof SubstrateProjectTemplateError)
      throw new CommandError("invalid", cause.message);
    throw cause;
  }
  const currentEnvironment = await readProjectEnvironmentIn(sql, config.projectID, "development");
  const environment = prior?.intent.environment ??
    currentEnvironment ?? { version: 0, secretKey: null };
  const apps = systemContract === null ? [] : systemContract.apps;
  const appName = (id: string) => (id === systemContract?.primaryApp ? "app" : `app-${id}`);
  const factoryOrigin = `https://${new URL(config.connectorURL).host}`;
  const origins =
    systemContract === null
      ? undefined
      : runtimeAppOrigins(factoryOrigin, attemptID, systemContract);
  const channels: SubstrateAssignmentChannel[] = [
    { name: "ide", kind: "ide", target: "", healthPath: "" },
    ...apps.map((app) => ({
      name: appName(app.id),
      kind: "app",
      target: `http://127.0.0.1:${app.port}`,
      healthPath: app.healthPath,
    })),
  ];
  const processes: SubstrateAssignmentProcess[] = apps.map((app) => ({
    name: appName(app.id),
    label: app.label,
    command: app.command,
    ...(origins ? { env: { FACTORY_APP_ORIGINS: JSON.stringify(origins) } } : {}),
  }));
  const agent = changeID
    ? await agentConfiguration(
        database,
        changeID,
        options.secret,
        attemptID,
        generation,
        process.env["FACTORY_BROWSER_TOOLS_IMAGE"] ?? null,
        config,
      )
    : undefined;
  if (agent) {
    channels.push({
      name: "agent",
      kind: "agent",
      target: "http://127.0.0.1:4096",
      healthPath: "/api/info",
    });
    processes.push(runtimeAgentProcess(agent));
  }
  const template = renderBoundSubstrateTemplate({
    config,
    secret: options.secret,
    attemptID,
    generation,
    revision,
    actorTemplatePath,
    projectTemplate,
    nativeProject,
    environmentVersion: environment.version,
    channels,
    processes,
    sourceWorkspaceID: workspaceID,
    branch,
    sourceHandoff: Boolean(sources),
    ...(sources ? { inputStop: { version: 1, openCodeVersion: upstream.openCode.version } } : {}),
    ...(agent ? { browserToolsImage: agent.browserToolsImage } : {}),
  });
  const intent: WorkspaceProvision["intent"] = {
    configuration: config,
    revision,
    repositoryURL: project.repository,
    branch,
    actorTemplatePath,
    projectTemplate,
    templateSHA256: substrateTemplateSHA256(template),
    environment,
    systemContract,
  };
  await sql.begin(async (tx) => {
    const transaction = drizzleTransaction(tx);
    if (!workspace && ticket && changeID)
      await transaction.insert(developmentWorkspace).values({
        id: workspaceID,
        projectId: config.projectID,
        kind: "ticket",
        ticketId: ticket.id,
        changeId: changeID,
        sourceBranch: branch,
        sourceRevision: revision,
        createdBy: userID,
      });
    else if (!workspace)
      await transaction.insert(developmentWorkspace).values({
        id: workspaceID,
        projectId: config.projectID,
        kind: "personal",
        ownerUserId: userID,
        sourceBranch: branch,
        sourceRevision: revision,
        createdBy: userID,
      });
    const grant = await substrateWorkspaceGrantIn(database, tx, workspaceID, userID, true);
    if ((await substrateWorkspaceRevisionIn(tx, workspaceID)) !== revision)
      throw new CommandError(
        "conflict",
        "Workspace execution revision changed before native provisioning",
      );
    if (sources)
      await admitInitialSourceSeedIn(tx, {
        workspaceID,
        projectID: grant.projectID,
        repositoryURL: project.repository,
        revision,
        branch,
      });
    if (!prior)
      await transaction
        .insert(substrateProvision)
        .values({ ownerId: workspaceID, kind: "workspace", generation, intent });
    // Every native intent retains its original command before dispatch,
    // including a request recorded during first Workspace initialization.
    if (recordStart && !startRecorded) await recordStart(tx, workspaceID);
  });
  return { template, intent, repository: project.repository, revision };
}
