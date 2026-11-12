import { projectAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";

export async function substrateVerificationAuthorityIn(
  sql: AgentTurnTransaction,
  projectID: string,
  verificationID: string,
  userID: string,
  attemptID?: string,
) {
  await projectAuthorityIn(sql, userID, projectID);
  const [scope] = await sql<
    {
      revision: string;
      repository: string;
      devcontainerPath: string;
      runnerUUID: string;
      runnerToken: string;
      jobHandle: string;
      attemptID: string | null;
    }[]
  >`SELECT verification.commit_sha AS revision,project.repository_url AS repository,
      project.devcontainer_path AS "devcontainerPath",verification.runner_uuid AS "runnerUUID",
      verification.runner_token AS "runnerToken",verification.runner_job_handle AS "jobHandle",
      verification.runtime_attempt_id AS "attemptID"
    FROM factory.verification verification JOIN factory.change change ON change.id=verification.change_id
    JOIN factory.ticket ticket ON ticket.id=change.ticket_id
    JOIN factory.project project ON project.id=change.project_id
    WHERE verification.id=${verificationID} AND change.project_id=${projectID}
      AND verification.created_by=${userID} AND verification.state IN ('pending','runner-starting','running')
      AND verification.action_run_id IS NOT NULL AND verification.runner_uuid IS NOT NULL
      AND verification.runner_token IS NOT NULL AND verification.runner_job_handle IS NOT NULL
      AND change.state='active' AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
      AND (verification.runtime_attempt_id IS NULL OR verification.runtime_attempt_id=${attemptID ?? null})
      AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session
        WHERE session.change_id=change.id AND (session.state='stopped' OR session.stop_pending))
    FOR UPDATE OF verification,change,ticket`;
  if (!scope)
    throw new CommandError("conflict", "Current exact native Verification authority is required");
  return scope;
}

export async function substrateVerificationGrantIn(
  sql: AgentTurnTransaction,
  projectID: string,
  verificationID: string,
  attemptID: string,
  userID: string,
) {
  const scope = await substrateVerificationAuthorityIn(
    sql,
    projectID,
    verificationID,
    userID,
    attemptID,
  );
  const [intent] =
    await sql`SELECT provision.verification_id FROM factory.substrate_verification provision
    LEFT JOIN factory.runtime_attempt attempt ON attempt.id=${attemptID}
    WHERE provision.verification_id=${verificationID} AND provision.runtime_attempt_id=${attemptID}
      AND provision.intent#>>'{configuration,projectID}'=${projectID}
      AND provision.intent->>'revision'=${scope.revision}
      AND provision.intent->>'jobHandle'=${scope.jobHandle}
      AND provision.atespace IS NOT NULL AND provision.policy IS NOT NULL AND provision.template IS NOT NULL
      AND NOT provision.atespace_rejected AND NOT provision.policy_rejected AND NOT provision.template_rejected
      AND (attempt.id IS NULL OR (attempt.substrate AND attempt.project_id=${projectID}
        AND attempt.verification_id=${verificationID} AND attempt.workspace_id IS NULL
        AND attempt.isolated_kind='verification' AND attempt.revision=${scope.revision}
        AND attempt.created_by=${userID} AND attempt.stop_intended_at IS NULL
        AND attempt.state IN ('create-intended','starting','ready','paused','resuming')))`;
  if (!intent)
    throw new CommandError("forbidden", "Confirmed native Verification provisioning is required");
  return { projectID, changeID: null, revision: scope.revision };
}

export async function substrateVerificationPrincipalIn(
  sql: AgentTurnTransaction,
  attemptID: string,
) {
  const [attempt] = await sql<{ userID: string }[]>`SELECT created_by AS "userID"
    FROM factory.runtime_attempt WHERE id=${attemptID} AND substrate AND isolated_kind='verification'
      AND workspace_id IS NULL AND state IN ('starting','ready') AND stop_intended_at IS NULL`;
  if (!attempt)
    throw new CommandError("forbidden", "Current native Verification principal is unavailable");
  return attempt.userID;
}

// The isolated bootstrap has no personal Workspace or canonical Source grant.
// Resolve its repository only through the same exact-job authority that admitted
// this immutable Verification generation; reading never commissions execution.
export async function substrateVerificationSourceIn(sql: AgentTurnTransaction, attemptID: string) {
  const [scope] = await sql<
    { projectID: string; verificationID: string; userID: string; repository: string }[]
  >`SELECT a.project_id AS "projectID",a.verification_id AS "verificationID",a.created_by AS "userID",project.repository_url AS repository
    FROM factory.runtime_attempt a JOIN factory.project project ON project.id=a.project_id
    JOIN factory.substrate_verification provision ON provision.runtime_attempt_id=a.id
      AND provision.verification_id=a.verification_id AND provision.generation=a.generation
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=a.id
    WHERE a.id=${attemptID} AND a.substrate AND a.isolated_kind='verification' AND a.workspace_id IS NULL
      AND a.state IN ('create-intended','starting') AND a.ready_at IS NULL AND a.stop_intended_at IS NULL
      AND provision.intent->>'repository'=project.repository_url
      AND provision.intent->>'revision'=a.revision
      AND binding.actor_uid IS NOT NULL AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL`;
  if (!scope)
    throw new CommandError(
      "forbidden",
      "Current isolated native Verification Source grant required",
    );
  await substrateVerificationGrantIn(
    sql,
    scope.projectID,
    scope.verificationID,
    attemptID,
    scope.userID,
  );
  return scope.repository;
}
