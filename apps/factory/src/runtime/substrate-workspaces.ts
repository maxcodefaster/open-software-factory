import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../../../packages/runtime-domain/src/identity";
import { runtimeAgentProcess } from "../../../../packages/runtime-kubernetes/src/agent-process";
import {
  createSubstrateControl,
  nativeMetadata,
  nativeRuntime,
  type SubstrateCall,
  SubstrateRPCError,
  substrateConnection,
} from "../../../../packages/runtime-kubernetes/src/substrate-control";
import type { SystemContract } from "../../../../packages/system-contract/src/system-contract";
import {
  personalWorkspaceIdentity,
  ticketWorkspaceIdentity,
} from "../../../../packages/workspace-domain/src/workspace";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import type { SubstrateSourceHandoff } from "../workspace/substrate-source";
import { agentConfiguration } from "./agent-configuration";
import {
  prepareRuntimeRepository,
  resolveRepositoryRevision,
  runtimeSourceCapability,
} from "./git-http";
import type { RuntimeHub } from "./hub";
import {
  createSubstrateExecution,
  type SubstrateConfiguration,
  substrateTemplateSHA256,
} from "./substrate";
import type { createSubstrateCapacity } from "./substrate-capacity";
import {
  substrateBootstrapContinuationBlocked,
  substrateBootstrapRetentionIn,
  substrateUnsettledBootstrapIn,
  substrateWorkspaceGrantIn,
} from "./substrate-grant";
import { substrateResourceReservation, substrateResources } from "./substrate-resources";
import { renderSubstrateTemplate } from "./substrate-template";

const configuration = z.strictObject({
  deployment: z.enum(["owned-test", "fresh-workspaces"]),
  database: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  projectID: z.uuid(),
  setupID: z.uuid().optional(),
  connection: substrateConnection,
  provisioner: substrateConnection,
  editorPrincipal: z.string().regex(/^user:system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$/),
  connectorURL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/internal/runtime-connect"
    );
  }),
  factoryCAFile: z.string().startsWith("/"),
  workloadImage: z.string().regex(/^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/),
  prebuildRegistry: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .optional(),
  resources: substrateResources.optional(),
  profile: z.literal("nightly-20261109-975fb172241c"),
  runtime: nativeRuntime,
  workerSelector: z
    .record(z.string(), z.string())
    .refine(
      (labels) =>
        labels["factory.runtime/profile"] === "nightly-20261109-975fb172241c" &&
        Boolean(labels["factory.dev/deployment"]),
    ),
  egressHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
});
export type SubstrateWorkspaceConfiguration = z.infer<typeof configuration>;
export function substrateWorkspaceConfiguration(input: unknown) {
  return configuration.parse(input);
}
export function retainedSubstrateConfiguration(
  desired: SubstrateWorkspaceConfiguration,
  value: unknown,
) {
  const retained = configuration.parse(value);
  const selected = { ...desired, workloadImage: retained.workloadImage };
  // Publication selection is for fresh producers, never a retained Workspace's
  // bootstrap or permission to change its egress.
  if (retained.prebuildRegistry) selected.prebuildRegistry = retained.prebuildRegistry;
  else delete selected.prebuildRegistry;
  if (retained.resources) selected.resources = retained.resources;
  else delete selected.resources;
  if (!isDeepStrictEqual(retained, selected))
    throw new Error("Native provisioning configuration differs from immutable intent");
  return retained;
}
export function configuredSubstrateWorkspaces() {
  const file = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  return file ? configuration.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}
const resource = z.object({ metadata: nativeMetadata }).passthrough();
type Resource = z.infer<typeof resource>;
type Provision = {
  intent: {
    configuration: SubstrateWorkspaceConfiguration;
    revision: string;
    repositoryURL: string;
    branch: string;
    devcontainerPath: string;
    templateSHA256: string;
    environment: { version: number; secretKey: string | null };
    systemContract: SystemContract;
  };
  atespace: Resource | null;
  policy: Resource | null;
  template: Resource | null;
  atespaceAttempted: string | null;
  policyAttempted: string | null;
  templateAttempted: string | null;
  atespaceRejected: boolean;
  policyRejected: boolean;
  templateRejected: boolean;
};

