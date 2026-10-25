import type { createDatabase } from "../../../../packages/db/src/client";
import {
  createRegisterProjectInput,
  type RegisterProjectInput,
} from "../../../../packages/project-domain/src/project";
import { createAccessController, requireActiveAccountIn } from "../access/controller";
import { factoryForgeSource } from "../knowledge/forge-source";
import { projectSchema } from "../api-contracts";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;

export type ProjectServiceDependencies = {
  database: Database;
  localRepositoryOrigin: string;
  ensureStaging(projectID: string, userID: string): Promise<unknown>;
  generateKnowledge(projectID: string, userID: string): Promise<unknown>;
  ensureKnowledgeHook(projectID: string): Promise<void>;
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
          return created;
        });
        const project = rows[0];
        if (!project) throw new Error("Project insert returned no row");
        void dependencies
          .ensureKnowledgeHook(project.id)
          .catch(() => console.error("Wiki source hook setup failed"));
        void dependencies.ensureStaging(project.id, userID).catch((cause) => {
          console.error("Staging start failed", cause);
        });
        void dependencies.generateKnowledge(project.id, userID).catch((cause) => {
          console.error("Initial Knowledge generation failed", cause);
        });
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
