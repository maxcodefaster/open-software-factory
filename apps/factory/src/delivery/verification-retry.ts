import { verificationDiagnosisInput } from "../../../../packages/conversation-domain/src/verification";
import type { createDatabase } from "../../../../packages/db/src/client";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

// Retry only a queued workflow whose environment failed before accepting work.
// Forgejo still owns the original run; this does not retry executed checks.
export async function retryVerificationBootstrap(
  database: ReturnType<typeof createDatabase>,
  changeID: string,
  userID: string,
  commandID: string,
  verificationID: string,
  runtimeAttemptID: string,
) {
  return database.client.begin(async (sql) => {
    const writer = await lockChangeWriterIn(sql, changeID);
    await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
    const scope = `checks-bootstrap-retry:${changeID}`;
    const input = { changeID, verificationID, runtimeAttemptID };
    const [replay] = await sql<
      { scope: string; actor: string; input: typeof input }[]
    >`SELECT scope,actor_id AS actor,input FROM factory.execution_policy_command
      WHERE command_id=${commandID}`;
    if (replay) {
      if (
        replay.scope !== scope ||
        replay.actor !== userID ||
        replay.input.changeID !== changeID ||
        replay.input.verificationID !== verificationID ||
        replay.input.runtimeAttemptID !== runtimeAttemptID
      )
        throw new CommandError("conflict", "Checks retry changed target");
      return false;
    }
    const [candidate] = await sql<
      {
        diagnosis: unknown;
        summary: string | null;
        actionRunID: string;
        completedAt: Date;
      }[]
    >`SELECT verification.diagnosis,verification.summary,
        verification.action_run_id AS "actionRunID",verification.completed_at AS "completedAt"
      FROM factory.verification verification
      JOIN factory.change change ON change.id=verification.change_id
      JOIN factory.change_agent_session session ON session.change_id=change.id
      JOIN LATERAL (
        SELECT id,commit_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1
      ) commit ON commit.id=session.active_turn_id AND commit.commit_sha=verification.commit_sha
      JOIN factory.agent_turn turn ON turn.id=session.active_turn_id AND turn.state='completed'
      JOIN factory.runtime_attempt attempt ON attempt.id=verification.runtime_attempt_id
        AND attempt.verification_id=verification.id AND attempt.state='stopped'
      WHERE verification.id=${verificationID} AND change.id=${changeID}
        AND change.state='active' AND session.state='committed' AND NOT session.stop_pending
        AND verification.state='failed' AND verification.runtime_attempt_id=${runtimeAttemptID}
        AND verification.runner_id IS NULL AND verification.action_run_id IS NOT NULL
        AND verification.repair_prompted_at IS NULL AND verification.completed_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM factory.factorybox_runtime native
          WHERE native.runtime_attempt_id=attempt.id AND native.inputs_released_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id
          AND state IN ('pending','dispatching','running','uncertain'))
        AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=change.id
          AND state NOT IN ('succeeded','failed'))
        AND NOT EXISTS(SELECT 1 FROM factory.review_feedback WHERE change_id=change.id
          AND kind='thread' AND state<>'resolved')
      FOR UPDATE OF verification`;
    const diagnosis = verificationDiagnosisInput.safeParse(candidate?.diagnosis);
    if (
      !writer.available ||
      !["agent", "unassigned"].includes(writer.state) ||
      !candidate ||
      !diagnosis.success ||
      diagnosis.data.kind !== "execution-failed" ||
      diagnosis.data.runtimeAttemptId !== runtimeAttemptID ||
      diagnosis.data.jobs.length !== 0
    )
      throw new CommandError(
        "conflict",
        "Retry checks only after the failed queued environment is cleaned up and the current implementation is submitted",
      );
    // Keep the failed outcome and its exact Runtime identity with the explicit
    // decision before releasing the Verification's pending bootstrap reference.
    await sql`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
      VALUES(${commandID},${scope},${userID},${JSON.stringify(input)}::jsonb,
        ${JSON.stringify({
          verificationID,
          runtimeAttemptID,
          actionRunID: candidate.actionRunID,
          state: "failed",
          summary: candidate.summary,
          diagnosis: diagnosis.data,
          completedAt: candidate.completedAt,
        })}::jsonb)`;
    await sql`UPDATE factory.verification SET state='pending',runtime_attempt_id=NULL,
      runner_uuid=NULL,runner_token=NULL,summary=NULL,diagnosis=NULL,completed_at=NULL,updated_at=now()
      WHERE id=${verificationID}`;
    return true;
  });
}
