import type { createDatabase } from "../../../../packages/db/src/client";
import {
  createRegisterProjectInput,
  type RegisterProjectInput,
} from "../../../../packages/project-domain/src/project";
import { createAccessController, requireActiveAccountIn } from "../access/controller";
import { projectSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import { factoryForgeSource } from "../knowledge/forge-source";

type Database = ReturnType<typeof createDatabase>;

export type ProjectServiceDependencies = {
  database: Database;
  localRepositoryOrigin: string;
  onRegistered(projectID: string, userID: string, recovering: boolean): Promise<void>;
  forgeOwner: string;
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  desktopBackgroundKey: string;
  repositoryUrl: string;
  defaultBranch: string;
  devcontainerPath: string;
  createdAt: string | Date;
};

function isUniqueViolation(cause: unknown): cause is { code: "23505" } {
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
      const projects = await dependencies.database.client<{ id: string; userID: string }[]>`
        SELECT project.id,project.created_by AS "userID" FROM factory.project project
        JOIN factory.project_setup_readiness configuration
          ON configuration.project_id=project.id AND configuration.task='configuration'
        WHERE configuration.state='pending' AND NOT EXISTS(
          SELECT 1 FROM factory.project_repository_intent intent WHERE intent.project_id=project.id
        )`;
      for (const project of projects)
        await dependencies.onRegistered(project.id, project.userID, true);
    },
    async list(userID: string) {
      await dependencies.database.client.begin((sql) => requireActiveAccountIn(sql, userID));
      const rows = await dependencies.database.client<ProjectRow[]>`
        SELECT id, slug, name, repository_url AS "repositoryUrl",
          desktop_background_key AS "desktopBackgroundKey",
          default_branch AS "defaultBranch", devcontainer_path AS "devcontainerPath",
          created_at AS "createdAt"
        FROM factory.project
        WHERE EXISTS(SELECT 1 FROM factory.administrator WHERE user_id = ${userID})
          OR EXISTS(SELECT 1 FROM factory.project_membership
            WHERE project_id = factory.project.id AND user_id = ${userID})
        ORDER BY created_at DESC
      `;
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
        );
      } catch {
        throw new CommandError(
          "invalid",
          "Project source must belong to the configured Factory Forgejo.",
        );
      }
      try {
        const id = crypto.randomUUID();
        const rows = await dependencies.database.client.begin(async (sql) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
          const created = await sql<ProjectRow[]>`
        INSERT INTO factory.project(
          id, slug, name, repository_url, default_branch, devcontainer_path, created_by
        ) VALUES (
          ${id}, ${input.slug}, ${input.name}, ${input.repositoryUrl}, ${input.defaultBranch},
          ${input.devcontainerPath}, ${userID}
        )
        RETURNING id, slug, name, repository_url AS "repositoryUrl",
          desktop_background_key AS "desktopBackgroundKey",
          default_branch AS "defaultBranch", devcontainer_path AS "devcontainerPath",
          created_at AS "createdAt"
      `;
          await sql`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
          VALUES(${id},${userID},'developer',true,${userID})`;
          await sql`INSERT INTO factory.project_setup_readiness(project_id,task,command_id)
            VALUES(${id},'configuration',${crypto.randomUUID()})`;
          return created;
        });
        const project = rows[0];
        if (!project) throw new Error("Project insert returned no row");
        void dependencies
          .onRegistered(project.id, userID, false)
          .catch(() => console.error("Registered Project preparation needs attention"));
        return dto(project);
      } catch (cause) {
        if (isUniqueViolation(cause)) {
          throw new CommandError("conflict", "A Project with that slug already exists");
        }
        throw cause;
      }
    },
  };
}
