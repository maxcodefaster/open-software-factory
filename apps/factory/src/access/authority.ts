import { and, eq } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { accountAccess, administrator, authUser, project, projectMembership } from "#db/schema";
import { projectCapabilities } from "#project-domain/access";
import { CommandError } from "../command-error";

export async function requireActiveAccountIn(sql: DatabaseTransaction, userID: string) {
  const db = drizzleTransaction(sql);
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userID))
    .for("share");
  const [access] = await db
    .select({
      disabledAt: accountAccess.disabledAt,
      directoryDisabledAt: accountAccess.directoryDisabledAt,
    })
    .from(accountAccess)
    .where(eq(accountAccess.userId, userID))
    .for("share");
  if (!user || !access || access.disabledAt || access.directoryDisabledAt)
    throw new CommandError("forbidden", "Account access is disabled");
}

export async function administratorIn(sql: DatabaseTransaction, userID: string) {
  const [row] = await drizzleTransaction(sql)
    .select({ userId: administrator.userId })
    .from(administrator)
    .where(eq(administrator.userId, userID))
    .for("share");
  return Boolean(row);
}

export async function requireSystemManagerIn(
  sql: DatabaseTransaction,
  userID: string,
  message = "System Manager access required",
) {
  await requireActiveAccountIn(sql, userID);
  if (!(await administratorIn(sql, userID))) throw new CommandError("forbidden", message);
}

export async function projectAccessIn(sql: DatabaseTransaction, userID: string, projectID: string) {
  await requireActiveAccountIn(sql, userID);
  const db = drizzleTransaction(sql);
  const [member] = await db
    .select({ role: projectMembership.role, manageProject: projectMembership.manageProject })
    .from(projectMembership)
    .where(and(eq(projectMembership.projectId, projectID), eq(projectMembership.userId, userID)))
    .for("share");
  const systemManager = await administratorIn(sql, userID);
  const [row] = await db.select({ id: project.id }).from(project).where(eq(project.id, projectID));
  if (!row || (!member && !systemManager)) throw new CommandError("not-found", "Project not found");
  return projectCapabilities(
    systemManager ? "system-manager" : member?.role,
    member?.manageProject,
  );
}

export async function projectAuthorityIn(
  sql: DatabaseTransaction,
  userID: string,
  projectID: string,
  manage = false,
) {
  const access = await projectAccessIn(sql, userID, projectID);
  if (manage && !access.manage)
    throw new CommandError("forbidden", "Project Manager access required");
  return access.manage;
}

export async function projectDevelopmentAuthorityIn(
  sql: DatabaseTransaction,
  userID: string,
  projectID: string,
) {
  if (!(await projectAccessIn(sql, userID, projectID)).develop)
    throw new CommandError("forbidden", "Developer access required");
}
