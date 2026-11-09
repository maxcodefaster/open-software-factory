import {
  workspaceShareInput,
  workspaceShareView,
  type WorkspaceShareInput,
} from "../../../../packages/workspace-domain/src/sharing";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;

export function createWorkspaceSharing(
  database: Database,
  revoke: (workspaceID: string, userID: string) => void | Promise<void>,
) {
  async function reconcile(id: string) {
    await database.client.begin(async (sql) => {
      const [decision] = await sql<
        {
          workspaceID: string;
          userID: string;
          permission: string | null;
          version: string;
          reconciled: boolean;
        }[]
      >`SELECT workspace_id AS "workspaceID",user_id AS "userID",permission,
        result->>'version' AS version,access_reconciled_at IS NOT NULL AS reconciled
        FROM factory.workspace_share_decision WHERE id=${id}`;
      if (!decision || decision.reconciled) return;
      // Serialize with sharing decisions and new authorized source access, not with runtime work.
      await sql`SELECT id FROM factory.development_workspace WHERE id=${decision.workspaceID} FOR UPDATE`;
      const [current] = await sql<
        { version: string }[]
      >`SELECT version::text FROM factory.workspace_share
        WHERE workspace_id=${decision.workspaceID} AND user_id=${decision.userID}`;
      // A delayed old revoke must not close access obtained through a later sharing decision.
      if (current?.version === decision.version && decision.permission !== "collaborate")
        await revoke(decision.workspaceID, decision.userID);
      await sql`UPDATE factory.workspace_share_decision SET access_reconciled_at=now()
        WHERE id=${id} AND access_reconciled_at IS NULL`;
    });
  }
  return {
    async view(userID: string, workspaceID: string) {
      return database.client.begin(async (sql) => {
        const workspace = await workspaceAuthorityIn(sql, workspaceID, userID);
        if (workspace.ownerID !== userID || workspace.kind !== "personal")
          throw new CommandError("forbidden", "Only the Workspace owner manages sharing");
        const members = await sql<
          {
            userID: string;
            name: string;
            permission: "observe" | "collaborate" | null;
            version: string;
          }[]
        >`SELECT member.user_id AS "userID",person.name,
          CASE WHEN share.revoked_at IS NULL THEN share.permission ELSE NULL END AS permission,
          COALESCE(share.version,0)::text AS version
          FROM factory.project_membership member JOIN auth."user" person ON person.id=member.user_id
          JOIN factory.account_access access ON access.user_id=member.user_id
          LEFT JOIN factory.workspace_share share ON share.user_id=member.user_id AND share.workspace_id=${workspaceID}
          WHERE member.project_id=${workspace.projectID} AND member.role='developer' AND member.user_id<>${userID}
            AND access.disabled_at IS NULL AND access.directory_disabled_at IS NULL ORDER BY person.name,person.id`;
        return {
          workspaceID,
          members: members.map((row) => ({ ...row, version: Number(row.version) })),
        };
      });
    },
    async decide(actorID: string, value: WorkspaceShareInput) {
      const input = workspaceShareInput.parse(value);
      const result = await database.client.begin(async (sql) => {
        const [workspace] = await sql<{ projectID: string; ownerID: string; kind: string }[]>`
          SELECT project_id AS "projectID",owner_user_id AS "ownerID",kind
          FROM factory.development_workspace WHERE id=${input.workspaceID} FOR UPDATE`;
        if (!workspace || workspace.ownerID !== actorID || workspace.kind !== "personal")
          throw new CommandError("not-found", "Owned personal Workspace not found");
        await projectDevelopmentAuthorityIn(sql, actorID, workspace.projectID);
        if (input.userID === actorID)
          throw new CommandError("conflict", "The owner cannot remove their own Workspace access");
        const [previous] = await sql<
          {
            workspaceID: string;
            userID: string;
            actorID: string;
            permission: string | null;
            expectedVersion: string;
            result: unknown;
          }[]
        >`SELECT workspace_id AS "workspaceID",user_id AS "userID",actor_id AS "actorID",permission,
          expected_version::text AS "expectedVersion",result FROM factory.workspace_share_decision WHERE id=${input.commandID}`;
        if (previous) {
          if (
            previous.workspaceID !== input.workspaceID ||
            previous.userID !== input.userID ||
            previous.actorID !== actorID ||
            previous.permission !== input.permission ||
            Number(previous.expectedVersion) !== input.expectedVersion
          )
            throw new CommandError(
              "conflict",
              "This sharing command already records a different decision",
            );
          return workspaceShareView.parse(previous.result);
        }
        // Removal still works after a member lost Project access. New grants do not elevate it.
        if (input.permission !== null)
          await projectDevelopmentAuthorityIn(sql, input.userID, workspace.projectID);
        const [current] = await sql<{ version: string }[]>`SELECT version::text
          FROM factory.workspace_share WHERE workspace_id=${input.workspaceID} AND user_id=${input.userID} FOR UPDATE`;
        if (Number(current?.version ?? 0) !== input.expectedVersion)
          throw new CommandError(
            "conflict",
            "Workspace sharing changed. Refresh before deciding again.",
          );
        const next = workspaceShareView.parse({
          workspaceID: input.workspaceID,
          userID: input.userID,
          permission: input.permission,
          version: input.expectedVersion + 1,
        });
        await sql`INSERT INTO factory.workspace_share(workspace_id,user_id,permission,version,granted_by,revoked_at)
          VALUES(${input.workspaceID},${input.userID},${input.permission ?? "observe"},${next.version},${actorID},CASE WHEN ${input.permission === null} THEN now() ELSE NULL END)
          ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission=EXCLUDED.permission,
            version=EXCLUDED.version,granted_by=EXCLUDED.granted_by,granted_at=now(),revoked_at=EXCLUDED.revoked_at`;
        await sql`INSERT INTO factory.workspace_share_decision(id,workspace_id,user_id,actor_id,permission,expected_version,result)
          VALUES(${input.commandID},${input.workspaceID},${input.userID},${actorID},${input.permission},${input.expectedVersion},${JSON.stringify(next)}::text::jsonb)`;
        if (input.permission !== null)
          await sql`UPDATE factory.development_workspace SET collaboration_enabled=true WHERE id=${input.workspaceID}`;
        return next;
      });
      await reconcile(input.commandID);
      return result;
    },
    async recover() {
      const pending = await database.client<
        { id: string }[]
      >`SELECT id FROM factory.workspace_share_decision
        WHERE access_reconciled_at IS NULL ORDER BY created_at,id`;
      for (const row of pending) await reconcile(row.id);
    },
  };
}
