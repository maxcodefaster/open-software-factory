import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { projectDevelopmentAuthorityIn } from "./controller";

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
  sql: AgentTurnTransaction,
  workspaceID: string,
  userID: string,
  write = false,
): Promise<WorkspaceAuthority> {
  const [workspace] = await sql<
    {
      projectID: string;
      kind: string;
      ownerID: string | null;
      changeID: string | null;
      collaborative: boolean;
    }[]
  >`SELECT project_id AS "projectID",kind,owner_user_id AS "ownerID",change_id AS "changeID",collaboration_enabled AS collaborative
    FROM factory.development_workspace WHERE id=${workspaceID} FOR SHARE`;
  if (!workspace) throw new CommandError("not-found", "Workspace not found");
  await projectDevelopmentAuthorityIn(sql, userID, workspace.projectID);
  let permission: WorkspaceAuthority["permission"] = "collaborate";
  let accessVersion = "0";
  if (workspace.kind === "personal" && workspace.ownerID !== userID) {
    const [share] = await sql<{ permission: WorkspaceAuthority["permission"]; version: string }[]>`
      SELECT permission,version::text FROM factory.workspace_share
      WHERE workspace_id=${workspaceID} AND user_id=${userID} AND revoked_at IS NULL FOR SHARE`;
    if (!share) throw new CommandError("not-found", "Workspace not found");
    permission = share.permission;
    accessVersion = share.version;
  }
  if (write && permission !== "collaborate")
    throw new CommandError("forbidden", "This Workspace is shared for observation only");
  return { ...workspace, permission, accessVersion };
}
