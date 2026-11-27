import { isDeepStrictEqual } from "node:util";
import { and, eq, isNotNull, isNull, sql as query } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { runtimeAttempt } from "#db/schema";
import { runtimePublicationToken } from "#runtime-domain/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { runtimeVerificationProcess } from "#runtime-kubernetes/verification-process";
import type { SystemContract } from "#system-contract/system-contract";
import { runtimeAppOrigins } from "./app-origins";
import { substrateRepositoryCloneURL } from "./endpoints";
import { stagingConfiguration } from "./staging-configuration";
import {
  requireSubstrateActor,
  type SubstrateIsolatedConfiguration,
  substrateTemplateSHA256,
} from "./substrate";
import type { SubstrateWorkspaceConfiguration } from "./substrate-configuration";
import {
  type SubstrateIsolatedOwner,
  type substrateIsolatedAuthorityIn,
  substrateIsolatedGrantIn,
} from "./substrate-isolated-grant";
import type { IsolatedProvision, IsolatedProvisionPhase } from "./substrate-isolated-phase";
import {
  nativeProjectConfiguration,
  type ProjectConfigurationReader,
} from "./substrate-project-configuration";
import {
  readProjectEnvironmentIn,
  renderBoundSubstrateTemplate,
  type SubstrateDatabase,
} from "./substrate-provisioning-shared";
import { actorRPCIn } from "./substrate-rpc-facts";

export function wrapStagingCapacityCall(options: {
  database: SubstrateDatabase;
  editor: SubstrateCall;
  projectID: string;
  row: IsolatedProvision;
  bound: SubstrateIsolatedConfiguration;
  selected: SubstrateWorkspaceConfiguration;
}): SubstrateCall {
  const { database, editor, projectID, row, bound, selected } = options;
  return async (method, request) => {
    try {
      return await editor(method, request);
    } catch (cause) {
      if (
        row.kind === "staging" &&
        method === "ResumeActor" &&
        cause instanceof SubstrateRPCError &&
        cause.code === "ResourceExhausted"
      ) {
        try {
          // The execution adapter still holds its native runtime lock. Project
          // only a definite initial refusal, never an unknown transport outcome
          // or a checkpoint continuation. Existing Stop/Retry owns cleanup.
          await database.client.begin(async (sql) => {
            const db = drizzleTransaction(sql);
            await substrateIsolatedGrantIn(
              sql,
              projectID,
              {
                isolatedID: row.ownerId,
                isolatedKind: row.kind,
                promotionID: row.intent.promotionID,
              },
              row.runtimeAttemptId,
              row.intent.createdBy,
            );
            const [binding] = await db
              .select()
              .from(runtimeAttempt)
              .where(
                and(
                  eq(runtimeAttempt.id, row.runtimeAttemptId),
                  isNotNull(runtimeAttempt.atespace),
                ),
              );
            const resumed = await actorRPCIn(sql, row.runtimeAttemptId, "resume", "initial");
            const intent = { ...bound, actorSelector: selected.workerSelector };
            if (
              !binding?.atespace ||
              !binding.actorName ||
              !isDeepStrictEqual(binding.bindingIntent, intent) ||
              binding.createRejected ||
              binding.deleteIntendedAt ||
              binding.deletedAt ||
              binding.checkpoint !== null ||
              !resumed?.attempted ||
              resumed.outcome !== null ||
              resumed.originCheckpoint !== null ||
              resumed.stopID !== null ||
              resumed.actorUID !== binding.actorUid ||
              nativeActor.parse(binding.observation).metadata.version !== resumed.nativeVersion ||
              (await actorRPCIn(sql, row.runtimeAttemptId, "suspend", "initial"))
            )
              return;
            const actor = requireSubstrateActor(
              await editor("GetActor", {
                actor: { atespace: binding.atespace, name: binding.actorName },
              }),
              {
                ...binding,
                atespace: binding.atespace,
                actorName: binding.actorName,
                intent,
                actorUID: binding.actorUid,
                attemptedAt: binding.createAttemptedAt?.toISOString() ?? null,
              },
            );
            if (
              actor.metadata.version !== resumed.nativeVersion ||
              actor.status.state !== "ACTOR_STATE_SUSPENDED" ||
              actor.status.workerAssignment ||
              actor.status.assignedNode ||
              actor.status.lastAssignedGeneration ||
              actor.status.snapshots?.length ||
              actor.sourceTag !== undefined
            )
              return;
            await db
              .update(runtimeAttempt)
              .set({
                state: "failed",
                failure:
                  "Staging could not start because native execution capacity was exhausted. Its original resources are retained; stop them before explicitly retrying.",
                updatedAt: query`now()`,
              })
              .where(
                and(
                  eq(runtimeAttempt.id, row.runtimeAttemptId),
                  eq(runtimeAttempt.state, "starting"),
                  isNull(runtimeAttempt.readyAt),
                  isNull(runtimeAttempt.stopIntendedAt),
                ),
              );
          });
        } catch {
          // Missing authority or independent original-Actor proof cannot
          // reclassify the outcome. Preserve the original RPC error.
        }
      }
      throw cause;
    }
  };
}

