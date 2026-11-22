import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNotNull, isNull, sql as query } from "drizzle-orm";
import type { z } from "zod";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  project,
  projectEnvironment,
  runtimeAttempt,
  stagingPreview,
  substrateBinding,
  substrateIsolated,
} from "../../../../packages/db/src/schema";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
  runtimePublicationToken,
} from "../../../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  type SubstrateCall,
} from "../../../../packages/runtime-kubernetes/src/substrate-control";
import { runtimeVerificationProcess } from "../../../../packages/runtime-kubernetes/src/verification-process";
import type { SystemContract } from "../../../../packages/system-contract/src/system-contract";
import { projectAuthorityIn } from "../access/authority";
import { createCodingRuntimeShutdown } from "../agent/runtime-api";
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
import {
  type BoundNativeProvisioningFacts,
  boundNativeProvisioningChecks,
  provisionBoundNativeResources,
} from "./substrate-bound-provisioning";
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
type Provision = Omit<
  typeof substrateIsolated.$inferSelect,
  keyof BoundNativeProvisioningFacts | "intent" | "kind"
> &
  BoundNativeProvisioningFacts & {
    kind: "staging" | "publication";
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
    const [selected] = await drizzleTransaction(sql)
      .select()
      .from(substrateIsolated)
      .where(
        and(
          eq(substrateIsolated.runtimeAttemptId, attemptID),
          eq(substrateIsolated.projectId, config.projectID),
        ),
      );
    const row = selected as Provision | undefined;
    if (!row || runtimeIdentity(row.ownerId, row.generation).attemptID !== row.runtimeAttemptId)
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
      isolatedID: row.ownerId,
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
  async function provision(
    purpose: SubstrateIsolatedOwner,
    userID: string,
    sql: Database["client"],
  ) {
    const db = drizzleTransaction(sql);
    const [currentDatabase] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    if (currentDatabase?.name !== config.database)
      throw new Error("Native isolated database differs from its installation");
    const [previous] = await db
      .select({
        attemptID: substrateIsolated.runtimeAttemptId,
        generation: substrateIsolated.generation,
        intent: query<Provision["intent"]>`${substrateIsolated.intent}`,
      })
      .from(substrateIsolated)
      .where(
        and(
          eq(substrateIsolated.ownerId, purpose.isolatedID),
          eq(substrateIsolated.kind, purpose.isolatedKind),
          eq(substrateIsolated.projectId, config.projectID),
        ),
      )
      .orderBy(desc(substrateIsolated.generation))
      .limit(1);
    const [retired] =
      previous && purpose.isolatedKind === "staging" && !purpose.promotionID
        ? await db
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
            .where(
              and(
                eq(runtimeAttempt.id, previous.attemptID),
                eq(runtimeAttempt.state, "stopped"),
                isNotNull(substrateBinding.deletedAt),
              ),
            )
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
        ? await db
            .select({
              version: projectEnvironment.version,
              secretKey: projectEnvironment.secretKey,
            })
            .from(projectEnvironment)
            .where(
              and(
                eq(projectEnvironment.projectId, config.projectID),
                eq(projectEnvironment.environment, "main-preview"),
              ),
            )
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
        await drizzleTransaction(tx).insert(substrateIsolated).values({
          ownerId: purpose.isolatedID,
          kind: purpose.isolatedKind,
          projectId: config.projectID,
          generation,
          runtimeAttemptId: attemptID,
          intent,
        });
      });
    let row = await saved(attemptID, sql);
    if (!isDeepStrictEqual(row.intent, intent))
      throw new Error("Native isolated inputs differ from their immutable provisioning intent");
    const checks = boundNativeProvisioningChecks(
      "isolated",
      atespace,
      selected.editorPrincipal,
      template,
      intent.templateSHA256,
    );
    const identity = eq(substrateIsolated.runtimeAttemptId, attemptID);
    row = await provisionBoundNativeResources({
      label: "isolated",
      checks,
      editor,
      owner,
      read: () => saved(attemptID, sql),
      authorize: () =>
        sql.begin((tx) =>
          substrateIsolatedAuthorityIn(tx, config.projectID, purpose, userID, attemptID),
        ),
      dispatch: (kind) =>
        db
          .update(substrateIsolated)
          .set({ [`${kind}AttemptedAt`]: query`now()` })
          .where(identity),
      reject: (kind) =>
        db
          .update(substrateIsolated)
          .set({ [`${kind}Rejected`]: true })
          .where(identity),
      remember: (kind, value) =>
        db
          .update(substrateIsolated)
          .set({ [kind]: value })
          .where(identity),
    });
    if (scope.repository.startsWith("file://"))
      await prepareRuntimeRepository(attemptID, scope.repository, scope.revision);
    return row;
  }
  return {
    async forAttempt(attemptID: string) {
      const [row] = await database.db
        .select({ attemptID: substrateIsolated.runtimeAttemptId })
        .from(substrateIsolated)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, substrateIsolated.runtimeAttemptId))
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.projectId, config.projectID),
            isNull(runtimeAttempt.workspaceId),
            isNull(runtimeAttempt.changeId),
            eq(query`${runtimeAttempt.isolatedKind}::text`, substrateIsolated.kind),
          ),
        );
      return row ? execution(await saved(attemptID)) : undefined;
    },
    async stage(userID: string, promotionID?: string) {
      const sql = database.coordination();
      const db = drizzleTransaction(sql);
      const key = promotionID ? `native-isolated:${promotionID}` : `staging:${config.projectID}`;
      let row: Provision;
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
        await sql.begin((tx) => projectAuthorityIn(tx, userID, config.projectID));
        if (!promotionID) {
          const [preview] = await db
            .select({
              revision: stagingPreview.revision,
              attemptID: stagingPreview.runtimeAttemptId,
            })
            .from(stagingPreview)
            .where(eq(stagingPreview.projectId, config.projectID));
          if (preview?.attemptID) {
            const [current] = await db
              .select({ state: runtimeAttempt.state })
              .from(runtimeAttempt)
              .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
              .where(eq(runtimeAttempt.id, preview.attemptID));
            if (!current)
              throw new Error("Staging must use its original native execution identity");
            if (!["stopped", "create-intended"].includes(current.state)) return preview.attemptID;
          }
          if (!preview) {
            const [selectedProject] = await db
              .select({
                repository: project.repositoryUrl,
                branch: project.defaultBranch,
              })
              .from(project)
              .where(eq(project.id, config.projectID));
            if (!selectedProject) throw new Error("Staging Project is unavailable");
            const revision = await resolveRepositoryRevision(
              selectedProject.repository,
              selectedProject.branch,
            );
            await readContract(selectedProject.repository, revision);
            await sql.begin(async (tx) => {
              await projectAuthorityIn(tx, userID, config.projectID);
              await drizzleTransaction(tx)
                .insert(stagingPreview)
                .values({
                  projectId: config.projectID,
                  revision,
                })
                .onConflictDoNothing({ target: stagingPreview.projectId });
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
      const rows = await database.db
        .select({ id: runtimeAttempt.id, state: runtimeAttempt.state })
        .from(runtimeAttempt)
        .innerJoin(substrateIsolated, eq(substrateIsolated.runtimeAttemptId, runtimeAttempt.id))
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
        else if (row.state === "create-intended") {
          const provision = await saved(row.id);
          await runtime?.start(provision.intent.createdBy);
        } else await runtime?.recover();
      }
    },
  };
}
