import type { AgentTurnTransaction } from "../agent/turn-store";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

export async function learningAuthorityIn(
  sql: AgentTurnTransaction,
  actorId: string,
  scope: {
    projectId: string;
    ownerId: string | null;
    developerOnly: boolean;
    managerOnly?: boolean;
  },
) {
  if (scope.ownerId && scope.ownerId !== actorId)
    throw new CommandError("not-found", "Work review not found");
  await projectAuthorityIn(sql, actorId, scope.projectId, scope.managerOnly ?? false);
  if (scope.developerOnly) await projectDevelopmentAuthorityIn(sql, actorId, scope.projectId);
}
export async function learningEnabledIn(
  sql: AgentTurnTransaction,
  projectId: string,
  ownerId: string | null,
) {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtext(${`learning-policy:${projectId}:project`}))`;
  if (ownerId)
    await sql`SELECT pg_advisory_xact_lock_shared(hashtext(${`learning-policy:${projectId}:${ownerId}`}))`;
  const [disabled] = await sql`SELECT scope_key FROM factory.learning_policy
    WHERE project_id=${projectId} AND (owner_id IS NULL OR owner_id=${ownerId}) AND NOT enabled`;
  return !disabled;
}
