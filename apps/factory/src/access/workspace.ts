import { and, eq, isNull, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { developmentWorkspace, workspaceShare } from "#db/schema";
import { CommandError } from "../command-error";
import { projectDevelopmentAuthorityIn } from "./authority";

export type WorkspaceAuthority = {
  projectID: string;
  kind: string;
  ownerID: string | null;
  changeID: string | null;
  permission: "observe" | "collaborate";
  accessVersion: string;
  collaborative: boolean;
};

/** Project membership is always the upper bound, including for an explicitly shared Workspace. */
export async function workspaceAuthorityIn(
  sql: DatabaseTransaction,
  workspaceID: string,
  userID: string,
  write = false,
): Promise<WorkspaceAuthority> {
  const db = drizzleTransaction(sql);
  const [workspace] = await db
    .select({
      projectID: developmentWorkspace.projectId,
      kind: developmentWorkspace.kind,
      ownerID: developmentWorkspace.ownerUserId,
      changeID: developmentWorkspace.changeId,
      collaborative: developmentWorkspace.collaborationEnabled,
    })
    .from(developmentWorkspace)
    .where(eq(developmentWorkspace.id, workspaceID))
    .for("share");
  if (!workspace) throw new CommandError("not-found", "Workspace not found");
  await projectDevelopmentAuthorityIn(sql, userID, workspace.projectID);
  let permission: WorkspaceAuthority["permission"] = "collaborate";
  let accessVersion = "0";
  if (workspace.kind === "personal" && workspace.ownerID !== userID) {
    const [share] = await db
      .select({
        permission: workspaceShare.permission,
        version: query<string>`${workspaceShare.version}::text`,
      })
      .from(workspaceShare)
      .where(
        and(
          eq(workspaceShare.workspaceId, workspaceID),
          eq(workspaceShare.userId, userID),
          isNull(workspaceShare.revokedAt),
        ),
      )
      .for("share");
    if (!share) throw new CommandError("not-found", "Workspace not found");
    permission = share.permission;
    accessVersion = share.version;
  }
  if (write && permission !== "collaborate")
    throw new CommandError("forbidden", "This Workspace is shared for observation only");
  return { ...workspace, permission, accessVersion };
}
