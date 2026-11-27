import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { runtimeAttempt, substrateProvision } from "#db/schema";
import { runtimeIdentity } from "#runtime-domain/identity";
import { createSubstrateControl, type SubstrateCall } from "#runtime-kubernetes/substrate-control";
import type { SystemContract } from "#system-contract/system-contract";
import { createCodingRuntimeShutdown } from "../agent/runtime-api";
import type { RuntimeHub } from "./hub";
import { createSubstrateExecution, type SubstrateIsolatedConfiguration } from "./substrate";
import { readProvisionResources } from "./substrate-bound-provisioning";
import type { createSubstrateCapacity } from "./substrate-capacity";
import {
  retainedSubstrateConfiguration,
  type SubstrateWorkspaceConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-configuration";
import {
  type SubstrateIsolatedOwner,
  substrateIsolatedAuthorityIn,
  substrateStagingOwner,
} from "./substrate-isolated-grant";
import {
  classifyIsolatedProvisionPhase,
  classifyIsolatedRecoveryAction,
  ensureStagingPreviewDecision,
  type IsolatedProvision,
} from "./substrate-isolated-phase";
import { buildIsolatedProvisionPlan, wrapStagingCapacityCall } from "./substrate-isolated-plan";
import type { ProjectConfigurationReader } from "./substrate-project-configuration";
import {
  buildBoundSubstrateBase,
  provisionAndPrepareBoundResources,
  substrateAtespaceName,
  withSubstrateAdvisoryLock,
} from "./substrate-provisioning-shared";
import { substrateResourceReservation } from "./substrate-resources";

type Database = ReturnType<typeof createDatabase>;

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
  readConfiguration?: ProjectConfigurationReader,
) {
  const config = substrateWorkspaceConfiguration(input);
  const editor = editorCall ?? createSubstrateControl(config.connection);
  const owner = provisionerCall ?? createSubstrateControl(config.provisioner);

  async function saved(attemptID: string, sql = database.client): Promise<IsolatedProvision> {
    const [selected] = await drizzleTransaction(sql)
      .select({
        ownerId: substrateProvision.ownerId,
        kind: substrateProvision.kind,
        projectId: substrateProvision.projectId,
        generation: substrateProvision.generation,
        runtimeAttemptId: substrateProvision.runtimeAttemptId,
        intent: query<IsolatedProvision["intent"]>`${substrateProvision.intent}`,
        resources: substrateProvision.resources,
      })
      .from(substrateProvision)
      .where(
        and(
          eq(substrateProvision.runtimeAttemptId, attemptID),
          eq(substrateProvision.projectId, config.projectID),
          inArray(substrateProvision.kind, ["staging", "publication"]),
        ),
      );
    if (
      !selected?.runtimeAttemptId ||
      !selected.projectId ||
      (selected.kind !== "staging" && selected.kind !== "publication") ||
      runtimeIdentity(selected.ownerId, selected.generation).attemptID !== selected.runtimeAttemptId
    )
      throw new Error("Native isolated identity differs from its immutable provisioning intent");
    retainedSubstrateConfiguration(config, selected.intent.configuration);
    return {
      ownerId: selected.ownerId,
      kind: selected.kind,
      projectId: selected.projectId,
      generation: selected.generation,
      runtimeAttemptId: selected.runtimeAttemptId,
      intent: selected.intent,
      ...readProvisionResources(selected.resources),
    };
  }

  function execution(row: IsolatedProvision) {
    const selected = retainedSubstrateConfiguration(config, row.intent.configuration);
    const declaration = row.intent.declaration;
    const bound: SubstrateIsolatedConfiguration = {
      ...buildBoundSubstrateBase(
        selected,
        { ...row, templateSHA256: row.intent.templateSHA256 },
        "Native isolated provisioning outcome is unconfirmed",
      ),
      isolatedID: row.ownerId,
      isolatedKind: row.kind,
      promotionID: row.intent.promotionID,
      environment: row.intent.environment,
      ...(declaration ? { declaredApps: declaration.channels.map((channel) => channel.name) } : {}),
    };
    const call = wrapStagingCapacityCall({
      database,
      editor,
      projectID: config.projectID,
      row,
      bound,
      selected,
    });
    return createSubstrateExecution(database, hub, secret, bound, shutdownCoding, call);
  }

  async function provision(
    purpose: SubstrateIsolatedOwner,
    userID: string,
    sql: Database["client"],
  ) {
    const phase = await classifyIsolatedProvisionPhase(sql, config, purpose);
    const scope = await sql.begin((tx) =>
      substrateIsolatedAuthorityIn(tx, config.projectID, purpose, userID, phase.attemptID),
    );
    if (phase.phase === "fresh-generation")
      await capacity?.requireReady(substrateResourceReservation(phase.config));
    const plan = await buildIsolatedProvisionPlan({
      sql,
      secret,
      phase,
      purpose,
      userID,
      scope,
      readContract,
      readConfiguration,
    });
    if (phase.phase === "fresh-generation")
      await sql.begin(async (tx) => {
        await substrateIsolatedAuthorityIn(tx, config.projectID, purpose, userID, phase.attemptID);
        await drizzleTransaction(tx).insert(substrateProvision).values({
          ownerId: purpose.isolatedID,
          kind: purpose.isolatedKind,
          projectId: config.projectID,
          generation: phase.generation,
          runtimeAttemptId: phase.attemptID,
          intent: plan.intent,
        });
      });
    const persisted = await saved(phase.attemptID, sql);
    if (!isDeepStrictEqual(persisted.intent, plan.intent))
      throw new Error("Native isolated inputs differ from their immutable provisioning intent");
    return provisionAndPrepareBoundResources(sql, {
      label: "isolated",
      atespace: substrateAtespaceName(phase.attemptID),
      editorPrincipal: phase.config.editorPrincipal,
      template: plan.template,
      templateSHA256: plan.intent.templateSHA256,
      identity: eq(substrateProvision.runtimeAttemptId, phase.attemptID),
      editor,
      owner,
      authorize: () =>
        sql.begin((tx) =>
          substrateIsolatedAuthorityIn(tx, config.projectID, purpose, userID, phase.attemptID),
        ),
      read: () => saved(phase.attemptID, sql),
      attemptID: phase.attemptID,
      repository: scope.repository,
      revision: scope.revision,
    });
  }

  return {
    async forAttempt(attemptID: string) {
      const [row] = await database.db
        .select({ attemptID: substrateProvision.runtimeAttemptId })
        .from(substrateProvision)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, substrateProvision.runtimeAttemptId))
        .where(
          and(
            inArray(substrateProvision.kind, ["staging", "publication"]),
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.projectId, config.projectID),
            isNull(runtimeAttempt.workspaceId),
            isNull(runtimeAttempt.changeId),
            eq(query`${runtimeAttempt.isolatedKind}::text`, substrateProvision.kind),
          ),
        );
      return row ? execution(await saved(attemptID)) : undefined;
    },
    async stage(userID: string, promotionID?: string) {
      const key = promotionID ? `native-isolated:${promotionID}` : `staging:${config.projectID}`;
      const outcome = await withSubstrateAdvisoryLock(database, key, async (sql) => {
        const decision = await ensureStagingPreviewDecision({
          sql,
          projectID: config.projectID,
          userID,
          promotionID,
          readContract,
        });
        if (decision.action === "reuse-active") return decision;
        const row = await provision(
          {
            isolatedID: promotionID ?? substrateStagingOwner(config.projectID),
            isolatedKind: "staging",
            promotionID: promotionID ?? null,
          },
          userID,
          sql,
        );
        return { action: "start" as const, row };
      });
      if (outcome.action === "reuse-active") return outcome.attemptID;
      return execution(outcome.row).start(userID);
    },
    async publish(publicationID: string, userID: string) {
      const row = await withSubstrateAdvisoryLock(
        database,
        `native-isolated:${publicationID}`,
        (sql) =>
          provision(
            { isolatedID: publicationID, isolatedKind: "publication", promotionID: null },
            userID,
            sql,
          ),
      );
      return execution(row).start(userID);
    },
    async recover() {
      const rows = await database.db
        .select({ id: runtimeAttempt.id, state: runtimeAttempt.state })
        .from(runtimeAttempt)
        .innerJoin(
          substrateProvision,
          and(
            inArray(substrateProvision.kind, ["staging", "publication"]),
            eq(substrateProvision.runtimeAttemptId, runtimeAttempt.id),
          ),
        )
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
        const action = classifyIsolatedRecoveryAction(row.state);
        if (action === "stop") await runtime?.stop();
        else if (action === "start") {
          const persisted = await saved(row.id);
          await runtime?.start(persisted.intent.createdBy);
        } else await runtime?.recover();
      }
    },
  };
}
