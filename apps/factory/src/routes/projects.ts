import type { createDatabase } from "../../../../packages/db/src/client";
import { createRegisterProjectInput } from "../../../../packages/project-domain/src/project";
import { json } from "../http";
import { createAccessController } from "../access/controller";
import { factoryForgeSource } from "../knowledge/forge-source";

type Database = ReturnType<typeof createDatabase>;
type Session = { user: { id: string } };

export type ProjectRouteDependencies = {
  database: Database;
  localRepositoryOrigin: string;
  session(request: Request): Promise<Session | null>;
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
  createdAt: string;
};

function isUniqueViolation(cause: unknown): cause is { code: "23505" } {
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "23505");
}

export function createProjectRoute(dependencies: ProjectRouteDependencies) {
  const access = createAccessController(dependencies.database);
  const registerProjectInput = createRegisterProjectInput(dependencies.localRepositoryOrigin);
  return async function projects(request: Request) {
    const session = await dependencies.session(request);
    if (!session) return json({ error: "Authentication required" }, 401);
    if (request.method === "GET") {
      const rows = await dependencies.database.client<ProjectRow[]>`
        SELECT id, slug, name, repository_url AS "repositoryUrl",
          desktop_background_key AS "desktopBackgroundKey",
          default_branch AS "defaultBranch", devcontainer_path AS "devcontainerPath",
          created_at AS "createdAt"
        FROM factory.project
        WHERE EXISTS(SELECT 1 FROM factory.administrator WHERE user_id = ${session.user.id})
          OR EXISTS(SELECT 1 FROM factory.project_membership
            WHERE project_id = factory.project.id AND user_id = ${session.user.id})
        ORDER BY created_at DESC
      `;
      return json({ projects: rows });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    await access.requireSystemManager(session.user.id);
    const parsed = registerProjectInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? "Invalid Project" }, 400);
    }
    const input = parsed.data;
    try {
      factoryForgeSource(
        input.repositoryUrl,
        dependencies.localRepositoryOrigin,
        dependencies.forgeOwner,
      );
    } catch {
      return json({ error: "Project source must belong to the configured Factory Forgejo." }, 400);
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
          ${input.devcontainerPath}, ${session.user.id}
        )
        RETURNING id, slug, name, repository_url AS "repositoryUrl",
          desktop_background_key AS "desktopBackgroundKey",
          default_branch AS "defaultBranch", devcontainer_path AS "devcontainerPath",
          created_at AS "createdAt"
      `;
        await sql`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
          VALUES(${id},${session.user.id},'developer',true,${session.user.id})`;
        return created;
      });
      const project = rows[0];
      if (!project) throw new Error("Project insert returned no row");
      void dependencies
        .ensureKnowledgeHook(project.id)
        .catch(() => console.error("Wiki source hook setup failed"));
      void dependencies.ensureStaging(project.id, session.user.id).catch((cause) => {
        console.error("Staging start failed", cause);
      });
      void dependencies.generateKnowledge(project.id, session.user.id).catch((cause) => {
        console.error("Initial Knowledge generation failed", cause);
      });
      return json(project, 201);
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        return json({ error: "A Project with that slug already exists" }, 409);
      }
      throw cause;
    }
  };
}
