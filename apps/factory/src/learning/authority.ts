import { and, eq, inArray } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";

export async function learningAuthorityIn(
  sql: DatabaseTransaction,
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
  sql: DatabaseTransaction,
  projectId: string,
  ownerId: string | null,
) {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtext(${`learning-policy:${projectId}:project`}))`;
  if (ownerId)
    await sql`SELECT pg_advisory_xact_lock_shared(hashtext(${`learning-policy:${projectId}:${ownerId}`}))`;
  const projectKey = `learning.policy:${projectId}:project`;
  const [disabled] = await drizzleTransaction(sql)
    .select({ id: operation.id })
    .from(operation)
    .where(
      and(
        eq(operation.kind, "learning.policy"),
        eq(operation.scopeType, "project"),
        eq(operation.scopeId, projectId),
        ownerId === null
          ? eq(operation.idempotencyKey, projectKey)
          : inArray(operation.idempotencyKey, [
              projectKey,
              `learning.policy:${projectId}:${ownerId}`,
            ]),
        eq(operation.state, "disabled"),
      ),
    )
    .limit(1);
  return !disabled;
}
