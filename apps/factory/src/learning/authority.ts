import { and, eq, isNull, or } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "../../../../packages/db/src/client";
import { learningPolicy } from "../../../../packages/db/src/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
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
  const [disabled] = await drizzleTransaction(sql)
    .select({ scopeKey: learningPolicy.scopeKey })
    .from(learningPolicy)
    .where(
      and(
        eq(learningPolicy.projectId, projectId),
        or(
          isNull(learningPolicy.ownerId),
          ownerId === null ? undefined : eq(learningPolicy.ownerId, ownerId),
        ),
        eq(learningPolicy.enabled, false),
      ),
    )
    .limit(1);
  return !disabled;
}
