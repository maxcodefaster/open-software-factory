import type { DatabaseTransaction } from "../../../../packages/db/src/client";
import { runtimeIdentity } from "../../../../packages/runtime-domain/src/identity";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

export type SubstrateIsolatedOwner = {
  isolatedKind: "staging" | "publication";
  isolatedID: string;
  promotionID: string | null;
};
export type SubstrateIsolatedScope = {
  revision: string;
  repository: string;
  devcontainerPath: string;
  runnerUUID: string | null;
  runnerToken: string | null;
  jobHandle: string | null;
  version: string | null;
};

export function substrateStagingOwner(projectID: string) {
  return runtimeIdentity(`staging:${projectID}`, 1).attemptID;
}

// The existing Preview, human-approved promotion and bound publication job own
// authority. Native provisioning records do not create another product decision.
export async function substrateIsolatedAuthorityIn(
  sql: DatabaseTransaction,
  projectID: string,
  owner: SubstrateIsolatedOwner,
  userID: string,
  attemptID: string,
): Promise<SubstrateIsolatedScope> {
  if (owner.isolatedKind === "publication") {
    if (owner.promotionID) throw new CommandError("conflict", "Publication owner is invalid");
    await projectDevelopmentAuthorityIn(sql, userID, projectID);
    const [scope] = await sql<SubstrateIsolatedScope[]>`
      SELECT release.commit_sha AS revision,project.repository_url AS repository,
        project.devcontainer_path AS "devcontainerPath",publication.runner_uuid AS "runnerUUID",
        publication.runner_token AS "runnerToken",publication.job_handle AS "jobHandle",release.version
      FROM factory.release_attempt publication JOIN factory.project_release release ON release.id=publication.release_id
      JOIN factory.project project ON project.id=release.project_id
      WHERE publication.id=${owner.isolatedID} AND release.project_id=${projectID}
        AND release.created_by=${userID} AND release.state='running' AND publication.state='running'
        AND publication.dispatch_intended_at IS NOT NULL AND publication.run_id IS NOT NULL
        AND publication.runner_uuid IS NOT NULL AND publication.runner_token IS NOT NULL AND publication.job_handle IS NOT NULL
        AND publication.id=(SELECT id FROM factory.release_attempt WHERE release_id=release.id ORDER BY ordinal DESC LIMIT 1)
        AND (publication.runtime_attempt_id IS NULL OR publication.runtime_attempt_id=${attemptID})
      FOR UPDATE OF publication,release`;
    if (!scope)
      throw new CommandError("conflict", "Current exact native publication job is required");
    return scope;
  }
  await projectAuthorityIn(sql, userID, projectID);
  if (owner.promotionID) {
    if (owner.isolatedID !== owner.promotionID)
      throw new CommandError("conflict", "Promotion execution identity is invalid");
    const [scope] = await sql<SubstrateIsolatedScope[]>`
      SELECT promotion.commit_sha AS revision,project.repository_url AS repository,
        project.devcontainer_path AS "devcontainerPath",NULL::text AS "runnerUUID",
        NULL::text AS "runnerToken",NULL::text AS "jobHandle",NULL::text AS version
      FROM factory.promotion_operation promotion JOIN factory.change change ON change.id=promotion.change_id
      JOIN factory.ticket ticket ON ticket.id=change.ticket_id JOIN factory.project project ON project.id=promotion.project_id
      JOIN factory.merge_operation merge ON merge.change_id=change.id AND merge.commit_sha=promotion.commit_sha
        AND merge.state='succeeded' AND merge.observed_default_sha=merge.commit_sha
      JOIN factory.delivery_approval approval ON approval.id=merge.delivery_approval_id
        AND approval.change_id=change.id AND approval.commit_sha=merge.commit_sha
      JOIN factory.verification verification ON verification.id=approval.verification_id
        AND verification.change_id=change.id AND verification.commit_sha=merge.commit_sha AND verification.state='succeeded'
      JOIN factory.candidate_review review ON review.id=approval.candidate_review_id AND review.verification_id=verification.id
        AND review.change_id=change.id AND review.commit_sha=merge.commit_sha AND review.state='passed'
      LEFT JOIN factory.staging_preview preview ON preview.project_id=promotion.project_id
      WHERE promotion.id=${owner.promotionID} AND promotion.project_id=${projectID} AND change.project_id=${projectID}
        AND ticket.trashed_at IS NULL AND EXISTS(SELECT 1 FROM factory.current_promotion WHERE id=promotion.id)
        AND ((promotion.state IN ('pending','starting','switching') AND change.state='delivering' AND change.cancel_requested_at IS NULL)
          OR (promotion.state='succeeded' AND change.state='delivered' AND preview.runtime_attempt_id=${attemptID}
            AND preview.revision=promotion.commit_sha))
        AND (promotion.replacement_runtime_attempt_id IS NULL OR promotion.replacement_runtime_attempt_id=${attemptID})
      FOR UPDATE OF promotion,change,ticket`;
    if (!scope)
      throw new CommandError(
        "conflict",
        "Current approved exact-commit native promotion is required",
      );
    return scope;
  }
  if (owner.isolatedID !== substrateStagingOwner(projectID))
    throw new CommandError("conflict", "Initial Staging execution identity is invalid");
  const [scope] = await sql<SubstrateIsolatedScope[]>`
    SELECT preview.revision,project.repository_url AS repository,project.devcontainer_path AS "devcontainerPath",
      NULL::text AS "runnerUUID",NULL::text AS "runnerToken",NULL::text AS "jobHandle",NULL::text AS version
    FROM factory.staging_preview preview JOIN factory.project project ON project.id=preview.project_id
    WHERE preview.project_id=${projectID} AND (preview.runtime_attempt_id IS NULL OR preview.runtime_attempt_id=${attemptID}
      OR EXISTS(SELECT 1 FROM factory.runtime_attempt predecessor JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=predecessor.id
        WHERE predecessor.id=preview.runtime_attempt_id
          AND predecessor.state='stopped' AND binding.deleted_at IS NOT NULL))
    FOR UPDATE OF preview`;
  if (!scope)
    throw new CommandError("conflict", "Current native Staging Preview intent is required");
  return scope;
}

