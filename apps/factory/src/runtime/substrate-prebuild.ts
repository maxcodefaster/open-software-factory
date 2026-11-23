import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, notExists, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  environmentWrite,
  projectImagePreparation,
  runtimeAttempt,
  substratePrebuild,
} from "../../../../packages/db/src/schema";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  type SubstrateCall,
} from "../../../../packages/runtime-kubernetes/src/substrate-control";
import { nativeRuntimeArchitecture } from "../../../../packages/runtime-kubernetes/src/substrate-profile";
import { createCodingRuntimeShutdown } from "../agent/runtime-api";
import { CommandError } from "../command-error";
import { runtimeSourceCapability } from "./git-http";
import type { RuntimeHub } from "./hub";
import {
  createSubstrateExecution,
  type SubstratePrebuildConfiguration,
  substrateTemplateSHA256,
} from "./substrate";
import {
  type BoundNativeProvisioningFacts,
  boundNativeProvisioningChecks,
  provisionBoundNativeResources,
} from "./substrate-bound-provisioning";
import type { createSubstrateCapacity } from "./substrate-capacity";
import { substratePrebuildAuthorityIn } from "./substrate-prebuild-grant";
import { substrateResourceReservation } from "./substrate-resources";
import { renderSubstrateTemplate, substrateBootstrapCA } from "./substrate-template";
import {
  retainedSubstrateConfiguration,
  type SubstrateWorkspaceConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-workspaces";

type Database = ReturnType<typeof createDatabase>;
type Provision = Omit<
  typeof substratePrebuild.$inferSelect,
  keyof BoundNativeProvisioningFacts | "intent"
> &
  BoundNativeProvisioningFacts & {
    intent: {
      configuration: SubstrateWorkspaceConfiguration;
      revision: string;
      repository: string;
      devcontainerPath: string;
      imageRepository: string;
      templateSHA256: string;
      environment: SubstratePrebuildConfiguration["environment"];
    };
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
  shutdownCoding = createCodingRuntimeShutdown(database, hub),
) {
  const config = substrateWorkspaceConfiguration(input);
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);
  async function saved(preparationID: string, sql = database.client) {
    const [selected] = await drizzleTransaction(sql)
      .select()
      .from(substratePrebuild)
      .where(eq(substratePrebuild.preparationId, preparationID));
    const row = selected as Provision | undefined;
    if (!row || runtimeIdentity(preparationID, row.generation).attemptID !== row.runtimeAttemptId)
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
    return createSubstrateExecution(database, hub, secret, bound, shutdownCoding, editor);
  }
  return {
    matchesProject: (id: string) => id === config.projectID,
    async forAttempt(attemptID: string) {
      const [row] = await database.db
        .select({ preparationID: substratePrebuild.preparationId })
        .from(substratePrebuild)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, substratePrebuild.runtimeAttemptId))
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.projectId, config.projectID),
            eq(runtimeAttempt.isolatedKind, "prebuild"),
            isNull(runtimeAttempt.workspaceId),
          ),
        );
      return row ? execution(row.preparationID, await saved(row.preparationID)) : undefined;
    },
    async recover() {
      const rows = await database.db
        .select({
          id: runtimeAttempt.id,
          state: runtimeAttempt.state,
          preparationID: substratePrebuild.preparationId,
        })
        .from(runtimeAttempt)
        .innerJoin(substratePrebuild, eq(substratePrebuild.runtimeAttemptId, runtimeAttempt.id))
        .where(
          and(
            eq(runtimeAttempt.projectId, config.projectID),
            inArray(runtimeAttempt.state, [
              "create-intended",
              "starting",
              "ready",
              "stop-intended",
              "stopping",
              "cleanup-failed",
            ]),
          ),
        );
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
      const db = drizzleTransaction(sql);
      let row: Provision;
      let userID: string;
      const attemptID = runtimeIdentity(preparationID, 1).attemptID;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${`native-prebuild:${preparationID}`}))`;
        const [currentDatabase] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
        if (currentDatabase?.name !== config.database)
          throw new Error("Native prebuild database differs from its configuration");
        const [prior] = await db
          .select({ intent: query<Provision["intent"]>`${substratePrebuild.intent}` })
          .from(substratePrebuild)
          .where(eq(substratePrebuild.preparationId, preparationID));
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
        ) {
          await db
            .update(projectImagePreparation)
            .set({
              state: "unsupported",
              failure:
                "Prepared image publication is not configured for this installation. Normal Dev Container startup remains available.",
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(projectImagePreparation.id, preparationID),
                eq(projectImagePreparation.projectId, config.projectID),
                eq(projectImagePreparation.state, "pending"),
                isNull(projectImagePreparation.runtimeAttemptId),
                notExists(
                  db
                    .select({ id: substratePrebuild.preparationId })
                    .from(substratePrebuild)
                    .where(eq(substratePrebuild.preparationId, projectImagePreparation.id)),
                ),
              ),
            );
          throw new CommandError(
            "unavailable",
            "Native prebuild requires an explicitly admitted TLS registry on port 443. No legacy runtime was created.",
          );
        }
        const scope = await sql.begin((tx) =>
          substratePrebuildAuthorityIn(tx, config.projectID, preparationID, attemptID),
        );
        userID = scope.userID;
        const environment = prior?.intent.environment ?? {
          environment: scope.environment,
          version: scope.version,
          secretKey: scope.secretKey,
        };
        const [publicationGrant] = await db
          .select({ commandID: environmentWrite.commandId })
          .from(environmentWrite)
          .where(
            and(
              eq(environmentWrite.projectId, config.projectID),
              eq(environmentWrite.environment, environment.environment),
              environment.secretKey === null
                ? isNull(environmentWrite.secretKey)
                : eq(environmentWrite.secretKey, environment.secretKey),
              eq(environmentWrite.baseVersion, environment.version - 1),
              eq(environmentWrite.state, "committed"),
              query`${environmentWrite.manifest} @> ${JSON.stringify({ registries: [{ host: registry, hasPassword: true, publish: true }] })}::jsonb`,
            ),
          );
        if (!publicationGrant) {
          await db
            .update(projectImagePreparation)
            .set({
              state: "unsupported",
              failure:
                "Prepared image publication is not authorized in this Environment. Normal Dev Container startup remains available.",
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(projectImagePreparation.id, preparationID),
                eq(projectImagePreparation.state, "pending"),
                isNull(projectImagePreparation.runtimeAttemptId),
              ),
            );
          throw new CommandError(
            "unavailable",
            "Native prebuild requires a committed Project Environment registry publication grant. No runtime was created.",
          );
        }
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
            prebuild: {
              id: preparationID,
              platform: `linux/${nativeRuntimeArchitecture(selected.runtime)}`,
              imageRepository,
            },
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
          factoryCA: substrateBootstrapCA(selected.factoryCAFile),
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
            await drizzleTransaction(tx).insert(substratePrebuild).values({
              preparationId: preparationID,
              runtimeAttemptId: attemptID,
              generation: 1,
              intent,
            });
          });
        row = await saved(preparationID, sql);
        if (!isDeepStrictEqual(row.intent, intent))
          throw new Error("Native prebuild inputs differ from immutable provisioning intent");
        const checks = boundNativeProvisioningChecks(
          "prebuild",
          atespace,
          selected.editorPrincipal,
          template,
          intent.templateSHA256,
        );
        const identity = eq(substratePrebuild.preparationId, preparationID);
        row = await provisionBoundNativeResources({
          label: "prebuild",
          checks,
          editor,
          owner,
          read: () => saved(preparationID, sql),
          authorize: () =>
            sql.begin((tx) =>
              substratePrebuildAuthorityIn(tx, config.projectID, preparationID, attemptID),
            ),
          dispatch: (kind) =>
            db
              .update(substratePrebuild)
              .set({ [`${kind}AttemptedAt`]: query`now()` })
              .where(identity),
          reject: (kind) =>
            db
              .update(substratePrebuild)
              .set({ [`${kind}Rejected`]: true })
              .where(identity),
          remember: (kind, value) =>
            db
              .update(substratePrebuild)
              .set({ [kind]: value })
              .where(identity),
        });
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