export async function buildIsolatedProvisionPlan(options: {
  sql: SubstrateDatabase["client"];
  secret: string;
  phase: IsolatedProvisionPhase;
  purpose: SubstrateIsolatedOwner;
  userID: string;
  scope: Awaited<ReturnType<typeof substrateIsolatedAuthorityIn>>;
  readContract: (repository: string, revision: string) => Promise<SystemContract>;
  readConfiguration: ProjectConfigurationReader | undefined;
}) {
  const { sql, secret, phase, purpose, userID, scope, readContract, readConfiguration } = options;
  const { config: selected, generation, attemptID } = phase;
  const prior = phase.phase === "continue-existing" ? phase.prior : undefined;
  const currentEnvironment =
    purpose.isolatedKind === "staging"
      ? await readProjectEnvironmentIn(sql, selected.projectID, "main-preview")
      : undefined;
  const environment = prior?.intent.environment ?? {
    environment:
      purpose.isolatedKind === "staging" ? ("main-preview" as const) : ("development" as const),
    version: currentEnvironment?.version ?? 0,
    secretKey: currentEnvironment?.secretKey ?? null,
  };
  const factoryOrigin = `https://${new URL(selected.connectorURL).host}`;
  const contract =
    purpose.isolatedKind === "staging"
      ? await readContract(scope.repository, scope.revision)
      : undefined;
  const appName = (id: string) => (id === contract?.primaryApp ? "app" : `app-${id}`);
  const declaration = contract
    ? stagingConfiguration.parse({
        actorTemplatePath: scope.actorTemplatePath,
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
  const nativeProject = await nativeProjectConfiguration(
    prior?.intent.projectTemplate,
    readConfiguration,
    scope.repository,
    scope.revision,
    scope.actorTemplatePath,
  );
  const template = renderBoundSubstrateTemplate({
    config: selected,
    secret,
    attemptID,
    generation,
    revision: scope.revision,
    actorTemplatePath: scope.actorTemplatePath,
    projectTemplate: nativeProject.frozen,
    nativeProject: nativeProject.template,
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
    sourceWorkspaceID: attemptID,
    sourceHandoff: false,
  });
  const intent: IsolatedProvision["intent"] = {
    configuration: selected,
    createdBy: userID,
    promotionID: purpose.promotionID,
    revision: scope.revision,
    repository: scope.repository,
    actorTemplatePath: scope.actorTemplatePath,
    projectTemplate: nativeProject.frozen,
    runnerUUID: scope.runnerUUID,
    jobHandle: scope.jobHandle,
    version: scope.version,
    environment,
    declaration,
    templateSHA256: substrateTemplateSHA256(template),
  };
  return { template, intent };
}
