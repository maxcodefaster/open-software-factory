import { projectAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { requireSetupReady } from "../setup/execution-gate";

export async function substratePrebuildAuthorityIn(
  sql: AgentTurnTransaction,
  projectID: string,
  preparationID: string,
  attemptID: string,
) {
  await requireSetupReady(sql, projectID);
  const [scope] = await sql<
    {
      userID: string;
      revision: string;
      repository: string;
      devcontainerPath: string;
      environment: "development" | "main-preview";
      version: number;
      secretKey: string | null;
    }[]
  >`SELECT project.created_by AS "userID",preparation.revision,project.repository_url AS repository,
    project.devcontainer_path AS "devcontainerPath",preparation.environment,
    preparation.environment_version::float8 AS version,settings.secret_key AS "secretKey"
    FROM factory.project_image_preparation preparation JOIN factory.project project ON project.id=preparation.project_id
    LEFT JOIN factory.project_environment settings ON settings.project_id=project.id AND settings.environment=preparation.environment
    WHERE preparation.id=${preparationID} AND preparation.project_id=${projectID}
      AND preparation.state IN ('pending','running')
      AND (preparation.runtime_attempt_id IS NULL OR preparation.runtime_attempt_id=${attemptID})
      AND (EXISTS(SELECT 1 FROM factory.substrate_prebuild provision WHERE provision.preparation_id=preparation.id)
        OR preparation.environment_version=COALESCE(settings.version,0))
    FOR UPDATE OF preparation,project`;
  if (!scope) throw new CommandError("conflict", "Current native prebuild authority is required");
  await projectAuthorityIn(sql, scope.userID, projectID);
  return scope;
}

export async function substratePrebuildGrantIn(
  sql: AgentTurnTransaction,
  projectID: string,
  preparationID: string,
  attemptID: string,
  userID: string,
) {
  const scope = await substratePrebuildAuthorityIn(sql, projectID, preparationID, attemptID);
  const [grant] =
    await sql`SELECT provision.preparation_id FROM factory.substrate_prebuild provision
    LEFT JOIN factory.runtime_attempt attempt ON attempt.id=provision.runtime_attempt_id
    WHERE provision.preparation_id=${preparationID} AND provision.runtime_attempt_id=${attemptID}
      AND provision.intent#>>'{configuration,projectID}'=${projectID}
      AND provision.intent->>'revision'=${scope.revision} AND provision.intent->>'repository'=${scope.repository}
      AND provision.intent#>>'{environment,environment}'=${scope.environment}
      AND provision.intent#>>'{environment,version}'=${String(scope.version)}
      AND provision.atespace IS NOT NULL AND provision.policy IS NOT NULL AND provision.template IS NOT NULL
      AND NOT provision.atespace_rejected AND NOT provision.policy_rejected AND NOT provision.template_rejected
      AND (attempt.id IS NULL OR (attempt.substrate AND attempt.project_id=${projectID}
        AND attempt.isolated_kind='prebuild' AND attempt.workspace_id IS NULL AND attempt.change_id IS NULL
        AND attempt.revision=${scope.revision} AND attempt.created_by=${userID} AND attempt.stop_intended_at IS NULL
        AND attempt.state IN ('create-intended','starting','ready')))`;
  if (!grant || scope.userID !== userID)
    throw new CommandError("forbidden", "Confirmed native prebuild provisioning is required");
  return { projectID, changeID: null, revision: scope.revision };
}

export async function substratePrebuildPrincipalIn(sql: AgentTurnTransaction, attemptID: string) {
  const [attempt] = await sql<
    { userID: string }[]
  >`SELECT created_by AS "userID" FROM factory.runtime_attempt
    WHERE id=${attemptID} AND substrate AND isolated_kind='prebuild' AND workspace_id IS NULL
      AND state IN ('starting','ready') AND stop_intended_at IS NULL`;
  if (!attempt)
    throw new CommandError("forbidden", "Current native prebuild principal is unavailable");
  return attempt.userID;
}

export async function substratePrebuildSourceIn(sql: AgentTurnTransaction, attemptID: string) {
  const [scope] = await sql<
    { projectID: string; preparationID: string; userID: string; repository: string }[]
  >`
    SELECT attempt.project_id AS "projectID",provision.preparation_id AS "preparationID",attempt.created_by AS "userID",
      project.repository_url AS repository FROM factory.runtime_attempt attempt
    JOIN factory.project project ON project.id=attempt.project_id
    JOIN factory.substrate_prebuild provision ON provision.runtime_attempt_id=attempt.id AND provision.generation=attempt.generation
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    WHERE attempt.id=${attemptID} AND attempt.substrate AND attempt.isolated_kind='prebuild'
      AND attempt.workspace_id IS NULL AND attempt.state IN ('create-intended','starting')
      AND attempt.ready_at IS NULL AND attempt.stop_intended_at IS NULL
      AND provision.intent->>'repository'=project.repository_url AND provision.intent->>'revision'=attempt.revision
      AND binding.actor_uid IS NOT NULL AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL`;
  if (!scope)
    throw new CommandError("forbidden", "Current isolated native prebuild Source grant required");
  await substratePrebuildGrantIn(
    sql,
    scope.projectID,
    scope.preparationID,
    attemptID,
    scope.userID,
  );
  return scope.repository;
}
