import { stripVTControlCharacters } from "node:util";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import type { createDatabase, DatabaseTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentSession,
  change as changeModel,
  operation as operationTable,
  projectRelease,
  runtimeAttempt,
  verification as verificationModel,
} from "#db/schema";
import { personalWorkspaceIdentity } from "#workspace-domain/workspace";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import {
  createChangeAgentStop,
  type PendingWriterHandoff,
  requirePendingWriterHandoffIn,
  requireStoppedAgentInputsIn,
} from "../agent/runtime-api";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import type { RuntimeHub } from "./hub";
import type { RuntimeAttemptView } from "./types";

type Database = ReturnType<typeof createDatabase>;

export type IsolatedRuntimeKind = "staging" | "verification" | "publication" | null;

export function selectRuntimeOwner<I, V, W>(
  owners: { isolated: I; verification: V; workspaces: W },
  isolatedKind: IsolatedRuntimeKind,
): I | V | W {
  switch (isolatedKind) {
    case "staging":
    case "publication":
      return owners.isolated;
    case "verification":
      return owners.verification;
    case null:
      return owners.workspaces;
  }
}

export function createStopReconciler(
  database: Database,
  recoverAttempt: (attemptID: string) => Promise<unknown>,
) {
  let continuingStops: Promise<void> | undefined;
  return function reconcileStops() {
    if (continuingStops) return continuingStops;
    const work = (async () => {
      const stops = await database.db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .where(and(isNotNull(runtimeAttempt.stopIntendedAt), eq(runtimeAttempt.state, "stopping")))
        .orderBy(runtimeAttempt.updatedAt, runtimeAttempt.id)
        .limit(16);
      for (const stop of stops) {
        try {
          await recoverAttempt(stop.id);
        } catch (cause) {
          reportFailure("Recorded native Stop cleanup is unavailable")(cause);
        }
      }
    })();
    continuingStops = work;
    void work
      .finally(() => {
        if (continuingStops === work) continuingStops = undefined;
      })
      .catch(() => {});
    return work;
  };
}

export async function authorizePersonalWorkspaceStart(
  database: Database,
  projectID: string,
  userID: string,
  selectedWorkspaceID?: string,
) {
  await createAccessController(database).requireDevelopment(userID, projectID);
  if (!selectedWorkspaceID) return;
  const selected = await database.client.begin((sql) =>
    workspaceWriteAuthorityIn(sql, selectedWorkspaceID, userID),
  );
  if (selected.kind !== "personal" || selected.projectID !== projectID || !selected.ownerID)
    throw new CommandError("not-found", "Personal Workspace not found");
  if (selectedWorkspaceID !== personalWorkspaceIdentity(projectID, selected.ownerID).workspaceID)
    throw new CommandError(
      "conflict",
      "Personal Workspace identity differs from its retained owner",
    );
}

export async function resolveChangeProject(database: Database, changeID: string) {
  const [change] = await database.db
    .select({ projectID: changeModel.projectId })
    .from(changeModel)
    .where(eq(changeModel.id, changeID));
  if (!change) throw new CommandError("not-found", "Change not found");
  return change.projectID;
}

export async function resolveVerificationProject(
  database: Database,
  verificationID: string,
  userID: string,
) {
  const [verification] = await database.db
    .select({ projectID: changeModel.projectId })
    .from(verificationModel)
    .innerJoin(changeModel, eq(changeModel.id, verificationModel.changeId))
    .where(eq(verificationModel.id, verificationID));
  if (!verification) return null;
  await database.client.begin((sql) => projectAuthorityIn(sql, userID, verification.projectID));
  return verification.projectID;
}

export async function resolvePublicationProject(database: Database, publicationID: string) {
  const [publication] = await database.db
    .select({ projectID: projectRelease.projectId })
    .from(operationTable)
    .innerJoin(
      projectRelease,
      eq(query<string>`${projectRelease.id}::text`, operationTable.scopeId),
    )
    .where(
      and(
        eq(operationTable.id, publicationID),
        eq(operationTable.kind, "releases.attempt"),
        eq(operationTable.scopeType, "project_release"),
      ),
    );
  if (!publication) throw new CommandError("not-found", "Publication not found");
  return publication.projectID;
}

