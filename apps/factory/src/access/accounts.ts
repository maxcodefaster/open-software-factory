import { and, eq, sql as expression, isNull, ne, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { emergencyAdministratorID } from "#auth/policy";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { accountAccess, authSession, projectMembership } from "#db/schema";
import { CommandError } from "../command-error";
import { requireActiveAccountIn, requireSystemManagerIn } from "./authority";

export function createAccountCommands(database: ReturnType<typeof createDatabase>) {
  return {
    async disable(actorID: string, userID: string, disabled: boolean) {
      await database.client.begin(async (sql) => {
        // Serialize last-manager safeguards with each other. Sessions lock account_access in SQL.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
        await requireSystemManagerIn(sql, actorID);
        const db = drizzleTransaction(sql);
        const [account] = await db
          .select({ userId: accountAccess.userId })
          .from(accountAccess)
          .where(eq(accountAccess.userId, userID))
          .for("update");
        if (!account) throw new CommandError("not-found", "Account not found");
        if (disabled && (actorID === userID || userID === emergencyAdministratorID))
          throw new CommandError(
            "conflict",
            "The emergency administrator and your own account must remain available",
          );
        if (disabled) {
          const other = alias(projectMembership, "other");
          const [stranded] = await db
            .select({ projectId: projectMembership.projectId })
            .from(projectMembership)
            .where(
              and(
                eq(projectMembership.userId, userID),
                eq(projectMembership.manageProject, true),
                notExists(
                  db
                    .select({ userId: other.userId })
                    .from(other)
                    .innerJoin(accountAccess, eq(accountAccess.userId, other.userId))
                    .where(
                      and(
                        eq(other.projectId, projectMembership.projectId),
                        ne(other.userId, userID),
                        eq(other.manageProject, true),
                        isNull(accountAccess.disabledAt),
                        isNull(accountAccess.directoryDisabledAt),
                      ),
                    ),
                ),
              ),
            )
            .limit(1);
          if (stranded)
            throw new CommandError(
              "conflict",
              "Assign another Project Manager before disabling this account",
            );
        }
        await db
          .update(accountAccess)
          .set({
            disabledAt: disabled ? expression`now()` : null,
            disabledBy: actorID,
            updatedAt: expression`now()`,
          })
          .where(eq(accountAccess.userId, userID));
        if (disabled) await db.delete(authSession).where(eq(authSession.userId, userID));
      });
    },
    async endSessions(actorID: string, userID: string) {
      await database.client.begin(async (sql) => {
        if (actorID === userID) await requireActiveAccountIn(sql, actorID);
        else await requireSystemManagerIn(sql, actorID);
        const db = drizzleTransaction(sql);
        const [account] = await db
          .select({ userId: accountAccess.userId })
          .from(accountAccess)
          .where(eq(accountAccess.userId, userID))
          .for("update");
        if (!account) throw new CommandError("not-found", "Account not found");
        await db.delete(authSession).where(eq(authSession.userId, userID));
      });
    },
  };
}