// Fresh personal and Ticket Workspaces. Native provisioning facts use the existing
// Workspace lock; Substrate, not Factory, owns the runtime's transitions.
export function createSubstrateWorkspaces(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  secret: string,
  input: SubstrateWorkspaceConfiguration,
  editorCall?: SubstrateCall,
  provisionerCall?: SubstrateCall,
  readContract?: (repository: string, revision: string) => Promise<SystemContract>,
  sources?: SubstrateSourceHandoff,
  capacity?: Pick<ReturnType<typeof createSubstrateCapacity>, "requireReady">,
) {
  const config = configuration.parse(input);
  const desiredConfiguration = config;
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native proof requires its explicitly owned database");
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);
  function retainedConfiguration(value: unknown) {
    // Image/resource selection changes apply only to fresh owners. Trust,
    // placement and egress still require explicit admission, never rebinding.
    return retainedSubstrateConfiguration(config, value);
  }
  async function absent(call: SubstrateCall, method: string, request: unknown) {
    try {
      return await call(method, request);
    } catch (error) {
      if (error instanceof SubstrateRPCError && error.code === "NotFound") return null;
      throw error;
    }
  }
  async function saved(workspaceID: string, sql = database.client) {
    const [row] = await sql<Provision[]>`SELECT intent,atespace,policy,template,
      atespace_attempted_at::text AS "atespaceAttempted",policy_attempted_at::text AS "policyAttempted",template_attempted_at::text AS "templateAttempted",
      atespace_rejected AS "atespaceRejected",policy_rejected AS "policyRejected",template_rejected AS "templateRejected"
      FROM factory.substrate_workspace WHERE workspace_id=${workspaceID}`;
    if (!row) throw new Error("Native provisioning configuration differs from immutable intent");
    retainedConfiguration(row.intent.configuration);
    return row;
  }
  function execution(workspaceID: string, row: Provision) {
    if (!row.atespace || !row.template || !row.policy)
      throw new Error("Native provisioning outcome is unconfirmed");
    const config = retainedConfiguration(row.intent.configuration);
    const bound: SubstrateConfiguration = {
      deployment: config.deployment,
      database: config.database,
      projectID: config.projectID,
      workspaceID,
      generation: 1,
      connection: config.connection,
      connectorURL: config.connectorURL,
      profile: config.profile,
      runtime: config.runtime,
      workerSelector: config.workerSelector,
      egressHosts: config.egressHosts,
      ...(config.resources ? { resources: config.resources } : {}),
      atespaceUID: row.atespace.metadata.uid,
      templateUID: row.template.metadata.uid,
      templateVersion: row.template.metadata.version,
      templateSHA256: row.intent.templateSHA256,
      environment: row.intent.environment,
      declaredApps: row.intent.systemContract.apps.map((app) =>
        app.id === row.intent.systemContract.primaryApp ? "app" : `app-${app.id}`,
      ),
    };
    return createSubstrateExecution(database, hub, secret, bound, editor, sources);
  }
  return {
    matchesProject: (id: string) => id === config.projectID,
    async forAttempt(attemptID: string) {
      const [attempt] = await database.client<
        { workspaceID: string; generation: string }[]
      >`SELECT a.workspace_id AS "workspaceID",a.generation::text AS generation
        FROM factory.runtime_attempt a JOIN factory.substrate_workspace p ON p.workspace_id=a.workspace_id WHERE a.id=${attemptID} AND a.project_id=${config.projectID} AND a.substrate`;
      if (!attempt) return undefined;
      if (attempt.generation !== "1")
        throw new Error("Native Source handoff/replacement is not enabled");
      return execution(attempt.workspaceID, await saved(attempt.workspaceID));
    },
    async recover() {
      const attempts = await database.client<
        { id: string }[]
      >`SELECT a.id FROM factory.runtime_attempt a JOIN factory.substrate_workspace p ON p.workspace_id=a.workspace_id WHERE a.project_id=${config.projectID} AND a.substrate`;
      for (const attempt of attempts) await (await this.forAttempt(attempt.id))?.recover();
    },
    async start(userID: string, changeID?: string) {
      if (changeID && !sources)
        throw new CommandError(
          "unavailable",
          "Native Ticket execution requires its Source writer owner",
        );
      const workspaceID = changeID
        ? ticketWorkspaceIdentity(changeID).workspaceID
        : personalWorkspaceIdentity(config.projectID, userID).workspaceID;
      const attemptID = runtimeIdentity(workspaceID, 1).attemptID;
      const atespace = `fa-${attemptID.replaceAll("-", "")}`;
      const sql = database.coordination();
      let row: Provision;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${`runtime:${workspaceID}`}))`;
        const [prior] = await sql<
          Provision[]
        >`SELECT intent FROM factory.substrate_workspace WHERE workspace_id=${workspaceID}`;
        const config = prior
          ? retainedConfiguration(prior.intent.configuration)
          : desiredConfiguration;
        const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
        if (db?.name !== config.database)
          throw new Error("Native provisioning requires its explicitly owned database");
        await sql.begin(async (tx) => {
          if (changeID) await projectAuthorityIn(tx, userID, config.projectID);
          else await projectDevelopmentAuthorityIn(tx, userID, config.projectID);
        });
        if (!prior) await capacity?.requireReady(substrateResourceReservation(config));
        const [workspace] = await sql<
          {
            substrate: boolean;
            owner: string | null;
            changeID: string | null;
            revision: string;
            branch: string;
          }[]
        >`SELECT substrate,owner_user_id AS owner,change_id AS "changeID",source_revision AS revision,source_branch AS branch FROM factory.development_workspace WHERE id=${workspaceID}`;
        if (
          workspace &&
          (!workspace.substrate ||
            (changeID ? workspace.changeID !== changeID : workspace.owner !== userID))
        )
          throw new CommandError("conflict", "Retained Workspace is never converted or adopted");
        if (prior && config.deployment === "fresh-workspaces") {
          const retained = await substrateBootstrapRetentionIn(sql, workspaceID, attemptID);
          const unsettled = await substrateUnsettledBootstrapIn(sql, workspaceID, attemptID);
          if (unsettled || (retained && ["failed", "pausing", "paused"].includes(retained.state)))
            throw new CommandError("conflict", substrateBootstrapContinuationBlocked);
        }
        const [ticket] = changeID
          ? await sql<{ id: string; revision: string; branch: string }[]>`
          SELECT c.ticket_id AS id,c.base_sha AS revision,c.branch_name AS branch
          FROM factory.change c JOIN factory.ticket t ON t.id=c.ticket_id
          JOIN factory.branch_create_operation b ON b.change_id=c.id
          WHERE c.id=${changeID} AND c.project_id=${config.projectID}
            AND c.state IN ('starting','active','failed') AND c.cancel_requested_at IS NULL
            AND t.trashed_at IS NULL AND b.state='succeeded' AND b.observed_head_sha=c.base_sha`
          : [];
        if (changeID && !ticket)
          throw new CommandError("conflict", "Approved Ticket branch is not ready");
        const [project] = await sql<
          { repository: string; branch: string; devcontainerPath: string }[]
        >`SELECT repository_url AS repository,default_branch AS branch,devcontainer_path AS "devcontainerPath" FROM factory.project WHERE id=${config.projectID}`;
        if (!project) throw new CommandError("not-found", "Project not found");
        const revision =
          workspace?.revision ??
          ticket?.revision ??
          (await resolveRepositoryRevision(project.repository, project.branch));
        const branch = workspace?.branch ?? ticket?.branch ?? project.branch;
        if (!readContract)
          throw new Error("Native Workspace requires the normal Project System Contract reader");
        const systemContract = await readContract(project.repository, revision);
        const [currentEnvironment] = await sql<
          { version: number; secretKey: string | null }[]
        >`SELECT version::float8 AS version,secret_key AS "secretKey" FROM factory.project_environment WHERE project_id=${config.projectID} AND environment='development'`;
        const environment = prior?.intent.environment ??
          currentEnvironment ?? { version: 0, secretKey: null };
        const appName = (id: string) => (id === systemContract.primaryApp ? "app" : `app-${id}`);
        const tokens = runtimeConnectorTokens(secret, attemptID, 1);
        const endpoint = new URL(config.connectorURL);
        const factoryOrigin = `https://${endpoint.host}`;
        const repositoryURL = new URL(
          `/internal/runtime-source/${attemptID}/${runtimeSourceCapability(attemptID)}`,
          factoryOrigin,
        ).href;
        const assignment = {
          version: 1,
          runtimeAttemptId: attemptID,
          generation: 1,
          workspaceFolder: "/home/rootless/persist/project",
          remoteWorkspaceFolder: "/workspace/project",
          repositoryUrl: repositoryURL,
          repositoryIdentity: config.projectID,
          preserveWorkspace: true,
          revision,
          devcontainerPath: project.devcontainerPath,
          composeProjectName: `workspace-${workspaceID}`,
          controlUrl: config.connectorURL,
          connectorStateDir: "/home/rootless/persist/connector",
          channels: [{ name: "ide", kind: "ide", target: "", healthPath: "" }],
          processes: [],
          environmentVersion: environment.version,
        };
        assignment.channels.push(
          ...systemContract.apps.map((app) => ({
            name: appName(app.id),
            kind: "app",
            target: `http://127.0.0.1:${app.port}`,
            healthPath: app.healthPath,
          })),
        );
        const processes: {
          name: string;
          label?: string;
          command: readonly string[];
          env?: Record<string, string>;
        }[] = systemContract.apps.map((app) => ({
          name: appName(app.id),
          label: app.label,
          command: app.command,
        }));
        const configuredAgent = changeID
          ? await agentConfiguration(
              database,
              changeID,
              secret,
              attemptID,
              1,
              process.env["FACTORY_BROWSER_TOOLS_IMAGE"] ?? null,
            )
          : undefined;
        // Native egress admits the pinned Connector TLS origin, not legacy
        // host.orb/internal HTTP routes. Keep the normal frozen model/token
        // configuration and address both callbacks through that exact origin.
        const agent = configuredAgent
          ? {
              ...configuredAgent,
              modelBaseURL: new URL(`/internal/model/${attemptID}/v1`, factoryOrigin).href,
              browserURL: new URL(`/internal/build-browser/${attemptID}`, factoryOrigin).href,
            }
          : undefined;
        if (agent) {
          assignment.channels.push({
            name: "agent",
            kind: "agent",
            target: "http://127.0.0.1:4096",
            healthPath: "/api/health",
          });
          processes.push(runtimeAgentProcess(agent, 1));
        }
        const bootstrap = {
          sourceHandoff: Boolean(sources),
          assignment: {
            ...assignment,
            processes,
            ...(agent ? { browserToolsImage: agent.browserToolsImage } : {}),
          },
          source: {
            workspaceId: workspaceID,
            projectId: config.projectID,
            revision,
            branch,
            repositoryUrl: repositoryURL,
            originUrl: repositoryURL,
          },
          parentToken: tokens.parent,
          childToken: tokens.child,
          factoryCA: readFileSync(config.factoryCAFile, "utf8"),
        };
        const template = renderSubstrateTemplate(atespace, config, bootstrap);
        const intent = {
          configuration: config,
          revision,
          repositoryURL: project.repository,
          branch,
          devcontainerPath: project.devcontainerPath,
          templateSHA256: substrateTemplateSHA256(template),
          environment,
          systemContract,
        };
        await sql.begin(async (tx) => {
          if (!workspace && ticket && changeID)
            await tx`INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,source_branch,source_revision,created_by,substrate,factorybox_worker_id) VALUES(${workspaceID},${config.projectID},'ticket',${ticket.id},${changeID},${branch},${revision},${userID},true,NULL)`;
          else if (!workspace)
            await tx`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by,substrate,factorybox_worker_id) VALUES(${workspaceID},${config.projectID},'personal',${userID},${branch},${revision},${userID},true,NULL)`;
          await substrateWorkspaceGrantIn(database, tx, workspaceID, userID, true);
          if (!prior)
            await tx`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${workspaceID},${JSON.stringify(intent)}::text::jsonb)`;
        });
        row = await saved(workspaceID, sql);
        if (!isDeepStrictEqual(row.intent, intent))
          throw new Error("Native Workspace inputs differ from immutable provisioning intent");
        if (row.atespaceRejected || row.policyRejected || row.templateRejected)
          throw new Error(
            "Native provisioning Create was rejected; foreign resources are never adopted",
          );
        const spaceRef = { atespace: { name: atespace } };
        const authorize = () =>
          sql.begin((tx) =>
            substrateWorkspaceGrantIn(database, tx, workspaceID, userID, Boolean(changeID)),
          );
        if (!row.atespaceAttempted) {
          if (await absent(owner, "GetAtespace", spaceRef))
            throw new Error("Preexisting Atespace was not adopted");
          await authorize();
          await sql`UPDATE factory.substrate_workspace SET atespace_attempted_at=now() WHERE workspace_id=${workspaceID}`;
          row = await saved(workspaceID, sql);
          try {
            const created = resource.parse(
              await owner("CreateAtespace", { atespace: { metadata: { name: atespace } } }),
            );
            requireOriginal(created, null, row.atespaceAttempted, atespace);
            await sql`UPDATE factory.substrate_workspace SET atespace=${JSON.stringify(created)}::text::jsonb WHERE workspace_id=${workspaceID}`;
          } catch (error) {
            if (rejected(error))
              await sql`UPDATE factory.substrate_workspace SET atespace_rejected=true WHERE workspace_id=${workspaceID}`;
            throw error;
          }
          row = await saved(workspaceID, sql);
        }
        // Once the original grant is confirmed, continuation uses that scoped
        // Editor identity. An expired global provisioning token must not block
        // observation or Resume of an already-owned Workspace.
        const space = resource.parse(await (row.policy ? editor : owner)("GetAtespace", spaceRef));
        requireOriginal(space, row.atespace, row.atespaceAttempted, atespace);
        if (!row.atespace)
          await sql`UPDATE factory.substrate_workspace SET atespace=${JSON.stringify(space)}::text::jsonb WHERE workspace_id=${workspaceID}`;
        const policyRef = { ...spaceRef, name: "default" };
        const bindings = [{ role: "editor", members: [config.editorPrincipal] }];
        if (!row.policyAttempted) {
          if (await absent(owner, "GetAtespaceAccessPolicy", policyRef))
            throw new Error("Preexisting native grant was not adopted");
          await authorize();
          await sql`UPDATE factory.substrate_workspace SET policy_attempted_at=now() WHERE workspace_id=${workspaceID}`;
          row = await saved(workspaceID, sql);
          try {
            const created = resource.parse(
              await owner("CreateAtespaceAccessPolicy", {
                ...spaceRef,
                accessPolicy: { metadata: { name: "default" }, bindings },
              }),
            );
            requireOriginal(created, null, row.policyAttempted, "default");
            if (!isDeepStrictEqual(created["bindings"], bindings))
              throw new Error("Native editor grant differs from its provisioning intent");
            await sql`UPDATE factory.substrate_workspace SET policy=${JSON.stringify(created)}::text::jsonb WHERE workspace_id=${workspaceID}`;
          } catch (error) {
            if (rejected(error))
              await sql`UPDATE factory.substrate_workspace SET policy_rejected=true WHERE workspace_id=${workspaceID}`;
            throw error;
          }
          row = await saved(workspaceID, sql);
        }
        const policy = resource.parse(
          await (row.policy ? editor : owner)("GetAtespaceAccessPolicy", policyRef),
        );
        requireOriginal(policy, row.policy, row.policyAttempted, "default");
        if (!isDeepStrictEqual(policy["bindings"], bindings))
          throw new Error("Native editor grant differs from its provisioning intent");
        if (!row.policy)
          await sql`UPDATE factory.substrate_workspace SET policy=${JSON.stringify(policy)}::text::jsonb WHERE workspace_id=${workspaceID}`;
        const templateRef = { actorTemplate: { atespace, name: "runtime" } };
        if (!row.templateAttempted) {
          if (await absent(editor, "GetActorTemplate", templateRef))
            throw new Error("Preexisting ActorTemplate was not adopted");
          await authorize();
          await sql`UPDATE factory.substrate_workspace SET template_attempted_at=now() WHERE workspace_id=${workspaceID}`;
          row = await saved(workspaceID, sql);
          try {
            const created = resource.parse(
              await editor("CreateActorTemplate", { actorTemplate: template }),
            );
            requireOriginal(created, null, row.templateAttempted, "runtime", atespace);
            if (substrateTemplateSHA256(created) !== intent.templateSHA256)
              throw new Error(
                "Native ActorTemplate spec differs from immutable provisioning intent",
              );
            await sql`UPDATE factory.substrate_workspace SET template=${JSON.stringify({ metadata: created.metadata })}::text::jsonb WHERE workspace_id=${workspaceID}`;
          } catch (error) {
            if (rejected(error))
              await sql`UPDATE factory.substrate_workspace SET template_rejected=true WHERE workspace_id=${workspaceID}`;
            throw error;
          }
          row = await saved(workspaceID, sql);
        }
        const actual = resource.parse(await editor("GetActorTemplate", templateRef));
        requireOriginal(actual, row.template, row.templateAttempted, "runtime", atespace);
        if (substrateTemplateSHA256(actual) !== intent.templateSHA256)
          throw new Error("Native ActorTemplate spec differs from immutable provisioning intent");
        if (!row.template) {
          // Store only public native metadata; never persist role capabilities or source URLs from the template env.
          await sql`UPDATE factory.substrate_workspace SET template=${JSON.stringify({ metadata: actual.metadata })}::text::jsonb WHERE workspace_id=${workspaceID}`;
        }
        row = await saved(workspaceID, sql);
        if (project.repository.startsWith("file://"))
          await prepareRuntimeRepository(attemptID, project.repository, revision);
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext(${`runtime:${workspaceID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
      return execution(workspaceID, row).start(userID);
    },
  };
}
function rejected(error: unknown) {
  return (
    error instanceof SubstrateRPCError &&
    ["AlreadyExists", "PermissionDenied", "Unauthenticated", "InvalidArgument"].includes(error.code)
  );
}
function requireOriginal(
  value: Resource,
  prior: Resource | null,
  attempted: string | null,
  name: string,
  atespace?: string,
) {
  if (
    !attempted ||
    value.metadata.name !== name ||
    value.metadata.atespace !== atespace ||
    Date.parse(value.metadata.createTime) < Date.parse(attempted) ||
    (prior &&
      (prior.metadata.uid !== value.metadata.uid ||
        prior.metadata.version !== value.metadata.version))
  )
    throw new Error("Native provisioning resource differs from its original identity");
}
