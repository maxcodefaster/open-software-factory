import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "#db/client";
import { nativeActor, nativeRuntime } from "#runtime-kubernetes/substrate-control";

const clock = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const rowSchema = z.object({
  attemptID: z.uuid(),
  projectID: z.uuid(),
  workspaceID: z.uuid(),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  state: z.literal("ready"),
  intendedAt: clock,
  attemptedAt: clock,
  actorUID: z.uuid(),
  atespace: z.string(),
  actorName: z.string(),
  intentProjectID: z.uuid(),
  intentWorkspaceID: z.uuid(),
  intentGeneration: z.string(),
  selector: z.record(z.string(), z.string()),
  runtime: nativeRuntime,
  observation: nativeActor,
  stopping: z.literal(false),
  rejected: z.literal(false),
});
type Selection = { attemptID: string; projectID: string; workspaceID: string; actorUID: string };

// Saved, compact original-binding evidence only. This never dispatches a
// command, wakes compute, inspects a worker or establishes current liveness.
export function nativeWorkspaceObservation(value: unknown, selected: Selection) {
  const row = rowSchema.parse(value);
  const actor = row.observation;
  const suffix = selected.attemptID.replaceAll("-", "");
  if (
    row.attemptID !== selected.attemptID ||
    row.projectID !== selected.projectID ||
    row.workspaceID !== selected.workspaceID ||
    row.actorUID !== selected.actorUID ||
    row.intentProjectID !== row.projectID ||
    row.intentWorkspaceID !== row.workspaceID ||
    row.intentGeneration !== row.generation ||
    row.atespace !== `fa-${suffix}` ||
    row.actorName !== `runtime-${suffix}` ||
    actor.metadata.uid !== row.actorUID ||
    actor.metadata.atespace !== row.atespace ||
    actor.metadata.name !== row.actorName ||
    actor.actorTemplate.atespace !== row.atespace ||
    actor.actorTemplate.name !== "runtime" ||
    actor.sourceTag ||
    actor.status.state !== "ACTOR_STATE_RUNNING" ||
    !isDeepStrictEqual(actor.workerSelector?.matchLabels, row.selector) ||
    !isDeepStrictEqual(actor.status.workerAssignment?.sandboxRuntime, row.runtime) ||
    Date.parse(row.attemptedAt) < Date.parse(row.intendedAt) ||
    Date.parse(actor.metadata.createTime) < Date.parse(row.attemptedAt)
  )
    throw Error("Native Workspace observation differs from its original saved binding");
  return {
    scope: "recorded-native-binding" as const,
    attemptID: row.attemptID,
    projectID: row.projectID,
    workspaceID: row.workspaceID,
    generation: row.generation,
    actorUID: row.actorUID,
    atespace: row.atespace,
    actorName: row.actorName,
    actorVersion: actor.metadata.version,
    factoryCreateIntendedAt: new Date(row.intendedAt).toISOString(),
    actorCreateAttemptedAt: new Date(row.attemptedAt).toISOString(),
    actorObservedCreatedAt: actor.metadata.createTime,
    coldRestart: true,
    currentLivenessProven: false,
  };
}

export async function readNativeWorkspaceObservation(
  database: ReturnType<typeof createDatabase>,
  selected: Selection,
) {
  const [row] = await database.client`
    SELECT attempt.id AS "attemptID",attempt.project_id AS "projectID",
      attempt.workspace_id AS "workspaceID",attempt.generation::text AS generation,
      attempt.state,
      attempt.create_intended_at::text AS "intendedAt",attempt.create_attempted_at::text AS "attemptedAt",
      attempt.actor_uid AS "actorUID",attempt.atespace,attempt.actor_name AS "actorName",
      attempt.binding_intent->>'projectID' AS "intentProjectID",
      attempt.binding_intent->>'workspaceID' AS "intentWorkspaceID",
      attempt.binding_intent->>'generation' AS "intentGeneration",
      attempt.binding_intent->'actorSelector' AS selector,attempt.binding_intent->'runtime' AS runtime,
      attempt.observation,
      (attempt.stop_intended_at IS NOT NULL OR attempt.delete_intended_at IS NOT NULL OR attempt.deleted_at IS NOT NULL) AS stopping,
      attempt.create_rejected AS rejected
    FROM factory.runtime_attempt attempt
    JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      AND workspace.project_id=attempt.project_id
    WHERE attempt.id=${z.uuid().parse(selected.attemptID)} AND attempt.atespace IS NOT NULL`;
  if (!row) throw Error("Native Workspace has no saved original binding");
  return nativeWorkspaceObservation(row, selected);
}
