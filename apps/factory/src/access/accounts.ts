import { emergencyAdministratorID } from "../../../../packages/auth/src/policy";
import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { requireActiveAccountIn } from "./controller";

export function createAccountCommands(database: ReturnType<typeof createDatabase>) {
  return {
    async disable(actorID: string, userID: string, disabled: boolean) {
      await database.client.begin(async (sql) => {
        // Serialize last-manager safeguards with each other. Sessions lock account_access in SQL.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
        await requireActiveAccountIn(sql, actorID);
        const [actor] =
          await sql`SELECT user_id FROM factory.administrator WHERE user_id=${actorID} FOR SHARE`;
        if (!actor) throw new CommandError("forbidden", "System Manager access required");
        const [account] =
          await sql`SELECT user_id FROM factory.account_access WHERE user_id=${userID} FOR UPDATE`;
        if (!account) throw new CommandError("not-found", "Account not found");
        if (disabled && (actorID === userID || userID === emergencyAdministratorID))
          throw new CommandError(
            "conflict",
            "The emergency administrator and your own account must remain available",
          );
        if (disabled) {
          const [stranded] = await sql`SELECT project_id FROM factory.project_membership member
            WHERE user_id=${userID} AND manage_project AND NOT EXISTS(
              SELECT 1 FROM factory.project_membership other
              JOIN factory.account_access access ON access.user_id=other.user_id
              WHERE other.project_id=member.project_id AND other.user_id<>${userID} AND other.manage_project
                AND access.disabled_at IS NULL AND access.directory_disabled_at IS NULL
            ) LIMIT 1`;
          if (stranded)
            throw new CommandError(
              "conflict",
              "Assign another Project Manager before disabling this account",
            );
        }
        await sql`UPDATE factory.account_access SET disabled_at=CASE WHEN ${disabled} THEN now() ELSE NULL END,disabled_by=${actorID},updated_at=now() WHERE user_id=${userID}`;
        if (disabled) await sql`DELETE FROM auth.session WHERE user_id=${userID}`;
      });
    },
    async endSessions(actorID: string, userID: string) {
      await database.client.begin(async (sql) => {
        await requireActiveAccountIn(sql, actorID);
        if (actorID !== userID) {
          const [actor] =
            await sql`SELECT user_id FROM factory.administrator WHERE user_id=${actorID} FOR SHARE`;
          if (!actor) throw new CommandError("forbidden", "System Manager access required");
        }
        const [account] =
          await sql`SELECT user_id FROM factory.account_access WHERE user_id=${userID} FOR UPDATE`;
        if (!account) throw new CommandError("not-found", "Account not found");
        await sql`DELETE FROM auth.session WHERE user_id=${userID}`;
      });
    },
  };
}
