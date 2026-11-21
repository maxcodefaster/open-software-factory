import { eq } from "drizzle-orm";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  change,
  developmentWorkspace,
  runtimeAttempt,
  ticket,
} from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";
import {
  administratorIn,
  projectAccessIn,
  projectAuthorityIn,
  projectDevelopmentAuthorityIn,
  requireActiveAccountIn,
  requireSystemManagerIn,
} from "./authority";
import { workspaceAuthorityIn } from "./workspace";

type Database = ReturnType<typeof createDatabase>;

export function createAccessController(database: Database) {
  async function isSystemManager(userID: string) {
    return database.client.begin(async (transaction) => {
      await requireActiveAccountIn(transaction, userID);
      return administratorIn(transaction, userID);
    });
  }
  async function requireSystemManager(userID: string) {
    await database.client.begin((transaction) => requireSystemManagerIn(transaction, userID));
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
    return database.client.begin(
      async (transaction) => (await projectAccessIn(transaction, userID, projectID)).develop,
    );
  }
  async function requireRuntime(userID: string, attemptID: string, channel?: "app" | "ide") {
    const rows = await database.db
      .select({
        projectID: runtimeAttempt.projectId,
        kind: developmentWorkspace.kind,
        ownerID: developmentWorkspace.ownerUserId,
        workspaceID: developmentWorkspace.id,
      })
      .from(runtimeAttempt)
      .leftJoin(developmentWorkspace, eq(developmentWorkspace.id, runtimeAttempt.workspaceId))
      .where(eq(runtimeAttempt.id, attemptID));
    const row = rows[0];
    if (!row) {
      throw new CommandError("not-found", "Runtime not found");
    }
    if (row.kind === "personal" && row.workspaceID) {
      const workspaceID = row.workspaceID;
      await database.client.begin((transaction) =>
        workspaceAuthorityIn(transaction, workspaceID, userID),
      );
      return;
    }
    if (channel === "ide") await requireDevelopment(userID, row.projectID);
    else await requireProject(userID, row.projectID);
  }
  async function requireTicket(userID: string, ticketID: string) {
    const rows = await database.db
      .select({ projectID: ticket.projectId })
      .from(ticket)
      .where(eq(ticket.id, ticketID));
    if (!rows[0]) throw new CommandError("not-found", "Ticket not found");
    await requireProject(userID, rows[0].projectID);
  }
  async function requireChange(userID: string, changeID: string) {
    const rows = await database.db
      .select({ projectID: change.projectId })
      .from(change)
      .where(eq(change.id, changeID));
    if (!rows[0]) throw new CommandError("not-found", "Change not found");
    await requireProject(userID, rows[0].projectID);
    return rows[0].projectID;
  }
  async function authorizeAPI(request: Request, userID: string) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/admin/")) {
      await requireSystemManager(userID);
    }
    const projectID = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)(?:\/|$)/)?.[1];
    if (projectID) {
      await requireProject(userID, projectID);
    }
    const ticketID = url.pathname.match(/^\/api\/tickets\/([0-9a-f-]+)(?:\/|$)/)?.[1];
    if (ticketID) await requireTicket(userID, ticketID);
    const changeID = url.pathname.match(/^\/api\/changes\/([0-9a-f-]+)(?:\/|$)/)?.[1];
    if (changeID) {
      await requireChange(userID, changeID);
    }
    const attemptID = url.pathname.match(/^\/api\/runtime-attempts\/([a-z0-9-]+)(?:\/|$)/)?.[1];
    if (attemptID)
      await requireRuntime(userID, attemptID, request.method === "GET" ? undefined : "ide");
  }
  return {
    isSystemManager,
    requireSystemManager,
    requireProject,
    requireTicket,
    requireChange,
    requireDevelopment,
    canDevelop,
    requireRuntime,
    authorizeAPI,
  };
}
