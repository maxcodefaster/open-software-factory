import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, exists, inArray, isNotNull, isNull, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  executionPolicyCommand,
  projectEnvironment,
  runtimeAttempt,
  substrateBinding,
  substrateVerification,
  verification,
} from "../../../../packages/db/src/schema";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  type SubstrateCall,
} from "../../../../packages/runtime-kubernetes/src/substrate-control";
import { runtimeVerificationProcess } from "../../../../packages/runtime-kubernetes/src/verification-process";
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
  absentBoundNativeResource,
  type BoundNativeProvisioningFacts,
  boundNativeCreateRejected,
  boundNativeProvisioningChecks,
  boundNativeProvisioningKinds,
  boundNativeProvisioningResource,
} from "./substrate-bound-provisioning";
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
type Provision = Omit<
  typeof substrateVerification.$inferSelect,
  keyof BoundNativeProvisioningFacts | "intent"
> &
  BoundNativeProvisioningFacts & {
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
) {
  const config = substrateWorkspaceConfiguration(input);
  const desiredConfiguration = config;
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native Verification requires its explicitly owned database");
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);
  async function saved(verificationID: string, attemptID: string, sql = database.client) {
    const [selected] = await drizzleTransaction(sql)
      .select()
      .from(substrateVerification)
      .where(
        and(
          eq(substrateVerification.verificationId, verificationID),
          eq(substrateVerification.runtimeAttemptId, attemptID),
        ),
      );
    const row = selected as Provision | undefined;
    if (!row || runtimeIdentity(verificationID, row.generation).attemptID !== row.runtimeAttemptId)
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
    return createSubstrateExecution(database, hub, secret, bound, shutdownCoding, editor);
  }
  return {
    matchesProject: (id: string) => id === config.projectID,
    async forAttempt(attemptID: string) {
      const [row] = await database.db
        .select({ verificationID: substrateVerification.verificationId })
        .from(substrateVerification)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, substrateVerification.runtimeAttemptId))
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.projectId, config.projectID),
            eq(runtimeAttempt.verificationId, substrateVerification.verificationId),
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
          substrateVerification,
          eq(substrateVerification.runtimeAttemptId, runtimeAttempt.id),
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
            attemptID: substrateVerification.runtimeAttemptId,
            generation: substrateVerification.generation,
            intent: query<Provision["intent"]>`${substrateVerification.intent}`,
          })
          .from(substrateVerification)
          .where(eq(substrateVerification.verificationId, verificationID))
          .orderBy(desc(substrateVerification.generation))
          .limit(1);
        // A saved explicit retry releases only its exact cleaned-up predecessor.
        // Provisioning without an Attempt, lost replies and retained executions
        // continue observing their original names, never allocate a successor.
        const [replacement] = previous
          ? await db
              .select({ id: verification.id })
              .from(verification)
              .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, previous.attemptID))
              .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
              .where(
                and(
                  eq(verification.id, verificationID),
                  isNull(verification.runtimeAttemptId),
                  eq(verification.state, "pending"),
                  eq(runtimeAttempt.verificationId, verification.id),
                  eq(runtimeAttempt.state, "stopped"),
                  isNotNull(substrateBinding.deletedAt),
                  exists(
                    db
                      .select({ id: executionPolicyCommand.commandId })
                      .from(executionPolicyCommand)
                      .where(
                        and(
                          eq(
                            executionPolicyCommand.scope,
                            query`'checks-bootstrap-retry:' || ${verification.changeId}::text`,
                          ),
                          eq(
                            query`${executionPolicyCommand.input}->>'verificationID'`,
                            query`${verification.id}::text`,
                          ),
                          eq(
                            query`${executionPolicyCommand.input}->>'runtimeAttemptID'`,
                            query`${runtimeAttempt.id}::text`,
                          ),
                          eq(
                            query`${executionPolicyCommand.result}->>'runtimeAttemptID'`,
                            query`${runtimeAttempt.id}::text`,
                          ),
                          eq(query`${executionPolicyCommand.result}->>'state'`, "failed"),
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
        const [currentEnvironment] = await db
          .select({
            version: projectEnvironment.version,
            secretKey: projectEnvironment.secretKey,
          })
          .from(projectEnvironment)
          .where(
            and(
              eq(projectEnvironment.projectId, config.projectID),
              eq(projectEnvironment.environment, "development"),
            ),
          );
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
            await drizzleTransaction(tx).insert(substrateVerification).values({
              verificationId: verificationID,
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
          eq(substrateVerification.verificationId, verificationID),
          eq(substrateVerification.runtimeAttemptId, attemptID),
        );
        for (const kind of boundNativeProvisioningKinds) {
          if (row[`${kind}Rejected`])
            throw new Error(
              "Native Verification Create was rejected; foreign resources are never adopted",
            );
          const call = kind === "template" ? editor : owner;
          const { getMethod, getRequest, createMethod, createRequest, requireOriginal } =
            checks(kind);
          if (!row[`${kind}AttemptedAt`]) {
            if (await absentBoundNativeResource(call, getMethod, getRequest))
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
            await db
              .update(substrateVerification)
              .set({ [`${kind}AttemptedAt`]: query`now()` })
              .where(identity);
            row = await saved(verificationID, attemptID, sql);
            try {
              const created = boundNativeProvisioningResource.parse(
                await call(createMethod, createRequest),
              );
              requireOriginal(created, null, row[`${kind}AttemptedAt`]);
              const outcome = kind === "template" ? { metadata: created.metadata } : created;
              await db
                .update(substrateVerification)
                .set({ [kind]: outcome })
                .where(identity);
            } catch (error) {
              if (boundNativeCreateRejected(error))
                await db
                  .update(substrateVerification)
                  .set({ [`${kind}Rejected`]: true })
                  .where(identity);
              throw error;
            }
            row = await saved(verificationID, attemptID, sql);
          }
          // A confirmed grant lets the scoped Editor observe retained resources;
          // continuing this exact job must not depend on a global Owner token.
          const observer = kind === "template" || row.policy ? editor : owner;
          const actual = boundNativeProvisioningResource.parse(
            await observer(getMethod, getRequest),
          );
          requireOriginal(actual, row[kind], row[`${kind}AttemptedAt`]);
          if (!row[kind]) {
            const outcome = kind === "template" ? { metadata: actual.metadata } : actual;
            await db
              .update(substrateVerification)
              .set({ [kind]: outcome })
              .where(identity);
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
