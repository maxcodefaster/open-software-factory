import { and, count, eq, exists, or } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { administrator, project, projectMembership } from "#db/schema";
import { desktopBackgroundKeys } from "#interface-domain/background";

export const projectFields = {
  id: project.id,
  slug: project.slug,
  name: project.name,
  desktopBackgroundKey: project.desktopBackgroundKey,
  repositoryUrl: project.repositoryUrl,
  defaultBranch: project.defaultBranch,
  actorTemplatePath: project.actorTemplatePath,
  createdAt: project.createdAt,
};

// Both registration paths allocate the shared background in their creation transaction.
// Direct database fixtures use the schema's fixed default, not product selection policy.
export async function createProjectIn(
  transaction: DatabaseTransaction,
  input: Pick<
    typeof project.$inferInsert,
    "id" | "slug" | "name" | "repositoryUrl" | "defaultBranch" | "actorTemplatePath" | "createdBy"
  >,
) {
  await transaction`SELECT pg_advisory_xact_lock(hashtextextended('factory-project-background-allocation',0))`;
  const db = drizzleTransaction(transaction);
  const used = await db
    .select({ key: project.desktopBackgroundKey, count: count() })
    .from(project)
    .where(
      or(
        exists(
          db
            .select({ userId: administrator.userId })
            .from(administrator)
            .where(eq(administrator.userId, input.createdBy)),
        ),
        exists(
          db
            .select({ projectId: projectMembership.projectId })
            .from(projectMembership)
            .where(
              and(
                eq(projectMembership.projectId, project.id),
                eq(projectMembership.userId, input.createdBy),
              ),
            ),
        ),
      ),
    )
    .groupBy(project.desktopBackgroundKey);
  const counts = new Map(used.map((row) => [row.key, row.count]));
  const least = Math.min(...desktopBackgroundKeys.map((key) => counts.get(key) ?? 0));
  const available = desktopBackgroundKeys.filter((key) => (counts.get(key) ?? 0) === least);
  const background = available[Math.floor(Math.random() * available.length)];
  if (!background) throw new Error("Project background catalogue is empty");
  const rows = await db
    .insert(project)
    .values({ ...input, desktopBackgroundKey: background })
    .returning(projectFields);
  if (!rows[0]) throw new Error("Project insert returned no row");
  return rows;
}
