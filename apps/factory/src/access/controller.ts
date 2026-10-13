import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type ProjectRole,
  projectCapabilities,
} from "../../../../packages/project-domain/src/access";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;

export async function requireActiveAccountIn(sql: AgentTurnTransaction, userID: string) {
  const [user] = await sql`SELECT id FROM auth."user" WHERE id=${userID} FOR SHARE`;
  const [access] = await sql<Array<{ disabledAt: Date | null; directoryDisabledAt: Date | null }>>`
    SELECT disabled_at AS "disabledAt", directory_disabled_at AS "directoryDisabledAt" FROM factory.account_access WHERE user_id=${userID} FOR SHARE`;
  if (!user || !access || access.disabledAt || access.directoryDisabledAt)
    throw new CommandError("forbidden", "Account access is disabled");
}

export async function projectAuthorityIn(
  sql: AgentTurnTransaction,
  userID: string,
  projectID: string,
  manage = false,
) {
  await requireActiveAccountIn(sql, userID);
  const [member] = await sql<Array<{ manageProject: boolean }>>`
    SELECT manage_project AS "manageProject" FROM factory.project_membership WHERE project_id = ${projectID} AND user_id = ${userID} FOR SHARE
  `;
  const [administrator] =
    await sql`SELECT user_id FROM factory.administrator WHERE user_id = ${userID} FOR SHARE`;
  const [project] = await sql`SELECT id FROM factory.project WHERE id = ${projectID}`;
  if (!project || (!member && !administrator))
    throw new CommandError("not-found", "Project not found");
  const managed = Boolean(administrator || member?.manageProject);
  if (manage && !managed) throw new CommandError("forbidden", "Project Manager access required");
  return managed;
}

export async function projectDevelopmentAuthorityIn(
  sql: AgentTurnTransaction,
  userID: string,
  projectID: string,
) {
  await projectAuthorityIn(sql, userID, projectID);
  const [member] = await sql<
    Array<{ role: ProjectRole }>
  >`SELECT role FROM factory.project_membership
    WHERE project_id = ${projectID} AND user_id = ${userID} FOR SHARE`;
  const [administrator] =
    await sql`SELECT user_id FROM factory.administrator WHERE user_id = ${userID} FOR SHARE`;
  if (!projectCapabilities(administrator ? "system-manager" : member?.role).develop)
    throw new CommandError("forbidden", "Developer access required");
}

export function createAccessController(database: Database) {
  const sql = database.client;
  async function isSystemManager(userID: string) {
    await database.client.begin((transaction) => requireActiveAccountIn(transaction, userID));
    const rows = await sql`SELECT user_id FROM factory.administrator WHERE user_id = ${userID}`;
    return rows.length === 1;
  }
  async function requireSystemManager(userID: string) {
    if (!(await isSystemManager(userID))) {
      throw new CommandError("forbidden", "System Manager access required");
    }
  }
  async function requireProject(userID: string, projectID: string, manage = false) {
    await database.client.begin((transaction) =>
      projectAuthorityIn(transaction, userID, projectID, manage),
    );
  }
  async function requireDevelopment(userID: string, projectID: string) {
    await database.client.begin((sql) => projectDevelopmentAuthorityIn(sql, userID, projectID));
  }
  async function canDevelop(userID: string, projectID: string) {
    await requireProject(userID, projectID);
    if (await isSystemManager(userID)) return true;
    const [member] = await sql<Array<{ role: ProjectRole }>>`
      SELECT role FROM factory.project_membership WHERE project_id=${projectID} AND user_id=${userID}
    `;
    return projectCapabilities(member?.role).develop;
  }
  async function requireRuntime(userID: string, attemptID: string, channel?: "app" | "ide") {
    const rows = await sql<
      Array<{ projectID: string; kind: string | null; ownerID: string | null }>
    >`
      SELECT attempt.project_id AS "projectID", workspace.kind, workspace.owner_user_id AS "ownerID"
      FROM factory.runtime_attempt attempt
      LEFT JOIN factory.development_workspace workspace ON workspace.id = attempt.workspace_id
      WHERE attempt.id = ${attemptID}
    `;
    const row = rows[0];
    if (!row || (channel !== "app" && row.kind === "personal" && row.ownerID !== userID)) {
      throw new CommandError("not-found", "Runtime not found");
    }
    await requireProject(userID, row.projectID);
    if (channel === "ide") await requireDevelopment(userID, row.projectID);
  }
  async function requireTicket(userID: string, ticketID: string) {
    const rows = await sql<Array<{ projectID: string }>>`
      SELECT project_id AS "projectID" FROM factory.ticket WHERE id = ${ticketID}
    `;
    if (!rows[0]) throw new CommandError("not-found", "Ticket not found");
    await requireProject(userID, rows[0].projectID);
  }
  async function requireChange(userID: string, changeID: string) {
    const rows = await sql<Array<{ projectID: string }>>`
      SELECT project_id AS "projectID" FROM factory.change WHERE id = ${changeID}
    `;
    if (!rows[0]) throw new CommandError("not-found", "Change not found");
    await requireProject(userID, rows[0].projectID);
    return rows[0].projectID;
  }
  async function requirePage(userID: string, pageID: string) {
    const rows = await sql<Array<{ projectID: string }>>`
      SELECT project_id AS "projectID" FROM factory.knowledge_page WHERE id = ${pageID}
    `;
    if (!rows[0]) throw new CommandError("not-found", "Knowledge Page not found");
    await requireProject(userID, rows[0].projectID);
  }
  async function authorizeAPI(request: Request, userID: string) {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/api/admin/") ||
      url.pathname.startsWith("/api/model-settings") ||
      (url.pathname === "/api/projects" && request.method === "POST")
    ) {
      await requireSystemManager(userID);
    }
    const projectID = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)(?:\/|$)/)?.[1];
    if (projectID) {
      await requireProject(userID, projectID, url.pathname.includes("/members"));
      if (request.method !== "GET" && /\/(runtime|personal-workspace\/ensure)$/.test(url.pathname))
        await requireDevelopment(userID, projectID);
    }
    const ticketID = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)(?:\/|$)/)?.[1];
    if (ticketID) await requireTicket(userID, ticketID);
    const changeID = url.pathname.match(/^\/api\/changes\/([0-9a-f-]+)(?:\/|$)/)?.[1];
    if (changeID) {
      const project = await requireChange(userID, changeID);
      if (
        request.method !== "GET" &&
        /\/(delivery\/approve|ticket-workspace\/ensure|agent\/start|agent\/prompt|cancel)$/.test(
          url.pathname,
        )
      )
        await requireDevelopment(userID, project);
    }
    const pageID = url.pathname.match(/^\/api\/knowledge\/pages\/([0-9a-f-]+)(?:\/|$)/)?.[1];
    if (pageID) await requirePage(userID, pageID);
    const attemptID = url.pathname.match(/^\/api\/runtime-attempts\/([a-z0-9-]+)(?:\/|$)/)?.[1];
    if (attemptID)
      await requireRuntime(userID, attemptID, request.method === "GET" ? undefined : "ide");
    if (url.pathname === "/api/changes" || url.pathname === "/api/runtime-attempts") {
      const filter = url.searchParams.get("projectId");
      if (filter && /^[0-9a-f-]{36}$/i.test(filter)) await requireProject(userID, filter);
    }
  }
  return {
    isSystemManager,
    requireSystemManager,
    requireProject,
    requireDevelopment,
    canDevelop,
    requireRuntime,
    authorizeAPI,
  };
}
