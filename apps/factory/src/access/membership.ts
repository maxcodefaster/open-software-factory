import type { createDatabase } from "../../../../packages/db/src/client";
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
      const [target] =
        "email" in input.target
          ? await sql<
              Array<{ id: string }>
            >`SELECT id FROM auth."user" WHERE email=${input.target.email.toLowerCase()} FOR SHARE`
          : await sql<
              Array<{ id: string }>
            >`SELECT id FROM auth."user" WHERE id=${input.target.userID} FOR SHARE`;
      if (!target) throw new CommandError("not-found", "Account not found");
      const [previous] = await sql<
        Membership[]
      >`SELECT user_id AS "userId",role,manage_project AS "manageProject"
        FROM factory.project_membership WHERE project_id=${input.projectID} AND user_id=${target.id} FOR UPDATE`;
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
        const [other] = await sql`SELECT member.user_id FROM factory.project_membership member
          LEFT JOIN factory.account_access access ON access.user_id=member.user_id
          WHERE member.project_id=${input.projectID} AND member.user_id<>${target.id}
            AND member.manage_project AND access.disabled_at IS NULL
            AND access.directory_disabled_at IS NULL LIMIT 1`;
        if (!other)
          throw new CommandError(
            "conflict",
            "Assign another Project Manager before removing the last one",
          );
      }
      if (!setting) {
        await sql`DELETE FROM factory.project_membership WHERE project_id=${input.projectID} AND user_id=${target.id}`;
        return null;
      }
      const [saved] = await sql<
        Membership[]
      >`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${input.projectID},${target.id},${setting.role},${setting.manageProject},${input.actorID})
        ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role,manage_project=EXCLUDED.manage_project,
          updated_by=EXCLUDED.updated_by,updated_at=now()
        RETURNING user_id AS "userId",role,manage_project AS "manageProject"`;
      if (!saved) throw new CommandError("conflict", "Project membership was not saved");
      return saved;
    });
  }
  return { change };
}
