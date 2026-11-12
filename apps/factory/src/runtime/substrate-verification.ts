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
import { runtimeVerificationProcess } from "../../../../packages/runtime-kubernetes/src/verification-process";
import { substrateRepositoryCloneURL } from "./endpoints";
import { runtimeSourceCapability } from "./git-http";
import type { RuntimeHub } from "./hub";
import {
  createSubstrateExecution,
  type SubstrateVerificationConfiguration,
  substrateTemplateSHA256,
} from "./substrate";
import type { createSubstrateCapacity } from "./substrate-capacity";
import { substrateResourceReservation } from "./substrate-resources";
import { renderSubstrateTemplate } from "./substrate-template";
import { substrateVerificationAuthorityIn } from "./substrate-verification-grant";
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
    runnerUUID: string;
    jobHandle: string;
    templateSHA256: string;
    environment: { version: number; secretKey: string | null };
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

// External create facts only. Verification remains the existing product owner;
// the same Substrate adapter owns Actor lifecycle, observation and exact cleanup.
export function createSubstrateVerification(
  database: Database,
  hub: RuntimeHub,
  secret: string,
  input: SubstrateWorkspaceConfiguration,
  editorCall?: SubstrateCall,
  provisionerCall?: SubstrateCall,
  capacity?: Pick<ReturnType<typeof createSubstrateCapacity>, "requireReady">,
) {
  const config = substrateWorkspaceConfiguration(input);
  const desiredConfiguration = config;
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native Verification requires its explicitly owned database");
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);
  async function saved(verificationID: string, attemptID: string, sql = database.client) {
    const [row] = await sql<
      Provision[]
    >`SELECT runtime_attempt_id AS "attemptID",generation::float8 AS generation,intent,
      atespace,policy,template,atespace_attempted_at::text AS "atespaceAttempted",
      policy_attempted_at::text AS "policyAttempted",template_attempted_at::text AS "templateAttempted",
      atespace_rejected AS "atespaceRejected",policy_rejected AS "policyRejected",template_rejected AS "templateRejected"
      FROM factory.substrate_verification WHERE verification_id=${verificationID} AND runtime_attempt_id=${attemptID}`;
    if (!row || runtimeIdentity(verificationID, row.generation).attemptID !== row.attemptID)
      throw new Error(
        "Native Verification configuration or deterministic identity differs from immutable intent",
      );
    retainedSubstrateConfiguration(config, row.intent.configuration);
    return row;
  }
  function execution(verificationID: string, row: Provision) {
    if (!row.atespace || !row.policy || !row.template)
      throw new Error("Native Verification provisioning outcome is unconfirmed");
    const config = retainedSubstrateConfiguration(desiredConfiguration, row.intent.configuration);
    const bound: SubstrateVerificationConfiguration = {
      deployment: config.deployment,
      database: config.database,
      projectID: config.projectID,
      verificationID,
      generation: row.generation,
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
      const [row] = await database.client<{ verificationID: string }[]>`
        SELECT provision.verification_id AS "verificationID" FROM factory.substrate_verification provision
        JOIN factory.runtime_attempt attempt ON attempt.id=provision.runtime_attempt_id AND attempt.substrate
        WHERE attempt.id=${attemptID} AND attempt.project_id=${config.projectID}
          AND attempt.verification_id=provision.verification_id AND attempt.isolated_kind='verification'
          AND attempt.workspace_id IS NULL`;
      return row
        ? execution(row.verificationID, await saved(row.verificationID, attemptID))
        : undefined;
    },
    async recover() {
      const rows = await database.client<
        { id: string }[]
      >`SELECT attempt.id FROM factory.runtime_attempt attempt
        JOIN factory.substrate_verification provision ON provision.runtime_attempt_id=attempt.id
        WHERE attempt.substrate AND attempt.project_id=${config.projectID} AND attempt.state IN ('starting','ready')
          AND attempt.stop_intended_at IS NULL`;
      for (const row of rows) await (await this.forAttempt(row.id))?.recover();
    },
    async start(verificationID: string, userID: string) {
      const sql = database.coordination();
      let row: Provision;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${`native-verification:${verificationID}`}))`;
        const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
        if (db?.name !== config.database)
          throw new Error("Native Verification database differs from its configuration");
        const [previous] = await sql<
          Provision[]
        >`SELECT runtime_attempt_id AS "attemptID",generation::float8 AS generation,intent FROM factory.substrate_verification WHERE verification_id=${verificationID} ORDER BY generation DESC LIMIT 1`;
        // A saved explicit retry releases only its exact cleaned-up predecessor.
        // Provisioning without an Attempt, lost replies and retained executions
        // continue observing their original names, never allocate a successor.
        const [replacement] = previous
          ? await sql`SELECT verification.id FROM factory.verification verification
              JOIN factory.runtime_attempt attempt ON attempt.id=${previous.attemptID}
              JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
              WHERE verification.id=${verificationID} AND verification.runtime_attempt_id IS NULL
                AND verification.state='pending' AND attempt.verification_id=verification.id
                AND attempt.substrate AND attempt.state='stopped' AND binding.deleted_at IS NOT NULL
                AND EXISTS(SELECT 1 FROM factory.execution_policy_command decision
                  WHERE decision.scope='checks-bootstrap-retry:'||verification.change_id::text
                    AND decision.input->>'verificationID'=verification.id::text
                    AND decision.input->>'runtimeAttemptID'=attempt.id::text
                    AND decision.result->>'runtimeAttemptID'=attempt.id::text
                    AND decision.result->>'state'='failed')`
          : [];
        const prior = replacement ? undefined : previous;
        const selectedConfiguration = prior
          ? retainedSubstrateConfiguration(config, prior.intent.configuration)
          : config;
        const generation = replacement ? (previous?.generation ?? 0) + 1 : (prior?.generation ?? 1);
        const attemptID = runtimeIdentity(verificationID, generation).attemptID;
        const scope = await sql.begin((tx) =>
          substrateVerificationAuthorityIn(tx, config.projectID, verificationID, userID, attemptID),
        );
        if (!prior)
          await capacity?.requireReady(substrateResourceReservation(selectedConfiguration));
        const [currentEnvironment] = await sql<{ version: number; secretKey: string | null }[]>`
          SELECT version::float8 AS version,secret_key AS "secretKey" FROM factory.project_environment
          WHERE project_id=${config.projectID} AND environment='development'`;
        const environment = prior?.intent.environment ??
          currentEnvironment ?? { version: 0, secretKey: null };
        const atespace = `fa-${attemptID.replaceAll("-", "")}`;
        const origin = new URL(config.connectorURL);
        const factoryOrigin = `https://${origin.host}`;
        const repositoryURL = new URL(
          `/internal/runtime-source/${attemptID}/${runtimeSourceCapability(attemptID)}`,
          factoryOrigin,
        ).href;
        const forgeURL = new URL(substrateRepositoryCloneURL(scope.repository, config)).origin;
        const tokens = runtimeConnectorTokens(secret, attemptID, generation);
        const template = renderSubstrateTemplate(atespace, selectedConfiguration, {
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
            composeProjectName: `verification-${verificationID}`,
            controlUrl: config.connectorURL,
            connectorStateDir: "/home/rootless/persist/connector",
            environmentVersion: environment.version,
            channels: [
              {
                name: "verification",
                kind: "verification",
                target: "http://127.0.0.1:4500",
                healthPath: "/health",
              },
            ],
            processes: [
              runtimeVerificationProcess({
                forgeURL,
                runnerUUID: scope.runnerUUID,
                runnerToken: scope.runnerToken,
                runnerLabel: "factory-verification",
                handle: scope.jobHandle,
              }),
            ],
          },
          // The initializer's private checkout marker is this Attempt, not a
          // product Workspace. No canonical Source or editor grant is allocated.
          source: {
            workspaceId: attemptID,
            projectId: config.projectID,
            revision: scope.revision,
            repositoryUrl: repositoryURL,
            originUrl: repositoryURL,
          },
          parentToken: tokens.parent,
          childToken: tokens.child,
          factoryCA: readFileSync(config.factoryCAFile, "utf8"),
        });
        const intent: Provision["intent"] = {
          configuration: selectedConfiguration,
          revision: scope.revision,
          repository: scope.repository,
          devcontainerPath: scope.devcontainerPath,
          runnerUUID: scope.runnerUUID,
          jobHandle: scope.jobHandle,
          templateSHA256: substrateTemplateSHA256(template),
          environment,
        };
        if (!prior)
          await sql.begin(async (tx) => {
            await substrateVerificationAuthorityIn(
              tx,
              config.projectID,
              verificationID,
              userID,
              attemptID,
            );
            await tx`INSERT INTO factory.substrate_verification(verification_id,runtime_attempt_id,generation,intent)
            VALUES(${verificationID},${attemptID},${generation},${JSON.stringify(intent)}::text::jsonb)`;
          });
        row = await saved(verificationID, attemptID, sql);
        if (!isDeepStrictEqual(row.intent, intent))
          throw new Error("Native Verification inputs differ from immutable provisioning intent");
        const bindings = [{ role: "editor", members: [config.editorPrincipal] }];
        for (const kind of ["atespace", "policy", "template"] as const) {
          if (row[`${kind}Rejected`])
            throw new Error(
              "Native Verification Create was rejected; foreign resources are never adopted",
            );
          const call = kind === "template" ? editor : owner;
          const getMethod =
            kind === "atespace"
              ? "GetAtespace"
              : kind === "policy"
                ? "GetAtespaceAccessPolicy"
                : "GetActorTemplate";
          const createMethod = getMethod.replace("Get", "Create");
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
              throw new Error("Preexisting native Verification resource was not adopted");
            await sql.begin((tx) =>
              substrateVerificationAuthorityIn(
                tx,
                config.projectID,
                verificationID,
                userID,
                attemptID,
              ),
            );
            // Column names come only from the closed constant list above.
            await sql.unsafe(
              `UPDATE factory.substrate_verification SET ${kind}_attempted_at=now() WHERE verification_id=$1 AND runtime_attempt_id=$2`,
              [verificationID, attemptID],
            );
            row = await saved(verificationID, attemptID, sql);
            try {
              const created = resource.parse(await call(createMethod, createRequest));
              requireOriginal(
                created,
                null,
                row[`${kind}Attempted`],
                kind === "atespace" ? atespace : kind === "policy" ? "default" : "runtime",
                kind === "template" ? atespace : undefined,
              );
              if (kind === "template" && substrateTemplateSHA256(created) !== intent.templateSHA256)
                throw new Error("Native Verification template differs from its frozen intent");
              if (kind === "policy" && !isDeepStrictEqual(created["bindings"], bindings))
                throw new Error("Native Verification editor grant differs from intent");
              const outcome = kind === "template" ? { metadata: created.metadata } : created;
              await sql.unsafe(
                `UPDATE factory.substrate_verification SET ${kind}=$1::text::jsonb WHERE verification_id=$2 AND runtime_attempt_id=$3`,
                [JSON.stringify(outcome), verificationID, attemptID],
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
                  `UPDATE factory.substrate_verification SET ${kind}_rejected=true WHERE verification_id=$1 AND runtime_attempt_id=$2`,
                  [verificationID, attemptID],
                );
              throw error;
            }
            row = await saved(verificationID, attemptID, sql);
          }
          // A confirmed grant lets the scoped Editor observe retained resources;
          // continuing this exact job must not depend on a global Owner token.
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
            throw new Error("Native Verification template differs from its frozen intent");
          if (kind === "policy" && !isDeepStrictEqual(actual["bindings"], bindings))
            throw new Error("Native Verification editor grant differs from intent");
          if (!row[kind]) {
            const outcome = kind === "template" ? { metadata: actual.metadata } : actual;
            await sql.unsafe(
              `UPDATE factory.substrate_verification SET ${kind}=$1::text::jsonb WHERE verification_id=$2 AND runtime_attempt_id=$3`,
              [JSON.stringify(outcome), verificationID, attemptID],
            );
            row = await saved(verificationID, attemptID, sql);
          }
        }
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext(${`native-verification:${verificationID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
      return execution(verificationID, row).start(userID);
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
    throw new Error("Native Verification provisioning resource differs from its original identity");
}
