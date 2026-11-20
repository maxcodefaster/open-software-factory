import { z } from "zod";
import type { DatabaseTransaction, createDatabase } from "../../../../packages/db/src/client";

type SQL = ReturnType<typeof createDatabase>["client"] | DatabaseTransaction;
export const nativeInputStopAssignment = z.strictObject({
  stopID: z.uuid(),
  attemptID: z.uuid(),
  sessionID: z
    .string()
    .regex(/^ses_[a-zA-Z0-9_-]+$/)
    .max(256),
  promptID: z
    .string()
    .regex(/^msg_[a-zA-Z0-9_-]+$/)
    .max(256),
  modelID: z.string().min(1).max(200),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .max(64),
  mode: z.enum(["interrupt", "observe"]),
});
export const nativeInputStopResult = nativeInputStopAssignment.extend({
  confirmed: z.boolean(),
  engineExited: z.literal(true),
  processTreeExited: z.literal(true),
});
export type NativeInputStop = {
  stopID: string;
  changeID: string;
  workspaceID: string;
  actorUID: string;
  assignment: z.infer<typeof nativeInputStopAssignment>;
  checkpoint: { uuid: string; generation: number };
  sourceCheckpointID: string | null;
  sourceWriterEpoch: number | null;
  resumed: boolean;
  snapshotAttempted: boolean;
  result: z.infer<typeof nativeInputStopResult> | null;
  completed: boolean;
};

// Cleanup authority is the exact already-published Stop, not permission to
// commission inference or reuse its creator's personal configuration.
export async function nativeInputStopIn(sql: SQL, attemptID: string, stopID?: string) {
  const [row] = await sql<NativeInputStop[]>`
    SELECT operation.stop_id AS "stopID",operation.change_id AS "changeID",operation.workspace_id AS "workspaceID",
      operation.actor_uid::text AS "actorUID",operation.assignment,operation.checkpoint,
      operation.source_checkpoint_id::text AS "sourceCheckpointID",
      operation.source_writer_epoch::float8 AS "sourceWriterEpoch",
      operation.resume_attempted_at IS NOT NULL AS resumed,operation.result,
      operation.snapshot_attempted_at IS NOT NULL AS "snapshotAttempted",
      operation.completed_at IS NOT NULL AS completed
    FROM factory.substrate_input_stop operation
    JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    JOIN factory.change change ON change.id=operation.change_id AND change.runtime_attempt_id=attempt.id
    JOIN factory.change_agent_session session ON session.change_id=change.id
    JOIN factory.change_agent_turn_intent intent ON intent.turn_id=session.stop_turn_id
    JOIN factory.agent_turn turn ON turn.id=intent.turn_id
    WHERE attempt.id=${attemptID}
      AND (${stopID ?? null}::uuid IS NULL OR operation.stop_id=${stopID ?? null})
      AND attempt.workspace_id=operation.workspace_id AND attempt.change_id=change.id
      AND attempt.stop_intended_at IS NULL AND binding.actor_uid=operation.actor_uid
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL AND NOT binding.create_rejected
      AND session.state='stopped' AND session.stop_pending AND session.stop_id=operation.stop_id
      AND session.runtime_attempt_id=attempt.id AND session.opencode_session_id=operation.assignment->>'sessionID'
      AND intent.runtime_attempt_id=attempt.id AND intent.session_id=session.opencode_session_id
      AND intent.prompt_id=operation.assignment->>'promptID'
      AND turn.authority->>'modelId'=operation.assignment->>'modelID'
      AND turn.state IN ('stopped','completed','failed')
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=attempt.workspace_id AND newer.generation>attempt.generation)`;
  if (!row) return null;
  row.assignment = nativeInputStopAssignment.parse(row.assignment);
  if (row.result) row.result = nativeInputStopResult.parse(row.result);
  return row;
}

export function matchesNativeInputStop(
  assignment: z.infer<typeof nativeInputStopAssignment>,
  result: z.infer<typeof nativeInputStopResult>,
) {
  return (
    assignment.stopID === result.stopID &&
    assignment.attemptID === result.attemptID &&
    assignment.sessionID === result.sessionID &&
    assignment.promptID === result.promptID &&
    assignment.modelID === result.modelID &&
    assignment.version === result.version
  );
}
