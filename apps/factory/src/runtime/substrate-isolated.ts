import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
  runtimePublicationToken,
} from "../../../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  nativeMetadata,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../../../packages/runtime-kubernetes/src/substrate-control";
import { runtimeVerificationProcess } from "../../../../packages/runtime-kubernetes/src/verification-process";
import type { SystemContract } from "../../../../packages/system-contract/src/system-contract";
import { projectAuthorityIn } from "../access/controller";
import { createCodingRuntimeShutdown } from "../agent/runtime-shutdown";
import { runtimeAppOrigins } from "./app-origins";
import { substrateRepositoryCloneURL } from "./endpoints";
import {
  prepareRuntimeRepository,
  resolveRepositoryRevision,
  runtimeSourceCapability,
} from "./git-http";
import type { RuntimeHub } from "./hub";
import { stagingConfiguration } from "./staging-configuration";
import {
  createSubstrateExecution,
  type SubstrateIsolatedConfiguration,
  substrateTemplateSHA256,
} from "./substrate";
import type { createSubstrateCapacity } from "./substrate-capacity";
import {
  type SubstrateIsolatedOwner,
  substrateIsolatedAuthorityIn,
  substrateStagingOwner,
} from "./substrate-isolated-grant";
import { substrateResourceReservation } from "./substrate-resources";
import { renderSubstrateTemplate } from "./substrate-template";
import {
  retainedSubstrateConfiguration,
  type SubstrateWorkspaceConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-workspaces";

type Database = ReturnType<typeof createDatabase>;
const resource = z.object({ metadata: nativeMetadata }).passthrough();
type Resource = z.infer<typeof resource>;
type Provision = {
  ownerID: string;
  kind: "staging" | "publication";
  generation: number;
  attemptID: string;
  intent: {
    configuration: SubstrateWorkspaceConfiguration;
    createdBy: string;
    promotionID: string | null;
    revision: string;
    repository: string;
    devcontainerPath: string;
    runnerUUID: string | null;
    jobHandle: string | null;
    version: string | null;
    environment: SubstrateIsolatedConfiguration["environment"];
    declaration: z.infer<typeof stagingConfiguration> | null;
    templateSHA256: string;
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

// Factory's existing Staging/promotion/publication rows commission these jobs.
// This records their concrete native creates and uses the same Actor adapter.
export function createSubstrateIsolated(
  database: Database,
  hub: RuntimeHub,
  secret: string,
  input: SubstrateWorkspaceConfiguration,
  readContract: (repository: string, revision: string) => Promise<SystemContract>,
  editorCall?: SubstrateCall,
  provisionerCall?: SubstrateCall,
  capacity?: Pick<ReturnType<typeof createSubstrateCapacity>, "requireReady">,
  shutdownCoding = createCodingRuntimeShutdown(database, hub),
) {
  const config = substrateWorkspaceConfiguration(input);
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);
  async function saved(attemptID: string, sql = database.client) {
    const [row] = await sql<Provision[]>`
      SELECT owner_id AS "ownerID",kind,generation::float8 AS generation,runtime_attempt_id AS "attemptID",
        intent,atespace,policy,template,atespace_attempted_at::text AS "atespaceAttempted",
        policy_attempted_at::text AS "policyAttempted",template_attempted_at::text AS "templateAttempted",
        atespace_rejected AS "atespaceRejected",policy_rejected AS "policyRejected",template_rejected AS "templateRejected"
      FROM factory.substrate_isolated WHERE runtime_attempt_id=${attemptID} AND project_id=${config.projectID}`;
    if (!row || runtimeIdentity(row.ownerID, row.generation).attemptID !== row.attemptID)
      throw new Error("Native isolated identity differs from its immutable provisioning intent");
    retainedSubstrateConfiguration(config, row.intent.configuration);
    return row;
  }
  function execution(row: Provision) {
    if (!row.atespace || !row.policy || !row.template)
      throw new Error("Native isolated provisioning outcome is unconfirmed");
    const selected = retainedSubstrateConfiguration(config, row.intent.configuration);
    const declaration = row.intent.declaration;
    const bound: SubstrateIsolatedConfiguration = {
      deployment: selected.deployment,
      database: selected.database,
      projectID: selected.projectID,
      isolatedID: row.ownerID,
      isolatedKind: row.kind,
      promotionID: row.intent.promotionID,
      generation: row.generation,
      connection: selected.connection,
      connectorURL: selected.connectorURL,
      profile: selected.profile,
      runtime: selected.runtime,
      workerSelector: selected.workerSelector,
      egressHosts: selected.egressHosts,
      ...(selected.resources ? { resources: selected.resources } : {}),
      atespaceUID: row.atespace.metadata.uid,
      templateUID: row.template.metadata.uid,
      templateVersion: row.template.metadata.version,
      templateSHA256: row.intent.templateSHA256,
      environment: row.intent.environment,
      ...(declaration ? { declaredApps: declaration.channels.map((channel) => channel.name) } : {}),
    };
    return createSubstrateExecution(database, hub, secret, bound, shutdownCoding, editor);
  }
  async function absent(call: SubstrateCall, method: string, request: unknown) {
    try {
      return await call(method, request);
    } catch (error) {
      if (error instanceof SubstrateRPCError && error.code === "NotFound") return null;
      throw error;
    }
  }
  async function provision(
    purpose: SubstrateIsolatedOwner,
    userID: string,
    sql: Database["client"],
  ) {
    const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    if (db?.name !== config.database)
      throw new Error("Native isolated database differs from its installation");
    const [previous] = await sql<Provision[]>`
      SELECT runtime_attempt_id AS "attemptID",generation::float8 AS generation,intent
      FROM factory.substrate_isolated WHERE owner_id=${purpose.isolatedID} AND kind=${purpose.isolatedKind}
        AND project_id=${config.projectID} ORDER BY generation DESC LIMIT 1`;
    const [retired] =
      previous && purpose.isolatedKind === "staging" && !purpose.promotionID
        ? await sql`SELECT attempt.id FROM factory.runtime_attempt attempt
            JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
            WHERE attempt.id=${previous.attemptID} AND attempt.substrate AND attempt.state='stopped'
              AND binding.deleted_at IS NOT NULL`
        : [];
    const prior = retired ? undefined : previous;
    const generation = retired ? (previous?.generation ?? 0) + 1 : (prior?.generation ?? 1);
    const attemptID = runtimeIdentity(purpose.isolatedID, generation).attemptID;
    const selected = prior
      ? retainedSubstrateConfiguration(config, prior.intent.configuration)
      : config;
    const scope = await sql.begin((tx) =>
      substrateIsolatedAuthorityIn(tx, config.projectID, purpose, userID, attemptID),
    );
    if (!prior) await capacity?.requireReady(substrateResourceReservation(selected));
    const [currentEnvironment] =
      purpose.isolatedKind === "staging"
        ? await sql<{ version: number; secretKey: string | null }[]>`
            SELECT version::float8 AS version,secret_key AS "secretKey" FROM factory.project_environment
            WHERE project_id=${config.projectID} AND environment='main-preview'`
        : [];
    const environment = prior?.intent.environment ?? {
      environment:
        purpose.isolatedKind === "staging" ? ("main-preview" as const) : ("development" as const),
      version: currentEnvironment?.version ?? 0,
      secretKey: currentEnvironment?.secretKey ?? null,
    };
    const atespace = `fa-${attemptID.replaceAll("-", "")}`;
    const factoryOrigin = `https://${new URL(selected.connectorURL).host}`;
    const repositoryURL = new URL(
      `/internal/runtime-source/${attemptID}/${runtimeSourceCapability(attemptID)}`,
      factoryOrigin,
    ).href;
    const tokens = runtimeConnectorTokens(secret, attemptID, generation);
    const contract =
      purpose.isolatedKind === "staging"
        ? await readContract(scope.repository, scope.revision)
        : undefined;
    const appName = (id: string) => (id === contract?.primaryApp ? "app" : `app-${id}`);
    const declaration = contract
      ? stagingConfiguration.parse({
          devcontainerPath: scope.devcontainerPath,
          channels: contract.apps.map((app) => ({
            name: appName(app.id),
            kind: "app",
            target: `http://127.0.0.1:${app.port}`,
            healthPath: app.healthPath,
          })),
          processes: contract.apps.map((app) => ({
            name: appName(app.id),
            label: app.label,
            command: app.command,
          })),
        })
      : null;
    const origins = contract ? runtimeAppOrigins(factoryOrigin, attemptID, contract) : undefined;
    const forgeURL =
      purpose.isolatedKind === "publication"
        ? new URL(substrateRepositoryCloneURL(scope.repository, selected)).origin
        : undefined;
    if (
      purpose.isolatedKind === "publication" &&
      (!forgeURL || !scope.runnerUUID || !scope.runnerToken || !scope.jobHandle || !scope.version)
    )
      throw new Error("Native publication requires its original bound runner and version");
    const publicationProcess =
      forgeURL && scope.runnerUUID && scope.runnerToken && scope.jobHandle && scope.version
        ? runtimeVerificationProcess({
            forgeURL,
            runnerUUID: scope.runnerUUID,
            runnerToken: scope.runnerToken,
            runnerLabel: "factory-publication",
            handle: scope.jobHandle,
            publication: {
              id: purpose.isolatedID,
              version: scope.version,
              credentialURL: new URL(
                `/internal/releases/${purpose.isolatedID}/credentials`,
                factoryOrigin,
              ).href,
              credentialToken: runtimePublicationToken(secret, purpose.isolatedID),
              registryURL: forgeURL,
            },
          })
        : undefined;
    if (!declaration && !publicationProcess)
      throw new Error("Native isolated work requires its original executable owner");
    const template = renderSubstrateTemplate(atespace, selected, {
      sourceHandoff: false,
      assignment: {
        version: 1,
        runtimeAttemptId: attemptID,
        generation,
        workspaceFolder: "/home/rootless/persist/project",
        remoteWorkspaceFolder: "/workspace/project",
        repositoryUrl: repositoryURL,
        repositoryIdentity: config.projectID,
        preserveWorkspace: true,
        revision: scope.revision,
        devcontainerPath: scope.devcontainerPath,
        composeProjectName: `${purpose.isolatedKind}-${purpose.isolatedID}`,
        controlUrl: selected.connectorURL,
        connectorStateDir: "/home/rootless/persist/connector",
        environmentVersion: environment.version,
        channels: declaration?.channels ?? [
          {
            name: "verification",
            kind: "verification",
            target: "http://127.0.0.1:4500",
            healthPath: "/health",
          },
        ],
        processes: declaration
          ? declaration.processes.map((process) => ({
              ...process,
              ...(origins ? { env: { FACTORY_APP_ORIGINS: JSON.stringify(origins) } } : {}),
            }))
          : publicationProcess
            ? [publicationProcess]
            : [],
      },
      source: {
        workspaceId: attemptID,
        projectId: config.projectID,
        revision: scope.revision,
        repositoryUrl: repositoryURL,
        originUrl: repositoryURL,
      },
      parentToken: tokens.parent,
      childToken: tokens.child,
      factoryCA: readFileSync(selected.factoryCAFile, "utf8"),
    });
    const intent: Provision["intent"] = {
      configuration: selected,
      createdBy: userID,
      promotionID: purpose.promotionID,
      revision: scope.revision,
      repository: scope.repository,
      devcontainerPath: scope.devcontainerPath,
      runnerUUID: scope.runnerUUID,
      jobHandle: scope.jobHandle,
      version: scope.version,
      environment,
      declaration,
      templateSHA256: substrateTemplateSHA256(template),
    };
    if (!prior)
      await sql.begin(async (tx) => {
        await substrateIsolatedAuthorityIn(tx, config.projectID, purpose, userID, attemptID);
        await tx`INSERT INTO factory.substrate_isolated(owner_id,kind,project_id,generation,runtime_attempt_id,intent)
        VALUES(${purpose.isolatedID},${purpose.isolatedKind},${config.projectID},${generation},${attemptID},${JSON.stringify(intent)}::text::jsonb)`;
      });
    let row = await saved(attemptID, sql);
    if (!isDeepStrictEqual(row.intent, intent))
      throw new Error("Native isolated inputs differ from their immutable provisioning intent");
    const bindings = [{ role: "editor", members: [selected.editorPrincipal] }];
    for (const kind of ["atespace", "policy", "template"] as const) {
      if (row[`${kind}Rejected`])
        throw new Error("Native isolated Create was rejected; foreign resources are never adopted");
      const call = kind === "template" ? editor : owner;
      const getMethod =
        kind === "atespace"
          ? "GetAtespace"
          : kind === "policy"
            ? "GetAtespaceAccessPolicy"
            : "GetActorTemplate";
      const getRequest =
        kind === "atespace"
          ? { atespace: { name: atespace } }
          : kind === "policy"
            ? { atespace: { name: atespace }, name: "default" }
            : { actorTemplate: { atespace, name: "runtime" } };
      const createRequest =
        kind === "atespace"
          ? { atespace: { metadata: { name: atespace } } }
          : kind === "policy"
            ? {
                atespace: { name: atespace },
                accessPolicy: { metadata: { name: "default" }, bindings },
              }
            : { actorTemplate: template };
      if (!row[`${kind}Attempted`]) {
        if (await absent(call, getMethod, getRequest))
          throw new Error("Preexisting native isolated resource was not adopted");
        await sql.begin((tx) =>
          substrateIsolatedAuthorityIn(tx, config.projectID, purpose, userID, attemptID),
        );
        await sql.unsafe(
          `UPDATE factory.substrate_isolated SET ${kind}_attempted_at=now() WHERE runtime_attempt_id=$1`,
          [attemptID],
        );
        row = await saved(attemptID, sql);
        try {
          const created = resource.parse(
            await call(getMethod.replace("Get", "Create"), createRequest),
          );
          requireOriginal(
            created,
            null,
            row[`${kind}Attempted`],
            kind === "atespace" ? atespace : kind === "policy" ? "default" : "runtime",
            kind === "template" ? atespace : undefined,
          );
          if (kind === "template" && substrateTemplateSHA256(created) !== intent.templateSHA256)
            throw new Error("Native isolated template differs from its frozen intent");
          if (kind === "policy" && !isDeepStrictEqual(created["bindings"], bindings))
            throw new Error("Native isolated Editor grant differs from intent");
          await sql.unsafe(
            `UPDATE factory.substrate_isolated SET ${kind}=$1::text::jsonb WHERE runtime_attempt_id=$2`,
            [
              JSON.stringify(kind === "template" ? { metadata: created.metadata } : created),
              attemptID,
            ],
          );
        } catch (error) {
          if (
            error instanceof SubstrateRPCError &&
            ["AlreadyExists", "PermissionDenied", "Unauthenticated", "InvalidArgument"].includes(
              error.code,
            )
          )
            await sql.unsafe(
              `UPDATE factory.substrate_isolated SET ${kind}_rejected=true WHERE runtime_attempt_id=$1`,
              [attemptID],
            );
          throw error;
        }
        row = await saved(attemptID, sql);
      }
      const observer = kind === "template" || row.policy ? editor : owner;
      const actual = resource.parse(await observer(getMethod, getRequest));
      requireOriginal(
        actual,
        row[kind],
        row[`${kind}Attempted`],
        kind === "atespace" ? atespace : kind === "policy" ? "default" : "runtime",
        kind === "template" ? atespace : undefined,
      );
      if (kind === "template" && substrateTemplateSHA256(actual) !== intent.templateSHA256)
        throw new Error("Native isolated template differs from its frozen intent");
      if (kind === "policy" && !isDeepStrictEqual(actual["bindings"], bindings))
        throw new Error("Native isolated Editor grant differs from intent");
      if (!row[kind]) {
        await sql.unsafe(
          `UPDATE factory.substrate_isolated SET ${kind}=$1::text::jsonb WHERE runtime_attempt_id=$2`,
          [JSON.stringify(kind === "template" ? { metadata: actual.metadata } : actual), attemptID],
        );
        row = await saved(attemptID, sql);
      }
    }
    if (scope.repository.startsWith("file://"))
      await prepareRuntimeRepository(attemptID, scope.repository, scope.revision);
    return row;
  }
  return {
    async forAttempt(attemptID: string) {
      const [row] = await database.client`
        SELECT provision.runtime_attempt_id FROM factory.substrate_isolated provision
        JOIN factory.runtime_attempt attempt ON attempt.id=provision.runtime_attempt_id
        WHERE attempt.id=${attemptID} AND attempt.substrate AND attempt.project_id=${config.projectID}
          AND attempt.workspace_id IS NULL AND attempt.change_id IS NULL AND attempt.isolated_kind::text=provision.kind`;
      return row ? execution(await saved(attemptID)) : undefined;
    },
    async stage(userID: string, promotionID?: string) {
      const sql = database.coordination();
      const key = promotionID ? `native-isolated:${promotionID}` : `staging:${config.projectID}`;
      let row: Provision;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
        await sql.begin((tx) => projectAuthorityIn(tx, userID, config.projectID));
        if (!promotionID) {
          const [preview] = await sql<{ revision: string; attemptID: string | null }[]>`
            SELECT revision,runtime_attempt_id AS "attemptID" FROM factory.staging_preview WHERE project_id=${config.projectID}`;
          if (preview?.attemptID) {
            const [current] = await sql<{ state: string; native: boolean }[]>`
              SELECT state,substrate AS native FROM factory.runtime_attempt WHERE id=${preview.attemptID}`;
            if (!current?.native)
              throw new Error("Staging must use its original native execution identity");
            if (!["stopped", "create-intended"].includes(current.state)) return preview.attemptID;
          }
          if (!preview) {
            const [project] = await sql<{ repository: string; branch: string }[]>`
              SELECT repository_url AS repository,default_branch AS branch FROM factory.project WHERE id=${config.projectID}`;
            if (!project) throw new Error("Staging Project is unavailable");
            const revision = await resolveRepositoryRevision(project.repository, project.branch);
            await readContract(project.repository, revision);
            await sql.begin(async (tx) => {
              await projectAuthorityIn(tx, userID, config.projectID);
              await tx`INSERT INTO factory.staging_preview(project_id,revision) VALUES(${config.projectID},${revision})
                ON CONFLICT(project_id) DO NOTHING`;
            });
          }
        }
        row = await provision(
          {
            isolatedID: promotionID ?? substrateStagingOwner(config.projectID),
            isolatedKind: "staging",
            promotionID: promotionID ?? null,
          },
          userID,
          sql,
        );
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
      return execution(row).start(userID);
    },
    async publish(publicationID: string, userID: string) {
      const sql = database.coordination();
      const key = `native-isolated:${publicationID}`;
      let row: Provision;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
        row = await provision(
          { isolatedID: publicationID, isolatedKind: "publication", promotionID: null },
          userID,
          sql,
        );
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
      return execution(row).start(userID);
    },
    async recover() {
      const rows = await database.client<{ id: string; state: string }[]>`
        SELECT attempt.id,attempt.state FROM factory.runtime_attempt attempt
        JOIN factory.substrate_isolated provision ON provision.runtime_attempt_id=attempt.id
        WHERE attempt.project_id=${config.projectID} AND attempt.substrate
          AND attempt.state IN ('create-intended','starting','ready','stop-intended','stopping','cleanup-failed')`;
      for (const row of rows) {
        const runtime = await this.forAttempt(row.id);
        if (["stop-intended", "stopping", "cleanup-failed"].includes(row.state))
          await runtime?.stop();
        else if (row.state === "create-intended") {
          const provision = await saved(row.id);
          await runtime?.start(provision.intent.createdBy);
        } else await runtime?.recover();
      }
    },
  };
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
    throw new Error("Native isolated provisioning resource differs from its original identity");
}
