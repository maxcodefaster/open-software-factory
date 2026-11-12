import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  nativeMetadata,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../../../packages/runtime-kubernetes/src/substrate-control";
import { CommandError } from "../command-error";
import { runtimeSourceCapability } from "./git-http";
import type { RuntimeHub } from "./hub";
import {
  createSubstrateExecution,
  type SubstratePrebuildConfiguration,
  substrateTemplateSHA256,
} from "./substrate";
import type { createSubstrateCapacity } from "./substrate-capacity";
import { substratePrebuildAuthorityIn } from "./substrate-prebuild-grant";
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
  attemptID: string;
  generation: number;
  intent: {
    configuration: SubstrateWorkspaceConfiguration;
    revision: string;
    repository: string;
    devcontainerPath: string;
    imageRepository: string;
    templateSHA256: string;
    environment: SubstratePrebuildConfiguration["environment"];
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

// The existing preparation queue owns the job. This retains only concrete
// Substrate create facts; the common adapter owns Actor lifecycle and cleanup.
export function createSubstratePrebuild(
  database: Database,
  hub: RuntimeHub,
  secret: string,
  input: SubstrateWorkspaceConfiguration,
  editorCall?: SubstrateCall,
  provisionerCall?: SubstrateCall,
  capacity?: Pick<ReturnType<typeof createSubstrateCapacity>, "requireReady">,
) {
  const config = substrateWorkspaceConfiguration(input);
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);
  async function saved(preparationID: string, sql = database.client) {
    const [row] = await sql<
      Provision[]
    >`SELECT runtime_attempt_id AS "attemptID",generation::float8 AS generation,intent,
      atespace,policy,template,atespace_attempted_at::text AS "atespaceAttempted",policy_attempted_at::text AS "policyAttempted",
      template_attempted_at::text AS "templateAttempted",atespace_rejected AS "atespaceRejected",
      policy_rejected AS "policyRejected",template_rejected AS "templateRejected"
      FROM factory.substrate_prebuild WHERE preparation_id=${preparationID}`;
    if (!row || runtimeIdentity(preparationID, row.generation).attemptID !== row.attemptID)
      throw new Error("Native prebuild deterministic identity differs from immutable intent");
    retainedSubstrateConfiguration(config, row.intent.configuration);
    return row;
  }
  function execution(preparationID: string, row: Provision) {
    if (!row.atespace || !row.policy || !row.template)
      throw new Error("Native prebuild provisioning outcome is unconfirmed");
    const selected = retainedSubstrateConfiguration(config, row.intent.configuration);
    const bound: SubstratePrebuildConfiguration = {
      deployment: selected.deployment,
      database: selected.database,
      projectID: selected.projectID,
      preparationID,
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
    };
    return createSubstrateExecution(database, hub, secret, bound, editor);
  }
  async function absent(call: SubstrateCall, method: string, request: unknown) {
    try {
      return await call(method, request);
    } catch (error) {
      if (error instanceof SubstrateRPCError && error.code === "NotFound") return null;
      throw error;
    }
  }
  return {
    matchesProject: (id: string) => id === config.projectID,
    async forAttempt(attemptID: string) {
      const [row] = await database.client<
        { preparationID: string }[]
      >`SELECT provision.preparation_id AS "preparationID"
        FROM factory.substrate_prebuild provision JOIN factory.runtime_attempt attempt ON attempt.id=provision.runtime_attempt_id
        WHERE attempt.id=${attemptID} AND attempt.substrate AND attempt.project_id=${config.projectID}
          AND attempt.isolated_kind='prebuild' AND attempt.workspace_id IS NULL`;
      return row ? execution(row.preparationID, await saved(row.preparationID)) : undefined;
    },
    async recover() {
      const rows = await database.client<
        { id: string; state: string; preparationID: string }[]
      >`SELECT attempt.id,attempt.state,provision.preparation_id AS "preparationID" FROM factory.runtime_attempt attempt
        JOIN factory.substrate_prebuild provision ON provision.runtime_attempt_id=attempt.id
        WHERE attempt.substrate AND attempt.project_id=${config.projectID}
          AND attempt.state IN ('create-intended','starting','ready','stop-intended','stopping','cleanup-failed')`;
      for (const row of rows) {
        const runtime = await this.forAttempt(row.id);
        if (["stop-intended", "stopping", "cleanup-failed"].includes(row.state))
          await runtime?.stop();
        else if (row.state === "create-intended") await this.start(row.preparationID);
        else await runtime?.recover();
      }
    },
    async start(preparationID: string) {
      const sql = database.coordination();
      let row: Provision;
      let userID: string;
      const attemptID = runtimeIdentity(preparationID, 1).attemptID;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${`native-prebuild:${preparationID}`}))`;
        const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
        if (db?.name !== config.database)
          throw new Error("Native prebuild database differs from its configuration");
        const [prior] = await sql<
          Provision[]
        >`SELECT intent FROM factory.substrate_prebuild WHERE preparation_id=${preparationID}`;
        const selected = prior
          ? retainedSubstrateConfiguration(config, prior.intent.configuration)
          : config;
        const endpoint = new URL(selected.connectorURL);
        const registry = selected.prebuildRegistry;
        if (
          !registry ||
          registry === "localhost" ||
          registry.endsWith(".localhost") ||
          (endpoint.port && endpoint.port !== "443") ||
          (registry !== endpoint.hostname && !selected.egressHosts.includes(registry))
        )
          throw new CommandError(
            "unavailable",
            "Native prebuild requires an explicitly admitted TLS registry on port 443. No legacy runtime was created.",
          );
        const scope = await sql.begin((tx) =>
          substratePrebuildAuthorityIn(tx, config.projectID, preparationID, attemptID),
        );
        userID = scope.userID;
        const environment = prior?.intent.environment ?? {
          environment: scope.environment,
          version: scope.version,
          secretKey: scope.secretKey,
        };
        const [publicationGrant] = await sql`SELECT command_id FROM factory.environment_write
          WHERE project_id=${config.projectID} AND environment=${environment.environment}
            AND secret_key=${environment.secretKey} AND base_version=${environment.version - 1}
            AND state='committed' AND manifest @> ${JSON.stringify({ registries: [{ host: registry, hasPassword: true }] })}::text::jsonb`;
        if (!publicationGrant)
          throw new CommandError(
            "unavailable",
            "Native prebuild requires a committed Project Environment registry publication grant. No runtime was created.",
          );
        if (!prior) await capacity?.requireReady(substrateResourceReservation(selected));
        const imageRepository = `${registry}/open-factory/prebuilds/${config.projectID}`;
        const atespace = `fa-${attemptID.replaceAll("-", "")}`;
        const repositoryURL = new URL(
          `/internal/runtime-source/${attemptID}/${runtimeSourceCapability(attemptID)}`,
          `https://${endpoint.host}`,
        ).href;
        const tokens = runtimeConnectorTokens(secret, attemptID, 1);
        const template = renderSubstrateTemplate(atespace, selected, {
          sourceHandoff: false,
          assignment: {
            version: 1,
            runtimeAttemptId: attemptID,
            generation: 1,
            workspaceFolder: "/home/rootless/persist/project",
            remoteWorkspaceFolder: "/workspace/project",
            repositoryUrl: repositoryURL,
            repositoryIdentity: config.projectID,
            preserveWorkspace: true,
            revision: scope.revision,
            devcontainerPath: scope.devcontainerPath,
            composeProjectName: `prebuild-${preparationID}`,
            controlUrl: selected.connectorURL,
            connectorStateDir: "/home/rootless/persist/connector",
            environmentVersion: environment.version,
            // Same control capability as the existing prebuild manifest. It
            // has no editor HTTP target, App, agent or canonical Source grant.
            channels: [{ name: "ide", kind: "ide", target: "", healthPath: "" }],
            processes: [],
            prebuild: { id: preparationID, platform: "linux/amd64", imageRepository },
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
          revision: scope.revision,
          repository: scope.repository,
          devcontainerPath: scope.devcontainerPath,
          imageRepository,
          environment,
          templateSHA256: substrateTemplateSHA256(template),
        };
        if (!prior)
          await sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${config.projectID}:${scope.environment}`}))`;
            const current = await substratePrebuildAuthorityIn(
              tx,
              config.projectID,
              preparationID,
              attemptID,
            );
            if (
              current.version !== environment.version ||
              current.secretKey !== environment.secretKey
            )
              throw new CommandError(
                "conflict",
                "Native prebuild Environment changed before provisioning",
              );
            await tx`INSERT INTO factory.substrate_prebuild(preparation_id,runtime_attempt_id,generation,intent)
            VALUES(${preparationID},${attemptID},1,${JSON.stringify(intent)}::text::jsonb)`;
          });
        row = await saved(preparationID, sql);
        if (!isDeepStrictEqual(row.intent, intent))
          throw new Error("Native prebuild inputs differ from immutable provisioning intent");
        const bindings = [{ role: "editor", members: [selected.editorPrincipal] }];
        for (const kind of ["atespace", "policy", "template"] as const) {
          if (row[`${kind}Rejected`])
            throw new Error(
              "Native prebuild Create was rejected; foreign resources are never adopted",
            );
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
          const requireOriginal = (value: Resource) => {
            const original = row[kind];
            const attempted = row[`${kind}Attempted`];
            if (
              !attempted ||
              value.metadata.name !==
                (kind === "atespace" ? atespace : kind === "policy" ? "default" : "runtime") ||
              value.metadata.atespace !== (kind === "template" ? atespace : undefined) ||
              Date.parse(value.metadata.createTime) < Date.parse(attempted) ||
              (original &&
                (original.metadata.uid !== value.metadata.uid ||
                  original.metadata.version !== value.metadata.version))
            )
              throw new Error(
                "Native prebuild provisioning resource differs from its original identity",
              );
            if (kind === "template" && substrateTemplateSHA256(value) !== intent.templateSHA256)
              throw new Error("Native prebuild template differs from its frozen intent");
            if (kind === "policy" && !isDeepStrictEqual(value["bindings"], bindings))
              throw new Error("Native prebuild editor grant differs from intent");
          };
          if (!row[`${kind}Attempted`]) {
            if (await absent(call, getMethod, getRequest))
              throw new Error("Preexisting native prebuild resource was not adopted");
            await sql.begin((tx) =>
              substratePrebuildAuthorityIn(tx, config.projectID, preparationID, attemptID),
            );
            await sql.unsafe(
              `UPDATE factory.substrate_prebuild SET ${kind}_attempted_at=now() WHERE preparation_id=$1`,
              [preparationID],
            );
            row = await saved(preparationID, sql);
            const createRequest =
              kind === "atespace"
                ? { atespace: { metadata: { name: atespace } } }
                : kind === "policy"
                  ? {
                      atespace: { name: atespace },
                      accessPolicy: { metadata: { name: "default" }, bindings },
                    }
                  : { actorTemplate: template };
            try {
              const created = resource.parse(
                await call(getMethod.replace("Get", "Create"), createRequest),
              );
              requireOriginal(created);
              const outcome = kind === "template" ? { metadata: created.metadata } : created;
              await sql.unsafe(
                `UPDATE factory.substrate_prebuild SET ${kind}=$1::text::jsonb WHERE preparation_id=$2`,
                [JSON.stringify(outcome), preparationID],
              );
            } catch (error) {
              if (
                error instanceof SubstrateRPCError &&
                [
                  "AlreadyExists",
                  "PermissionDenied",
                  "Unauthenticated",
                  "InvalidArgument",
                ].includes(error.code)
              )
                await sql.unsafe(
                  `UPDATE factory.substrate_prebuild SET ${kind}_rejected=true WHERE preparation_id=$1`,
                  [preparationID],
                );
              throw error;
            }
            row = await saved(preparationID, sql);
          }
          const actual = resource.parse(
            await (kind === "template" || row.policy ? editor : owner)(getMethod, getRequest),
          );
          requireOriginal(actual);
          if (!row[kind]) {
            const outcome = kind === "template" ? { metadata: actual.metadata } : actual;
            await sql.unsafe(
              `UPDATE factory.substrate_prebuild SET ${kind}=$1::text::jsonb WHERE preparation_id=$2`,
              [JSON.stringify(outcome), preparationID],
            );
            row = await saved(preparationID, sql);
          }
        }
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext(${`native-prebuild:${preparationID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
      return execution(preparationID, row).start(userID);
    },
  };
}
