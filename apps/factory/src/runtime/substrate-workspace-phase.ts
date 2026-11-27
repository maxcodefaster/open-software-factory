import { and, desc, eq, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { developmentWorkspace, runtimeAttempt, substrateProvision } from "#db/schema";
import { runtimeIdentity } from "#runtime-domain/identity";
import type { SubstrateCall } from "#runtime-kubernetes/substrate-control";
import type { SystemContract } from "#system-contract/system-contract";
import { personalWorkspaceIdentity, ticketWorkspaceIdentity } from "#workspace-domain/workspace";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { CommandError } from "../command-error";
import type { SourceStartupConfiguration, SubstrateSourceHandoff } from "../workspace/source-api";
import {
  absentBoundNativeResource,
  type BoundNativeProvisioningFacts,
} from "./substrate-bound-provisioning";
import type { SubstrateCapacity } from "./substrate-capacity-contract";
import {
  retainedSubstrateConfiguration,
  type SubstrateWorkspaceConfiguration,
} from "./substrate-configuration";
import {
  substrateBootstrapContinuationBlocked,
  substrateBootstrapRetentionIn,
  substrateUnsettledBootstrapIn,
  substrateWorkspaceGrantIn,
} from "./substrate-grant";
import {
  assertCurrentSubstrateDatabase,
  type SubstrateDatabase,
  substrateAtespaceName,
} from "./substrate-provisioning-shared";
import { substrateResourceReservation } from "./substrate-resources";

export type WorkspaceProvision = BoundNativeProvisioningFacts & {
  generation: number;
  intent: {
    configuration: SubstrateWorkspaceConfiguration;
    revision: string;
    repositoryURL: string;
    branch: string;
    actorTemplatePath: string;
    projectTemplate: NonNullable<SourceStartupConfiguration["actorTemplate"]>;
    templateSHA256: string;
    environment: { version: number; secretKey: string | null };
    systemContract: SystemContract | null;
  };
};

export type WorkspaceRecord = {
  owner: string | null;
  changeID: string | null;
  branch: string;
};

export type WorkspaceProvisionPhase =
  | {
      phase: "reuse-confirmed";
      generation: number;
      attemptID: string;
      atespace: string;
      config: SubstrateWorkspaceConfiguration;
      provision: WorkspaceProvision;
    }
  | {
      phase: "resume-incomplete";
      generation: number;
      attemptID: string;
      atespace: string;
      config: SubstrateWorkspaceConfiguration;
      prior: WorkspaceProvision;
      workspace: WorkspaceRecord | undefined;
      startRecorded: boolean;
    }
  | {
      phase: "fresh-generation";
      generation: number;
      attemptID: string;
      atespace: string;
      config: SubstrateWorkspaceConfiguration;
      workspace: WorkspaceRecord | undefined;
      startRecorded: boolean;
    };

export async function resolveWorkspaceTarget(
  database: SubstrateDatabase,
  projectID: string,
  userID: string,
  changeID: string | undefined,
  selectedWorkspaceID: string | undefined,
  sources: SubstrateSourceHandoff | undefined,
): Promise<string> {
  if (changeID && !sources)
    throw new CommandError(
      "unavailable",
      "Native Ticket execution requires its Source writer owner",
    );
  if (!selectedWorkspaceID)
    return changeID
      ? ticketWorkspaceIdentity(changeID).workspaceID
      : personalWorkspaceIdentity(projectID, userID).workspaceID;
  if (changeID)
    throw new CommandError("conflict", "Ticket Workspace selection is fixed by its Change");
  const selected = await database.client.begin((sql) =>
    workspaceWriteAuthorityIn(sql, selectedWorkspaceID, userID),
  );
  if (
    selected.kind !== "personal" ||
    selected.projectID !== projectID ||
    !selected.ownerID ||
    selectedWorkspaceID !== personalWorkspaceIdentity(projectID, selected.ownerID).workspaceID
  )
    throw new CommandError("not-found", "Personal Workspace not found");
  return selectedWorkspaceID;
}

export async function classifyWorkspaceProvisionPhase(options: {
  database: SubstrateDatabase;
  sql: SubstrateDatabase["client"];
  desiredConfiguration: SubstrateWorkspaceConfiguration;
  editor: SubstrateCall;
  sources: SubstrateSourceHandoff | undefined;
  capacity: SubstrateCapacity | undefined;
  workspaceID: string;
  userID: string;
  changeID: string | undefined;
  recordStart: ((sql: DatabaseTransaction, workspaceID: string) => Promise<void>) | undefined;
  loadSaved(
    workspaceID: string,
    generation: number,
    sql: SubstrateDatabase["client"],
  ): Promise<WorkspaceProvision>;
}): Promise<WorkspaceProvisionPhase> {
  const { database, sql, desiredConfiguration, workspaceID, userID, changeID, recordStart } =
    options;
  const db = drizzleTransaction(sql);
  const [latest] = await db
    .select({
      generation: substrateProvision.generation,
      intent: query<WorkspaceProvision["intent"]>`${substrateProvision.intent}`,
    })
    .from(substrateProvision)
    .where(
      and(eq(substrateProvision.ownerId, workspaceID), eq(substrateProvision.kind, "workspace")),
    )
    .orderBy(desc(substrateProvision.generation))
    .limit(1);
  const originalConfiguration = latest
    ? retainedSubstrateConfiguration(desiredConfiguration, latest.intent.configuration)
    : desiredConfiguration;
  await assertCurrentSubstrateDatabase(
    sql,
    originalConfiguration.database,
    "Native provisioning requires its explicitly owned database",
  );
  let startRecorded = false;
  await sql.begin(async (tx) => {
    if (changeID) await projectAuthorityIn(tx, userID, originalConfiguration.projectID);
    else await projectDevelopmentAuthorityIn(tx, userID, originalConfiguration.projectID);
    if (recordStart) {
      const [existing] = await drizzleTransaction(tx)
        .select({ id: developmentWorkspace.id })
        .from(developmentWorkspace)
        .where(eq(developmentWorkspace.id, workspaceID));
      if (existing) {
        await recordStart(tx, workspaceID);
        startRecorded = true;
      }
    }
  });
  let prior = latest;
  let generation = latest?.generation ?? 1;
  let attemptID = runtimeIdentity(workspaceID, generation).attemptID;
  if (latest && options.sources && originalConfiguration.deployment === "fresh-workspaces") {
    const [predecessor] = await db
      .select({
        state: runtimeAttempt.state,
        actorUID: runtimeAttempt.actorUid,
        deleted: query<boolean>`${runtimeAttempt.deletedAt} IS NOT NULL`,
      })
      .from(runtimeAttempt)
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          eq(runtimeAttempt.workspaceId, workspaceID),
          eq(runtimeAttempt.generation, generation),
        ),
      );
    if (predecessor?.state === "stopped") {
      if (!predecessor.deleted || !predecessor.actorUID)
        throw new CommandError(
          "unavailable",
          "Original native cleanup is unconfirmed; no replacement was created",
        );
      await sql.begin((tx) => substrateWorkspaceGrantIn(database, tx, workspaceID, userID, true));
      await options.sources.requireIndependent(workspaceID, predecessor.actorUID, sql);
      if (
        await absentBoundNativeResource(options.editor, "GetActor", {
          actor: {
            atespace: substrateAtespaceName(attemptID),
            name: `runtime-${attemptID.replaceAll("-", "")}`,
          },
        })
      )
        throw new CommandError(
          "conflict",
          "Original native Actor is no longer absent; no replacement was created",
        );
      generation++;
      attemptID = runtimeIdentity(workspaceID, generation).attemptID;
      prior = undefined;
    }
  }
  const config = prior
    ? retainedSubstrateConfiguration(desiredConfiguration, prior.intent.configuration)
    : desiredConfiguration;
  const atespace = substrateAtespaceName(attemptID);
  if (!prior && !recordStart)
    await options.capacity?.requireReady(substrateResourceReservation(config));
  const [workspace] = await db
    .select({
      owner: developmentWorkspace.ownerUserId,
      changeID: developmentWorkspace.changeId,
      branch: developmentWorkspace.sourceBranch,
    })
    .from(developmentWorkspace)
    .where(eq(developmentWorkspace.id, workspaceID));
  if (workspace && (changeID ? workspace.changeID !== changeID : !workspace.owner))
    throw new CommandError("conflict", "Retained Workspace is never converted or adopted");
  if (prior && config.deployment === "fresh-workspaces") {
    const retained = await substrateBootstrapRetentionIn(sql, workspaceID, attemptID);
    const unsettled = await substrateUnsettledBootstrapIn(sql, workspaceID, attemptID);
    if (unsettled || (retained && ["failed", "pausing", "paused"].includes(retained.state)))
      throw new CommandError("conflict", substrateBootstrapContinuationBlocked);
  }
  if (prior) {
    const original = await options.loadSaved(workspaceID, generation, sql);
    if (original.atespace && original.policy && original.template) {
      return {
        phase: "reuse-confirmed",
        generation,
        attemptID,
        atespace,
        config,
        provision: original,
      };
    }
    return {
      phase: "resume-incomplete",
      generation,
      attemptID,
      atespace,
      config,
      prior: original,
      workspace,
      startRecorded,
    };
  }
  return {
    phase: "fresh-generation",
    generation,
    attemptID,
    atespace,
    config,
    workspace,
    startRecorded,
  };
}
