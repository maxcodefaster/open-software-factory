import { and, desc, eq, isNotNull, sql as query } from "drizzle-orm";
import type { z } from "zod";
import { drizzleTransaction } from "#db/client";
import {
  operation as operationTable,
  project,
  runtimeAttempt,
  substrateProvision,
} from "#db/schema";
import { runtimeIdentity } from "#runtime-domain/identity";
import type { SystemContract } from "#system-contract/system-contract";
import { projectAuthorityIn } from "../access/authority";
import { resolveRepositoryRevision } from "./git-http";
import type { stagingConfiguration } from "./staging-configuration";
import type { SubstrateIsolatedConfiguration } from "./substrate";
import type { BoundNativeProvisioningFacts } from "./substrate-bound-provisioning";
import {
  retainedSubstrateConfiguration,
  type SubstrateWorkspaceConfiguration,
} from "./substrate-configuration";
import type { SubstrateIsolatedOwner } from "./substrate-isolated-grant";
import type { FrozenProjectTemplate } from "./substrate-project-configuration";
import {
  assertCurrentSubstrateDatabase,
  type SubstrateDatabase,
} from "./substrate-provisioning-shared";

export type IsolatedProvision = BoundNativeProvisioningFacts & {
  ownerId: string;
  kind: "staging" | "publication";
  projectId: string;
  generation: number;
  runtimeAttemptId: string;
  intent: {
    configuration: SubstrateWorkspaceConfiguration;
    createdBy: string;
    promotionID: string | null;
    revision: string;
    repository: string;
    actorTemplatePath: string;
    projectTemplate: FrozenProjectTemplate;
    runnerUUID: string | null;
    jobHandle: string | null;
    version: string | null;
    environment: SubstrateIsolatedConfiguration["environment"];
    declaration: z.infer<typeof stagingConfiguration> | null;
    templateSHA256: string;
  };
};

export type IsolatedProvisionPhase =
  | {
      phase: "fresh-generation";
      generation: number;
      attemptID: string;
      config: SubstrateWorkspaceConfiguration;
    }
  | {
      phase: "continue-existing";
      generation: number;
      attemptID: string;
      config: SubstrateWorkspaceConfiguration;
      prior: {
        attemptID: string;
        generation: number;
        intent: IsolatedProvision["intent"];
      };
    };

export type StagingPreviewDecision =
  | { action: "reuse-active"; attemptID: string }
  | { action: "provision" };

export type IsolatedRecoveryAction = "stop" | "start" | "recover";

export function classifyIsolatedRecoveryAction(state: string): IsolatedRecoveryAction {
  if (["stop-intended", "stopping", "cleanup-failed"].includes(state)) return "stop";
  if (state === "create-intended") return "start";
  return "recover";
}

export async function classifyIsolatedProvisionPhase(
  sql: SubstrateDatabase["client"],
  config: SubstrateWorkspaceConfiguration,
  purpose: SubstrateIsolatedOwner,
): Promise<IsolatedProvisionPhase> {
  await assertCurrentSubstrateDatabase(
    sql,
    config.database,
    "Native isolated database differs from its installation",
  );
  const db = drizzleTransaction(sql);
  const [previous] = await db
    .select({
      attemptID: query<string>`${substrateProvision.runtimeAttemptId}`,
      generation: substrateProvision.generation,
      intent: query<IsolatedProvision["intent"]>`${substrateProvision.intent}`,
    })
    .from(substrateProvision)
    .where(
      and(
        eq(substrateProvision.ownerId, purpose.isolatedID),
        eq(substrateProvision.kind, purpose.isolatedKind),
        eq(substrateProvision.projectId, config.projectID),
      ),
    )
    .orderBy(desc(substrateProvision.generation))
    .limit(1);
  const [retired] =
    previous && purpose.isolatedKind === "staging" && !purpose.promotionID
      ? await db
          .select({ id: runtimeAttempt.id })
          .from(runtimeAttempt)
          .where(
            and(
              eq(runtimeAttempt.id, previous.attemptID),
              eq(runtimeAttempt.state, "stopped"),
              isNotNull(runtimeAttempt.deletedAt),
            ),
          )
      : [];
  if (!previous || retired) {
    const generation = retired ? (previous?.generation ?? 0) + 1 : 1;
    return {
      phase: "fresh-generation",
      generation,
      attemptID: runtimeIdentity(purpose.isolatedID, generation).attemptID,
      config,
    };
  }
  return {
    phase: "continue-existing",
    generation: previous.generation,
    attemptID: runtimeIdentity(purpose.isolatedID, previous.generation).attemptID,
    config: retainedSubstrateConfiguration(config, previous.intent.configuration),
    prior: previous,
  };
}

export async function ensureStagingPreviewDecision(options: {
  sql: SubstrateDatabase["client"];
  projectID: string;
  userID: string;
  promotionID: string | undefined;
  readContract: (repository: string, revision: string) => Promise<SystemContract>;
}): Promise<StagingPreviewDecision> {
  const { sql, projectID, userID, promotionID, readContract } = options;
  await sql.begin((tx) => projectAuthorityIn(tx, userID, projectID));
  if (promotionID) return { action: "provision" };
  const db = drizzleTransaction(sql);
  const [previewRow] = await db
    .select({ payload: operationTable.payload })
    .from(operationTable)
    .where(
      and(
        eq(operationTable.kind, "delivery.staging_preview"),
        eq(operationTable.scopeType, "project"),
        eq(operationTable.scopeId, projectID),
        eq(operationTable.idempotencyKey, `delivery.staging_preview:${projectID}`),
      ),
    );
  const preview = previewRow
    ? {
        revision: String(previewRow.payload["revision"] ?? ""),
        attemptID:
          typeof previewRow.payload["runtimeAttemptId"] === "string"
            ? previewRow.payload["runtimeAttemptId"]
            : null,
      }
    : undefined;
  if (preview?.attemptID) {
    const [current] = await db
      .select({ state: runtimeAttempt.state })
      .from(runtimeAttempt)
      .where(and(eq(runtimeAttempt.id, preview.attemptID), isNotNull(runtimeAttempt.atespace)));
    if (!current) throw new Error("Staging must use its original native execution identity");
    if (!["stopped", "create-intended"].includes(current.state))
      return { action: "reuse-active", attemptID: preview.attemptID };
  }
  if (!preview) {
    const [selectedProject] = await db
      .select({ repository: project.repositoryUrl, branch: project.defaultBranch })
      .from(project)
      .where(eq(project.id, projectID));
    if (!selectedProject) throw new Error("Staging Project is unavailable");
    const revision = await resolveRepositoryRevision(
      selectedProject.repository,
      selectedProject.branch,
    );
    await readContract(selectedProject.repository, revision);
    await sql.begin(async (tx) => {
      await projectAuthorityIn(tx, userID, projectID);
      await drizzleTransaction(tx)
        .insert(operationTable)
        .values({
          id: crypto.randomUUID(),
          kind: "delivery.staging_preview",
          scopeType: "project",
          scopeId: projectID,
          idempotencyKey: `delivery.staging_preview:${projectID}`,
          activeKey: null,
          state: "pending",
          payload: { projectId: projectID, revision, runtimeAttemptId: null },
        })
        .onConflictDoNothing({ target: operationTable.idempotencyKey });
    });
  }
  return { action: "provision" };
}