export async function resolvePromotionProject(database: Database, promotionID: string) {
  const [promotion] = await database.db
    .select({ projectID: query<string>`${operationTable.payload}->>'projectId'` })
    .from(operationTable)
    .where(and(eq(operationTable.id, promotionID), eq(operationTable.kind, "delivery.promotion")));
  if (!promotion) throw new CommandError("not-found", "Promotion not found");
  return promotion.projectID;
}

export async function pauseRuntimeAttempt(
  database: Database,
  suspend: () => Promise<unknown>,
  attemptID: string,
) {
  try {
    await suspend();
  } catch (cause) {
    const detail = stripVTControlCharacters(
      cause instanceof Error ? cause.message : "Native Pause is unconfirmed",
    )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Native errors must be persistable PostgreSQL text.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2_000);
    const message = detail || "Native Pause is unconfirmed";
    await database.db
      .update(runtimeAttempt)
      .set({
        failure: query`coalesce(${runtimeAttempt.failure}, ${message})`,
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          eq(runtimeAttempt.state, "pausing"),
          isNull(runtimeAttempt.stopIntendedAt),
        ),
      );
    throw cause;
  }
}

export async function stopRuntimeAttempt(
  database: Database,
  hub: RuntimeHub,
  deps: {
    clearReconnect: (attemptID: string) => void;
    get: (attemptID: string) => Promise<RuntimeAttemptView | null>;
    stopNative: (attemptID: string, handoff?: PendingWriterHandoff) => Promise<unknown>;
    stopCoding?:
      | ((changeID: string, handoff?: PendingWriterHandoff) => Promise<unknown>)
      | undefined;
  },
  attemptID: string,
  handoff?: PendingWriterHandoff,
) {
  deps.clearReconnect(attemptID);
  if (handoff) await requirePendingWriterHandoffIn(database.client, attemptID, handoff);
  const [coding] = await database.db
    .select({ changeID: changeModel.id })
    .from(runtimeAttempt)
    .innerJoin(
      changeModel,
      and(
        eq(changeModel.id, runtimeAttempt.changeId),
        eq(changeModel.runtimeAttemptId, runtimeAttempt.id),
      ),
    )
    .leftJoin(
      changeAgentSession,
      and(
        eq(changeAgentSession.changeId, changeModel.id),
        eq(changeAgentSession.runtimeAttemptId, runtimeAttempt.id),
      ),
    )
    .where(
      and(
        eq(runtimeAttempt.id, attemptID),
        or(
          eq(changeAgentSession.stopPending, true),
          notInArray(changeAgentSession.state, ["committed", "stopped"]),
          exists(
            database.db
              .select({ id: agentTurn.id })
              .from(agentTurn)
              .where(
                and(
                  eq(agentTurn.changeId, changeModel.id),
                  inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
                  // The validated handoff is unbound, not input of the original Actor.
                  query`${agentTurn.id} IS DISTINCT FROM ${handoff?.turnID ?? null}::uuid`,
                ),
              ),
          ),
        ),
      ),
    );
  const codingStop = coding
    ? createChangeAgentStop(database, hub, undefined, (id) => deps.get(id))
    : undefined;
  if (coding && codingStop) {
    if (deps.stopCoding) await deps.stopCoding(coding.changeID, handoff);
    else {
      await codingStop.persist(coding.changeID, handoff);
      await codingStop.confirm(coding.changeID);
    }
  }
  // Do not hold the native Workspace lock while taking Turn locks or
  // waiting for ordered engine HTTP. The adapter checks this barrier again
  // under its own lifecycle lock before snapshot or deletion.
  await requireStoppedAgentInputsIn(database.client, attemptID, handoff);
  await deps.stopNative(attemptID, handoff);
  if (coding && codingStop && !(await codingStop.confirm(coding.changeID)))
    throw new CommandError("unavailable", "Compute stopped but Coding Stop is not confirmed");
}

export async function createProjectRecoveryTrigger(
  database: Database,
  recoverProject: (projectID: string) => void,
) {
  const ids = await database.db
    .selectDistinct({ projectID: runtimeAttempt.projectId })
    .from(runtimeAttempt);
  let observing = false;
  return () => {
    if (observing) return;
    observing = true;
    for (const id of ids) recoverProject(id.projectID);
  };
}

export type PersonalStartRecorder = (
  sql: DatabaseTransaction,
  workspaceID: string,
) => Promise<void>;
