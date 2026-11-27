import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, exists, inArray, isNotNull, isNull, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  auditEvent,
  operation as operationTable,
  runtimeAttempt,
  substrateProvision,
  verification,
} from "#db/schema";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
  runtimeProjectEntryToken,
} from "#runtime-domain/identity";
import { createSubstrateControl, type SubstrateCall } from "#runtime-kubernetes/substrate-control";
import { runtimeVerificationProcess } from "#runtime-kubernetes/verification-process";
import { createCodingRuntimeShutdown } from "../agent/runtime-api";
import { substrateRepositoryCloneURL } from "./endpoints";
import { runtimeSourceCapability } from "./git-http";
import type { RuntimeHub } from "./hub";
import {
  createSubstrateExecution,
  type SubstrateVerificationConfiguration,
  substrateTemplateSHA256,
} from "./substrate";
import {
  type BoundNativeProvisioningFacts,
  boundNativeProvisioningChecks,
  dispatchProvisionResourceIn,
  provisionBoundNativeResources,
  readProvisionResources,
  rejectProvisionResourceIn,
  rememberProvisionResourceIn,
} from "./substrate-bound-provisioning";
import type { createSubstrateCapacity } from "./substrate-capacity";
import {
  type FrozenProjectTemplate,
  nativeProjectConfiguration,
  type ProjectConfigurationReader,
} from "./substrate-project-configuration";
import { substrateResourceReservation } from "./substrate-resources";
import { renderSubstrateTemplate, substrateBootstrapCA } from "./substrate-template";
import { substrateVerificationAuthorityIn } from "./substrate-verification-grant";
import {
  retainedSubstrateConfiguration,
  type SubstrateWorkspaceConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-workspaces";

type Database = ReturnType<typeof createDatabase>;
type Provision = BoundNativeProvisioningFacts & {
  ownerId: string;
  runtimeAttemptId: string;
  generation: number;
  intent: {
    configuration: SubstrateWorkspaceConfiguration;
    revision: string;
    repository: string;
    actorTemplatePath: string;
    projectTemplate: FrozenProjectTemplate;
    runnerUUID: string;
    jobHandle: string;
    templateSHA256: string;
    environment: { version: number; secretKey: string | null };
  };
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
  shutdownCoding = createCodingRuntimeShutdown(database, hub),
  readConfiguration?: ProjectConfigurationReader,
) {
  const config = substrateWorkspaceConfiguration(input);
  const desiredConfiguration = config;
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native Verification requires its explicitly owned database");
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);
  async function saved(
    verificationID: string,
    attemptID: string,
    sql = database.client,
  ): Promise<Provision> {
    const [selected] = await drizzleTransaction(sql)
      .select({
        ownerId: substrateProvision.ownerId,
        runtimeAttemptId: substrateProvision.runtimeAttemptId,
        generation: substrateProvision.generation,
        intent: query<Provision["intent"]>`${substrateProvision.intent}`,
        resources: substrateProvision.resources,
      })
      .from(substrateProvision)
      .where(
        and(
          eq(substrateProvision.ownerId, verificationID),
          eq(substrateProvision.kind, "verification"),
          eq(substrateProvision.runtimeAttemptId, attemptID),
        ),
      );
    if (
      !selected?.runtimeAttemptId ||
      runtimeIdentity(verificationID, selected.generation).attemptID !== selected.runtimeAttemptId
    )
      throw new Error(
        "Native Verification configuration or deterministic identity differs from immutable intent",
      );
    retainedSubstrateConfiguration(config, selected.intent.configuration);
    return {
      ownerId: selected.ownerId,
      runtimeAttemptId: selected.runtimeAttemptId,
      generation: selected.generation,
      intent: selected.intent,
      ...readProvisionResources(selected.resources),
    };
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
    return createSubstrateExecution(database, hub, secret, bound, shutdownCoding, editor);
  }
  return {
    matchesProject: (id: string) => id === config.projectID,
    async forAttempt(attemptID: string) {
      const [row] = await database.db
        .select({ verificationID: substrateProvision.ownerId })
        .from(substrateProvision)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, substrateProvision.runtimeAttemptId))
        .where(
          and(
            eq(substrateProvision.kind, "verification"),
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.projectId, config.projectID),
            eq(runtimeAttempt.verificationId, substrateProvision.ownerId),
            eq(runtimeAttempt.isolatedKind, "verification"),
            isNull(runtimeAttempt.workspaceId),
          ),
        );
      return row
        ? execution(row.verificationID, await saved(row.verificationID, attemptID))
        : undefined;
    },
    async recover() {
      const rows = await database.db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .innerJoin(
          substrateProvision,
          and(
            eq(substrateProvision.kind, "verification"),
            eq(substrateProvision.runtimeAttemptId, runtimeAttempt.id),
          ),
        )
        .where(
          and(
            eq(runtimeAttempt.projectId, config.projectID),
            inArray(runtimeAttempt.state, ["starting", "ready"]),
            isNull(runtimeAttempt.stopIntendedAt),
          ),
        );
      for (const row of rows) await (await this.forAttempt(row.id))?.recover();
    },
    async start(verificationID: string, userID: string) {
      const sql = database.coordination();
      const db = drizzleTransaction(sql);
      let row: Provision;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${`native-verification:${verificationID}`}))`;
        const [currentDatabase] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
        if (currentDatabase?.name !== config.database)
          throw new Error("Native Verification database differs from its configuration");
        const [previous] = await db
          .select({
            attemptID: query<string>`${substrateProvision.runtimeAttemptId}`,
            generation: substrateProvision.generation,
            intent: query<Provision["intent"]>`${substrateProvision.intent}`,
          })
          .from(substrateProvision)
          .where(
            and(
              eq(substrateProvision.ownerId, verificationID),
              eq(substrateProvision.kind, "verification"),
            ),
          )
          .orderBy(desc(substrateProvision.generation))
          .limit(1);
        // A saved explicit retry releases only its exact cleaned-up predecessor.
        // Provisioning without an Attempt, lost replies and retained executions
        // continue observing their original names, never allocate a successor.
        const [replacement] = previous
          ? await db
              .select({ id: verification.id })
              .from(verification)
              .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, previous.attemptID))
              .where(
                and(
                  eq(verification.id, verificationID),
                  isNull(verification.runtimeAttemptId),
                  eq(verification.state, "pending"),
                  eq(runtimeAttempt.verificationId, verification.id),
                  eq(runtimeAttempt.state, "stopped"),
                  isNotNull(runtimeAttempt.deletedAt),
                  exists(
                    db
                      .select({ id: auditEvent.id })
                      .from(auditEvent)
                      .where(
                        and(
                          eq(auditEvent.kind, "usage.policy_command"),
                          eq(auditEvent.scopeType, "execution_policy"),
                          eq(
                            auditEvent.scopeId,
                            query`'checks-bootstrap-retry:' || ${verification.changeId}::text`,
                          ),
                          eq(
                            query`${auditEvent.payload}->'input'->>'verificationID'`,
                            query`${verification.id}::text`,
                          ),
                          eq(
                            query`${auditEvent.payload}->'input'->>'runtimeAttemptID'`,
                            query`${runtimeAttempt.id}::text`,
                          ),
                          eq(
                            query`${auditEvent.payload}->'result'->>'runtimeAttemptID'`,
                            query`${runtimeAttempt.id}::text`,
                          ),
                          eq(query`${auditEvent.payload}->'result'->>'state'`, "failed"),
                        ),
                      ),
                  ),
                ),
              )
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
        const [currentEnvironmentRow] = await db
          .select({ payload: operationTable.payload })
          .from(operationTable)
          .where(
            and(
              eq(operationTable.kind, "environments.environment"),
              eq(operationTable.scopeType, "project"),
              eq(operationTable.scopeId, config.projectID),
              eq(
                operationTable.idempotencyKey,
                `environments.environment:${config.projectID}:development`,
              ),
            ),
          );
        const currentEnvironment = currentEnvironmentRow
          ? {
              version: Number(currentEnvironmentRow.payload["version"] ?? 0),
              secretKey:
                typeof currentEnvironmentRow.payload["secretKey"] === "string"
                  ? currentEnvironmentRow.payload["secretKey"]
                  : null,
            }
          : undefined;
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
        const nativeProject = await nativeProjectConfiguration(
          prior?.intent.projectTemplate,
          readConfiguration,
          scope.repository,
          scope.revision,
          scope.actorTemplatePath,
        );
        const template = renderSubstrateTemplate(
          atespace,
          selectedConfiguration,
          {
            entryTokens: Object.fromEntries(
              nativeProject.template.containers.map(({ name }) => [
                name,
                runtimeProjectEntryToken(secret, attemptID, generation, name),
              ]),
            ),
            projectTemplate: {
              path: nativeProject.frozen.path,
              sha256: nativeProject.frozen.sha256,
            },
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
              actorTemplatePath: scope.actorTemplatePath,
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
            factoryCA: substrateBootstrapCA(config.factoryCAFile),
          },
          nativeProject.template,
        );
        const intent: Provision["intent"] = {
          configuration: selectedConfiguration,
          revision: scope.revision,
          repository: scope.repository,
          actorTemplatePath: scope.actorTemplatePath,
          projectTemplate: nativeProject.frozen,
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
            await drizzleTransaction(tx).insert(substrateProvision).values({
              ownerId: verificationID,
              kind: "verification",
              runtimeAttemptId: attemptID,
              generation,
              intent,
            });
          });
        row = await saved(verificationID, attemptID, sql);
        if (!isDeepStrictEqual(row.intent, intent))
          throw new Error("Native Verification inputs differ from immutable provisioning intent");
        const checks = boundNativeProvisioningChecks(
          "Verification",
          atespace,
          config.editorPrincipal,
          template,
          intent.templateSHA256,
        );
        const identity = and(
          eq(substrateProvision.ownerId, verificationID),
          eq(substrateProvision.kind, "verification"),
          eq(substrateProvision.runtimeAttemptId, attemptID),
        );
        row = await provisionBoundNativeResources({
          label: "Verification",
          checks,
          editor,
          owner,
          read: () => saved(verificationID, attemptID, sql),
          authorize: () =>
            sql.begin((tx) =>
              substrateVerificationAuthorityIn(
                tx,
                config.projectID,
                verificationID,
                userID,
                attemptID,
              ),
            ),
          dispatch: (kind) => dispatchProvisionResourceIn(sql, identity, kind),
          reject: (kind) => rejectProvisionResourceIn(sql, identity, kind),
          remember: (kind, value) => rememberProvisionResourceIn(sql, identity, kind, value),
        });
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
