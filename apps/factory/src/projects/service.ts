import { and, DrizzleQueryError, desc, eq, exists, notExists, or, sql } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  administrator,
  project,
  projectMembership,
  projectRepositoryIntent,
  projectSetupReadiness,
} from "../../../../packages/db/src/schema";
import {
  createRegisterProjectInput,
  type RegisterProjectInput,
} from "../../../../packages/project-domain/src/project";
import { createAccessController, requireActiveAccountIn } from "../access/controller";
import { projectSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { factoryForgeSource } from "../knowledge/forge-source";

type Database = ReturnType<typeof createDatabase>;

export type ProjectServiceDependencies = {
  database: Database;
  localRepositoryOrigin: string;
  publicRepositoryOrigin?: string;
  onRegistered(projectID: string, userID: string, recovering: boolean): Promise<void>;
  forgeOwner: string;
};

const projectFields = {
  id: project.id,
  slug: project.slug,
  name: project.name,
  desktopBackgroundKey: project.desktopBackgroundKey,
  repositoryUrl: project.repositoryUrl,
  defaultBranch: project.defaultBranch,
  devcontainerPath: project.devcontainerPath,
  createdAt: project.createdAt,
};
type ProjectRow = Pick<typeof project.$inferSelect, keyof typeof projectFields>;

function isUniqueViolation(cause: unknown): boolean {
  if (cause instanceof DrizzleQueryError) return isUniqueViolation(cause.cause);
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "23505");
}

export function createProjectService(dependencies: ProjectServiceDependencies) {
  const access = createAccessController(dependencies.database);
  const registerProjectInput = createRegisterProjectInput(dependencies.localRepositoryOrigin);
  const dto = (row: ProjectRow) =>
    projectSchema.parse({
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    });
  return {
    async recover() {
      const { db } = dependencies.database;
      const projects = await db
        .select({ id: project.id, userID: project.createdBy })
        .from(project)
        .innerJoin(
          projectSetupReadiness,
          and(
            eq(projectSetupReadiness.projectId, project.id),
            eq(projectSetupReadiness.task, "configuration"),
          ),
        )
        .where(
          and(
            eq(projectSetupReadiness.state, "pending"),
            notExists(
              db
                .select({ projectId: projectRepositoryIntent.projectId })
                .from(projectRepositoryIntent)
                .where(eq(projectRepositoryIntent.projectId, project.id)),
            ),
          ),
        );
      for (const project of projects)
        await dependencies.onRegistered(project.id, project.userID, true);
    },
    async list(userID: string) {
      await dependencies.database.client.begin((sql) => requireActiveAccountIn(sql, userID));
      const { db } = dependencies.database;
      const rows = await db
        .select(projectFields)
        .from(project)
        .where(
          or(
            exists(
              db
                .select({ userId: administrator.userId })
                .from(administrator)
                .where(eq(administrator.userId, userID)),
            ),
            exists(
              db
                .select({ projectId: projectMembership.projectId })
                .from(projectMembership)
                .where(
                  and(
                    eq(projectMembership.projectId, project.id),
                    eq(projectMembership.userId, userID),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(project.createdAt));
      return { projects: rows.map(dto) };
    },
    async register(userID: string, value: RegisterProjectInput) {
      await access.requireSystemManager(userID);
      const input = registerProjectInput.parse(value);
      try {
        factoryForgeSource(
          input.repositoryUrl,
          dependencies.localRepositoryOrigin,
          dependencies.forgeOwner,
          dependencies.publicRepositoryOrigin,
        );
      } catch {
        throw new CommandError(
          "invalid",
          "Project source must belong to the configured Factory Forgejo.",
        );
      }
      try {
        const id = crypto.randomUUID();
        const rows = await dependencies.database.client.begin(async (client) => {
          await client`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
          const db = drizzleTransaction(client);
          const created = await db
            .insert(project)
            .values({
              id,
              slug: input.slug,
              name: input.name,
              repositoryUrl: input.repositoryUrl,
              defaultBranch: input.defaultBranch,
              devcontainerPath: input.devcontainerPath,
              createdBy: userID,
              // The database trigger assigns the shared background. Keep its
              // choice and timestamp defaults rather than synthesizing them.
              desktopBackgroundKey: sql`default`,
              createdAt: sql`default`,
              updatedAt: sql`default`,
            })
            .returning(projectFields);
          await db.insert(projectMembership).values({
            projectId: id,
            userId: userID,
            role: "developer",
            manageProject: true,
            updatedBy: userID,
          });
          await db.insert(projectSetupReadiness).values({
            projectId: id,
            task: "configuration",
            commandId: crypto.randomUUID(),
          });
          return created;
        });
        const registered = rows[0];
        if (!registered) throw new Error("Project insert returned no row");
        void dependencies
          .onRegistered(registered.id, userID, false)
          .catch(reportFailure("Registered Project preparation needs attention"));
        return dto(registered);
      } catch (cause) {
        if (isUniqueViolation(cause)) {
          throw new CommandError("conflict", "A Project with that slug already exists");
        }
        throw cause;
      }
    },
  };
}
