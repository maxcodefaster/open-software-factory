import { and, eq, sql as expression, isNull, ne } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { accountAccess, authUser, projectMembership } from "../../../../packages/db/src/schema";
import type { ProjectRole } from "../../../../packages/project-domain/src/access";
import { CommandError } from "../command-error";
import { projectAuthorityIn, requireActiveAccountIn } from "./controller";

type Database = ReturnType<typeof createDatabase>;
type Membership = { userId: string; role: ProjectRole; manageProject: boolean };

export function createMembershipCommands(database: Database) {
  async function change(input: {
    projectID: string;
    actorID: string;
    target: { email: string; role: ProjectRole; manageProject: boolean } | { userID: string };
  }): Promise<Membership | null> {
    return database.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project-membership:${input.projectID}`},0))`;
      await projectAuthorityIn(sql, input.actorID, input.projectID, true);
      const db = drizzleTransaction(sql);
      const [target] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(
          "email" in input.target
            ? eq(authUser.email, input.target.email.toLowerCase())
            : eq(authUser.id, input.target.userID),
        )
        .for("share");
      if (!target) throw new CommandError("not-found", "Account not found");
      const membershipFields = {
        userId: projectMembership.userId,
        role: projectMembership.role,
        manageProject: projectMembership.manageProject,
      };
      const targetMembership = and(
        eq(projectMembership.projectId, input.projectID),
        eq(projectMembership.userId, target.id),
      );
      const [previous] = await db
        .select(membershipFields)
        .from(projectMembership)
        .where(targetMembership)
        .for("update");
      const setting = "email" in input.target ? input.target : null;
      if (setting) {
        await requireActiveAccountIn(sql, target.id);
        if (
          target.id === input.actorID &&
          setting.role === "developer" &&
          previous?.role !== "developer"
        )
          throw new CommandError(
            "forbidden",
            "Another Project Manager must grant Developer access",
          );
      }
      if (previous?.manageProject && !setting?.manageProject) {
        const [other] = await db
          .select({ userId: projectMembership.userId })
          .from(projectMembership)
          .leftJoin(accountAccess, eq(accountAccess.userId, projectMembership.userId))
          .where(
            and(
              eq(projectMembership.projectId, input.projectID),
              ne(projectMembership.userId, target.id),
              eq(projectMembership.manageProject, true),
              isNull(accountAccess.disabledAt),
              isNull(accountAccess.directoryDisabledAt),
            ),
          )
          .limit(1);
        if (!other)
          throw new CommandError(
            "conflict",
            "Assign another Project Manager before removing the last one",
          );
      }
      if (!setting) {
        await db.delete(projectMembership).where(targetMembership);
        return null;
      }
      const [saved] = await db
        .insert(projectMembership)
        .values({
          projectId: input.projectID,
          userId: target.id,
          role: setting.role,
          manageProject: setting.manageProject,
          updatedBy: input.actorID,
        })
        .onConflictDoUpdate({
          target: [projectMembership.projectId, projectMembership.userId],
          set: {
            role: setting.role,
            manageProject: setting.manageProject,
            updatedBy: input.actorID,
            updatedAt: expression`now()`,
          },
        })
        .returning(membershipFields);
      if (!saved) throw new CommandError("conflict", "Project membership was not saved");
      return saved;
    });
  }
  return { change };
}
