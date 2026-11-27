import { isDeepStrictEqual } from "node:util";
import { and, eq, sql as query } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { project as projectModel, runtimeAttempt, substrateProvision } from "#db/schema";
import { createSubstrateControl, type SubstrateCall } from "#runtime-kubernetes/substrate-control";
import { createCodingRuntimeShutdown } from "../agent/runtime-api";
import { CommandError } from "../command-error";
import type { SourceStartupConfiguration, SubstrateSourceHandoff } from "../workspace/source-api";
import type { RuntimeHub } from "./hub";
import { createSubstrateExecution, type SubstrateConfiguration } from "./substrate";
import { readProvisionResources } from "./substrate-bound-provisioning";
import type { SubstrateCapacity } from "./substrate-capacity-contract";
import {
  configuredSubstrateInstallation,
  retainedSubstrateConfiguration,
  type SubstrateInstallationConfiguration,
  type SubstrateWorkspaceConfiguration,
  substrateInstallationConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-configuration";
import { substrateWorkspaceGrantIn } from "./substrate-grant";
import {
  buildBoundSubstrateBase,
  provisionAndPrepareBoundResources,
  verifyRetainedWorkspaceResources,
  withSubstrateAdvisoryLock,
} from "./substrate-provisioning-shared";
import { substrateResourceReservation } from "./substrate-resources";
import {
  classifyWorkspaceProvisionPhase,
  resolveWorkspaceTarget,
  type WorkspaceProvision,
} from "./substrate-workspace-phase";
import { prepareWorkspaceProvisionPlan } from "./substrate-workspace-plan";

export {
  configuredSubstrateInstallation,
  retainedSubstrateConfiguration,
  type SubstrateInstallationConfiguration,
  type SubstrateWorkspaceConfiguration,
  substrateInstallationConfiguration,
  substrateWorkspaceConfiguration,
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
  readConfiguration?: (
    repository: string,
    revision: string,
    actorTemplatePath: string,
  ) => Promise<SourceStartupConfiguration>,
  sources?: SubstrateSourceHandoff,
  capacity?: SubstrateCapacity,
  shutdownCoding = createCodingRuntimeShutdown(database, hub),
) {
  const config = substrateWorkspaceConfiguration(input);
  const desiredConfiguration = config;
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native proof requires its explicitly owned database");
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);

  async function saved(
    workspaceID: string,
    generation: number,
    sql: typeof database.client | DatabaseTransaction = database.client,
  ): Promise<WorkspaceProvision> {
    const [row] = await drizzleTransaction(sql)
      .select({
        generation: substrateProvision.generation,
        intent: query<WorkspaceProvision["intent"]>`${substrateProvision.intent}`,
        resources: substrateProvision.resources,
      })
      .from(substrateProvision)
      .where(
        and(
          eq(substrateProvision.ownerId, workspaceID),
          eq(substrateProvision.kind, "workspace"),
          eq(substrateProvision.generation, generation),
        ),
      );
    if (!row) throw new Error("Native provisioning configuration differs from immutable intent");
    retainedSubstrateConfiguration(config, row.intent.configuration);
    return {
      generation: row.generation,
      intent: row.intent,
      ...readProvisionResources(row.resources),
    };
  }

  function execution(workspaceID: string, row: WorkspaceProvision) {
    const retained = retainedSubstrateConfiguration(config, row.intent.configuration);
    const systemContract = row.intent.systemContract;
    const bound: SubstrateConfiguration = {
      ...buildBoundSubstrateBase(
        retained,
        { ...row, templateSHA256: row.intent.templateSHA256 },
        "Native provisioning outcome is unconfirmed",
      ),
      workspaceID,
      environment: row.intent.environment,
      declaredApps:
        systemContract === null
          ? []
          : systemContract.apps.map((app) =>
              app.id === systemContract.primaryApp ? "app" : `app-${app.id}`,
            ),
    };
    return createSubstrateExecution(database, hub, secret, bound, shutdownCoding, editor, sources);
  }

  return {
    matchesProject: (id: string) => id === config.projectID,
    async forAttempt(
      attemptID: string,
      sql: typeof database.client | DatabaseTransaction = database.client,
    ) {
      const [attempt] = await drizzleTransaction(sql)
        .select({
          workspaceID: substrateProvision.ownerId,
          generation: runtimeAttempt.generation,
        })
        .from(runtimeAttempt)
        .innerJoin(
          substrateProvision,
          and(
            eq(substrateProvision.ownerId, runtimeAttempt.workspaceId),
            eq(substrateProvision.kind, "workspace"),
            eq(substrateProvision.generation, runtimeAttempt.generation),
          ),
        )
        .where(
          and(eq(runtimeAttempt.id, attemptID), eq(runtimeAttempt.projectId, config.projectID)),
        );
      if (!attempt) return undefined;
      return execution(
        attempt.workspaceID,
        await saved(attempt.workspaceID, attempt.generation, sql),
      );
    },
    async recover() {
      const attempts = await database.db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .innerJoin(
          substrateProvision,
          and(
            eq(substrateProvision.ownerId, runtimeAttempt.workspaceId),
            eq(substrateProvision.kind, "workspace"),
            eq(substrateProvision.generation, runtimeAttempt.generation),
          ),
        )
        .where(eq(runtimeAttempt.projectId, config.projectID))
        .orderBy(runtimeAttempt.createdAt, runtimeAttempt.id);
      for (const attempt of attempts) {
        try {
          await (await this.forAttempt(attempt.id))?.recover();
        } catch (cause) {
          // A revoked writer, Stop or superseded generation fences this
          // Workspace, not recovery of later Workspaces in the same Project.
          if (!(cause instanceof CommandError)) throw cause;
        }
      }
    },
    async start(
      userID: string,
      changeID?: string,
      selectedWorkspaceID?: string,
      recordStart?: (sql: DatabaseTransaction, workspaceID: string) => Promise<void>,
    ) {
      const workspaceID = await resolveWorkspaceTarget(
        database,
        config.projectID,
        userID,
        changeID,
        selectedWorkspaceID,
        sources,
      );
      const row = await withSubstrateAdvisoryLock(
        database,
        `runtime:${workspaceID}`,
        async (sql) => {
          const phase = await classifyWorkspaceProvisionPhase({
            database,
            sql,
            desiredConfiguration,
            editor,
            sources,
            capacity,
            workspaceID,
            userID,
            changeID,
            recordStart,
            loadSaved: (id, gen, conn) => saved(id, gen, conn),
          });
          if (phase.phase === "reuse-confirmed") {
            await sql.begin((tx) =>
              substrateWorkspaceGrantIn(database, tx, workspaceID, userID, true),
            );
            const [project] = await drizzleTransaction(sql)
              .select({ repository: projectModel.repositoryUrl })
              .from(projectModel)
              .where(eq(projectModel.id, phase.config.projectID));
            if (project?.repository !== phase.provision.intent.repositoryURL)
              throw new Error(
                "Native Workspace repository differs from its original provisioning intent",
              );
            await verifyRetainedWorkspaceResources(
              editor,
              phase.atespace,
              phase.config.editorPrincipal,
              phase.provision.intent.templateSHA256,
              phase.provision,
            );
            return phase.provision;
          }
          const plan = await prepareWorkspaceProvisionPlan({
            database,
            sql,
            secret,
            phase,
            workspaceID,
            userID,
            changeID,
            readConfiguration,
            sources,
            recordStart,
          });
          if (phase.phase === "fresh-generation" && recordStart)
            await capacity?.requireReady(substrateResourceReservation(phase.config));
          const persisted = await saved(workspaceID, phase.generation, sql);
          if (!isDeepStrictEqual(persisted.intent, plan.intent))
            throw new Error("Native Workspace inputs differ from immutable provisioning intent");
          if (persisted.atespaceRejected || persisted.policyRejected || persisted.templateRejected)
            throw new Error(
              "Native provisioning Create was rejected; foreign resources are never adopted",
            );
          const provisionIdentity = and(
            eq(substrateProvision.ownerId, workspaceID),
            eq(substrateProvision.kind, "workspace"),
            eq(substrateProvision.generation, phase.generation),
          );
          return provisionAndPrepareBoundResources(sql, {
            label: "Workspace",
            atespace: phase.atespace,
            editorPrincipal: phase.config.editorPrincipal,
            template: plan.template,
            templateSHA256: plan.intent.templateSHA256,
            identity: provisionIdentity,
            editor,
            owner,
            authorize: () =>
              sql.begin((tx) =>
                substrateWorkspaceGrantIn(database, tx, workspaceID, userID, Boolean(changeID)),
              ),
            read: () => saved(workspaceID, phase.generation, sql),
            attemptID: phase.attemptID,
            repository: plan.repository,
            revision: plan.revision,
          });
        },
      );
      return execution(workspaceID, row).start(userID);
    },
  };
}
