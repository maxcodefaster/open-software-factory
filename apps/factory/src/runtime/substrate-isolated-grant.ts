import { and, eq, inArray, isNull } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { runtimeAttempt } from "#db/schema";
import { runtimeIdentity } from "#runtime-domain/identity";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";

export type SubstrateIsolatedOwner = {
  isolatedKind: "staging" | "publication";
  isolatedID: string;
  promotionID: string | null;
};
export type SubstrateIsolatedScope = {
  revision: string;
  repository: string;
  actorTemplatePath: string;
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
        project.actor_template_path AS "actorTemplatePath",publication.payload->>'runnerUuid' AS "runnerUUID",
        publication.payload->>'runnerToken' AS "runnerToken",publication.payload->>'jobHandle' AS "jobHandle",release.version
      FROM factory.operation publication JOIN factory.project_release release ON release.id::text=publication.scope_id
      JOIN factory.project project ON project.id=release.project_id
      WHERE publication.id=${owner.isolatedID} AND publication.kind='releases.attempt' AND publication.scope_type='project_release'
        AND release.project_id=${projectID}
        AND release.created_by=${userID} AND release.state='running' AND publication.state='running'
        AND (publication.payload->>'dispatchIntendedAt') IS NOT NULL AND (publication.payload->>'runId') IS NOT NULL
        AND (publication.payload->>'runnerUuid') IS NOT NULL AND (publication.payload->>'runnerToken') IS NOT NULL
        AND (publication.payload->>'jobHandle') IS NOT NULL
        AND publication.id=(SELECT id FROM factory.operation WHERE kind='releases.attempt' AND scope_type='project_release' AND scope_id=release.id::text ORDER BY (payload->>'ordinal')::int DESC LIMIT 1)
        AND ((publication.payload->>'runtimeAttemptId') IS NULL OR publication.payload->>'runtimeAttemptId'=${attemptID})
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
      SELECT promotion.payload->>'commitSha' AS revision,project.repository_url AS repository,
        project.actor_template_path AS "actorTemplatePath",NULL::text AS "runnerUUID",
        NULL::text AS "runnerToken",NULL::text AS "jobHandle",NULL::text AS version
      FROM factory.operation promotion JOIN factory.change change ON change.id::text=promotion.scope_id
      JOIN factory.ticket ticket ON ticket.id=change.ticket_id JOIN factory.project project ON project.id::text=promotion.payload->>'projectId'
      JOIN factory.operation merge ON merge.kind='delivery.merge' AND merge.scope_type='change' AND merge.scope_id=change.id::text
        AND merge.payload->>'commitSha'=promotion.payload->>'commitSha'
        AND merge.state='succeeded' AND merge.result->>'mergeSha'=merge.payload->>'commitSha'
      JOIN factory.delivery_approval approval ON approval.id::text=merge.payload->>'approvalId'
        AND approval.change_id=change.id AND approval.commit_sha=merge.payload->>'commitSha'
      JOIN factory.verification verification ON verification.id=approval.verification_id
        AND verification.change_id=change.id AND verification.commit_sha=merge.payload->>'commitSha' AND verification.state='succeeded'
      JOIN factory.candidate_review review ON review.id=approval.candidate_review_id AND review.verification_id=verification.id
        AND review.change_id=change.id AND review.commit_sha=merge.payload->>'commitSha' AND review.state='passed'
      LEFT JOIN factory.operation preview ON preview.kind='delivery.staging_preview' AND preview.scope_type='project'
        AND preview.scope_id=promotion.payload->>'projectId'
      WHERE promotion.id=${owner.promotionID} AND promotion.kind='delivery.promotion' AND promotion.scope_type='change'
        AND promotion.payload->>'projectId'=${projectID} AND change.project_id=${projectID}
        AND ticket.trashed_at IS NULL AND EXISTS(SELECT 1 FROM factory.current_promotion WHERE id=promotion.id)
        AND ((promotion.state IN ('pending','starting','switching') AND change.state='delivering' AND change.cancel_requested_at IS NULL)
          OR (promotion.state='succeeded' AND change.state='delivered' AND preview.payload->>'runtimeAttemptId'=${attemptID}
            AND preview.payload->>'revision'=promotion.payload->>'commitSha'))
        AND ((promotion.payload->>'replacementRuntimeAttemptId') IS NULL OR promotion.payload->>'replacementRuntimeAttemptId'=${attemptID})
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
    SELECT preview.payload->>'revision' AS revision,project.repository_url AS repository,project.actor_template_path AS "actorTemplatePath",
      NULL::text AS "runnerUUID",NULL::text AS "runnerToken",NULL::text AS "jobHandle",NULL::text AS version
    FROM factory.operation preview JOIN factory.project project ON project.id::text=preview.scope_id
    WHERE preview.kind='delivery.staging_preview' AND preview.scope_type='project' AND preview.scope_id=${projectID}
      AND ((preview.payload->>'runtimeAttemptId') IS NULL OR preview.payload->>'runtimeAttemptId'=${attemptID}
      OR EXISTS(SELECT 1 FROM factory.runtime_attempt predecessor
        WHERE predecessor.id::text=preview.payload->>'runtimeAttemptId'
          AND predecessor.state='stopped' AND predecessor.deleted_at IS NOT NULL))
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
    SELECT provision.runtime_attempt_id FROM factory.substrate_provision provision
    LEFT JOIN factory.runtime_attempt attempt ON attempt.id=${attemptID}
    WHERE provision.runtime_attempt_id=${attemptID} AND provision.project_id=${projectID}
      AND provision.owner_id=${owner.isolatedID} AND provision.kind=${owner.isolatedKind}
      AND provision.intent->>'createdBy'=${userID}
      AND (provision.intent->>'promotionID') IS NOT DISTINCT FROM ${owner.promotionID}
      AND provision.intent->>'revision'=${scope.revision} AND provision.intent->>'repository'=${scope.repository}
      AND (provision.intent->>'jobHandle') IS NOT DISTINCT FROM ${scope.jobHandle}
      AND jsonb_typeof(provision.resources->'atespace'->'value')='object'
      AND jsonb_typeof(provision.resources->'policy'->'value')='object'
      AND jsonb_typeof(provision.resources->'template'->'value')='object'
      AND NOT COALESCE((provision.resources#>>'{atespace,rejected}')::boolean,false)
      AND NOT COALESCE((provision.resources#>>'{policy,rejected}')::boolean,false)
      AND NOT COALESCE((provision.resources#>>'{template,rejected}')::boolean,false)
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
  const [attempt] = await drizzleTransaction(sql)
    .select({ userID: runtimeAttempt.createdBy })
    .from(runtimeAttempt)
    .where(
      and(
        eq(runtimeAttempt.id, attemptID),
        inArray(runtimeAttempt.isolatedKind, ["staging", "publication"]),
        isNull(runtimeAttempt.workspaceId),
        isNull(runtimeAttempt.changeId),
        inArray(runtimeAttempt.state, ["starting", "ready"]),
        isNull(runtimeAttempt.stopIntendedAt),
      ),
    );
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
    JOIN factory.substrate_provision provision ON provision.runtime_attempt_id=attempt.id
      AND provision.project_id=attempt.project_id AND provision.generation=attempt.generation
      AND provision.kind=attempt.isolated_kind::text
    WHERE attempt.id=${attemptID} AND attempt.workspace_id IS NULL AND attempt.change_id IS NULL
      AND attempt.isolated_kind IN ('staging','publication') AND attempt.state IN ('create-intended','starting')
      AND attempt.ready_at IS NULL AND attempt.stop_intended_at IS NULL
      AND provision.intent->>'repository'=project.repository_url AND provision.intent->>'revision'=attempt.revision
      AND attempt.actor_uid IS NOT NULL AND attempt.create_attempted_at IS NOT NULL AND NOT attempt.create_rejected
      AND attempt.delete_intended_at IS NULL AND attempt.deleted_at IS NULL`;
  if (!scope)
    throw new CommandError("forbidden", "Current native isolated Source grant is required");
  await substrateIsolatedGrantIn(sql, scope.projectID, scope, attemptID, scope.userID);
  return scope.repository;
}