export async function substrateIsolatedGrantIn(
  sql: DatabaseTransaction,
  projectID: string,
  owner: SubstrateIsolatedOwner,
  attemptID: string,
  userID: string,
) {
  const scope = await substrateIsolatedAuthorityIn(sql, projectID, owner, userID, attemptID);
  const [confirmed] = await sql`
    SELECT provision.runtime_attempt_id FROM factory.substrate_isolated provision
    LEFT JOIN factory.runtime_attempt attempt ON attempt.id=${attemptID}
    WHERE provision.runtime_attempt_id=${attemptID} AND provision.project_id=${projectID}
      AND provision.owner_id=${owner.isolatedID} AND provision.kind=${owner.isolatedKind}
      AND provision.intent->>'createdBy'=${userID}
      AND (provision.intent->>'promotionID') IS NOT DISTINCT FROM ${owner.promotionID}
      AND provision.intent->>'revision'=${scope.revision} AND provision.intent->>'repository'=${scope.repository}
      AND (provision.intent->>'jobHandle') IS NOT DISTINCT FROM ${scope.jobHandle}
      AND provision.atespace IS NOT NULL AND provision.policy IS NOT NULL AND provision.template IS NOT NULL
      AND NOT provision.atespace_rejected AND NOT provision.policy_rejected AND NOT provision.template_rejected
      AND (attempt.id IS NULL OR (attempt.project_id=${projectID}
        AND attempt.isolated_kind::text=${owner.isolatedKind} AND attempt.workspace_id IS NULL AND attempt.change_id IS NULL
        AND attempt.verification_id IS NULL AND attempt.generation=provision.generation
        AND attempt.revision=${scope.revision} AND attempt.created_by=${userID} AND attempt.stop_intended_at IS NULL
        AND attempt.state IN ('create-intended','starting','ready','paused','resuming')))`;
  if (!confirmed)
    throw new CommandError("forbidden", "Confirmed native isolated provisioning is required");
  return { projectID, changeID: null, revision: scope.revision };
}

export async function substrateIsolatedPrincipalIn(sql: DatabaseTransaction, attemptID: string) {
  const [attempt] = await sql<{ userID: string }[]>`
    SELECT created_by AS "userID" FROM factory.runtime_attempt WHERE id=${attemptID}
      AND isolated_kind IN ('staging','publication') AND workspace_id IS NULL AND change_id IS NULL
      AND state IN ('starting','ready') AND stop_intended_at IS NULL`;
  if (!attempt)
    throw new CommandError(
      "forbidden",
      "Current native isolated execution principal is unavailable",
    );
  return attempt.userID;
}

export async function substrateIsolatedSourceIn(sql: DatabaseTransaction, attemptID: string) {
  const [scope] = await sql<
    {
      projectID: string;
      isolatedID: string;
      isolatedKind: "staging" | "publication";
      promotionID: string | null;
      userID: string;
      repository: string;
    }[]
  >`
    SELECT attempt.project_id AS "projectID",provision.owner_id AS "isolatedID",provision.kind AS "isolatedKind",
      provision.intent->>'promotionID' AS "promotionID",attempt.created_by AS "userID",project.repository_url AS repository
    FROM factory.runtime_attempt attempt JOIN factory.project project ON project.id=attempt.project_id
    JOIN factory.substrate_isolated provision ON provision.runtime_attempt_id=attempt.id
      AND provision.project_id=attempt.project_id AND provision.generation=attempt.generation
      AND provision.kind=attempt.isolated_kind::text
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    WHERE attempt.id=${attemptID} AND attempt.workspace_id IS NULL AND attempt.change_id IS NULL
      AND attempt.isolated_kind IN ('staging','publication') AND attempt.state IN ('create-intended','starting')
      AND attempt.ready_at IS NULL AND attempt.stop_intended_at IS NULL
      AND provision.intent->>'repository'=project.repository_url AND provision.intent->>'revision'=attempt.revision
      AND binding.actor_uid IS NOT NULL AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL`;
  if (!scope)
    throw new CommandError("forbidden", "Current native isolated Source grant is required");
  await substrateIsolatedGrantIn(sql, scope.projectID, scope, attemptID, scope.userID);
  return scope.repository;
}
