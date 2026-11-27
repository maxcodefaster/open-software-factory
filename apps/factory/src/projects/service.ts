import { and, DrizzleQueryError, desc, eq, exists, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { administrator, operation, project, projectMembership } from "#db/schema";
import { createRegisterProjectInput, type RegisterProjectInput } from "#project-domain/project";
import { requireActiveAccountIn, requireSystemManagerIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { factoryForgeSource } from "../knowledge/forge-source";
import { projectSchema } from "./contracts";
import { createProjectIn, projectFields } from "./creation";

type Database = ReturnType<typeof createDatabase>;

export type ProjectServiceDependencies = {
  database: Database;
  localRepositoryOrigin: string;
  publicRepositoryOrigin?: string;
  onRegistered(projectID: string, userID: string, recovering: boolean): Promise<void>;
  forgeOwner: string;
  readDefaultBranch(repository: { owner: string; name: string }): Promise<string>;
};

type ProjectRow = Pick<typeof project.$inferSelect, keyof typeof projectFields>;

function isUniqueViolation(cause: unknown): boolean {
  if (cause instanceof DrizzleQueryError) return isUniqueViolation(cause.cause);
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "23505");
}

export function createProjectService(dependencies: ProjectServiceDependencies) {
  const registerProjectInput = createRegisterProjectInput(dependencies.localRepositoryOrigin);
  const dto = (row: ProjectRow) =>
    projectSchema.parse({
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    });
  return {
    async recover() {
      const { db } = dependencies.database;
      const readiness = alias(operation, "setup_readiness");
      const repoIntent = alias(operation, "repo_intent");
      const projects = await db
        .select({ id: project.id, userID: project.createdBy })
        .from(project)
        .innerJoin(
          readiness,
          and(
            eq(readiness.kind, "projects.setup_readiness"),
            eq(readiness.scopeType, "project"),
            eq(
              readiness.idempotencyKey,
              sql<string>`'projects.setup_readiness:' || ${project.id}::text || ':configuration'`,
            ),
          ),
        )
        .where(
          and(
            eq(readiness.state, "pending"),
            notExists(
              db
                .select({ id: repoIntent.id })
                .from(repoIntent)
                .where(
                  and(
                    eq(repoIntent.kind, "projects.repository_intent"),
                    eq(repoIntent.scopeType, "project"),
                    eq(
                      repoIntent.idempotencyKey,
                      sql<string>`'projects.repository_intent:' || ${project.id}::text`,
                    ),
                  ),
                ),
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
      try {
        const id = crypto.randomUUID();
        const admission = await dependencies.database.client.begin(async (client) => {
          await client`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
          await requireSystemManagerIn(client, userID);
          const input = registerProjectInput.parse(value);
          let repository: ReturnType<typeof factoryForgeSource>;
          try {
            repository = factoryForgeSource(
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
          if (repository.name !== input.slug)
            throw new CommandError("invalid", "Project repository name must match its slug.");
          return { input, repository };
        });
        // Forge reads must not hold the installation-wide policy lock or account rows.
        // Recheck authority under that lock before interpreting the result or writing.
        let defaultBranch: string | undefined;
        try {
          defaultBranch = await dependencies.readDefaultBranch(admission.repository);
        } catch {
          // An unconfirmed remote read never admits Project or background work.
        }
        const rows = await dependencies.database.client.begin(async (client) => {
          await client`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
          await requireSystemManagerIn(client, userID);
          if (!defaultBranch)
            throw new CommandError(
              "unavailable",
              "Factory could not confirm the repository default branch. Check Forgejo access and try again.",
            );
          const { input } = admission;
          if (defaultBranch !== input.defaultBranch)
            throw new CommandError(
              "invalid",
              "Project branch must match the repository default branch.",
            );
          const db = drizzleTransaction(client);
          const created = await createProjectIn(client, {
            id,
            ...input,
            createdBy: userID,
          });
          await db.insert(projectMembership).values({
            projectId: id,
            userId: userID,
            role: "developer",
            manageProject: true,
            updatedBy: userID,
          });
          await db.insert(operation).values({
            id: crypto.randomUUID(),
            kind: "projects.setup_readiness",
            scopeType: "project",
            scopeId: id,
            idempotencyKey: `projects.setup_readiness:${id}:configuration`,
            state: "pending",
            payload: { task: "configuration", commandId: crypto.randomUUID() },
            createdBy: userID,
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
