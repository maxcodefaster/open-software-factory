import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { createTicketInput } from "../../ticket-domain/src/ticket";

const result = z.array(z.object({ id: z.uuid() }));

/** The authoritative create command shared by Zero planning and Factory MCP. */
export async function createPlanningTicketIn(
  execute: (statement: SQL) => Promise<unknown>,
  userID: string,
  value: unknown,
) {
  const input = createTicketInput.parse(value);
  const access = z.array(z.object({ allowed: z.boolean() })).parse(
    await execute(sql`
    WITH account AS (SELECT user_id FROM factory.account_access WHERE user_id=${userID}::uuid
      AND disabled_at IS NULL AND directory_disabled_at IS NULL FOR SHARE),
    membership AS (SELECT user_id FROM factory.project_membership
      WHERE project_id=${input.projectId}::uuid AND user_id=${userID}::uuid FOR SHARE),
    project AS (SELECT id FROM factory.project WHERE id=${input.projectId}::uuid FOR SHARE)
    SELECT EXISTS(SELECT 1 FROM project) AND EXISTS(SELECT 1 FROM account) AND
      (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID}::uuid)
       OR EXISTS(SELECT 1 FROM membership)) AS allowed
  `),
  );
  if (!access[0]?.allowed) throw new Error("Project not found");
  const state = input.state ?? "inbox";
  const created = result.parse(
    await execute(sql`
    INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES(${input.id}::uuid,${input.projectId}::uuid,${input.title},${input.description},
        ${state}::factory.ticket_state,${userID}::uuid)
      ON CONFLICT(id) DO NOTHING RETURNING id
  `),
  );
  if (!created.length) {
    const previous = result.parse(
      await execute(sql`
      SELECT id FROM factory.ticket WHERE id=${input.id}::uuid AND project_id=${input.projectId}::uuid
        AND created_by=${userID}::uuid AND title=${input.title} AND description=${input.description}
        AND state=${state}::factory.ticket_state
    `),
    );
    if (!previous.length)
      throw new Error(
        "This draft was already created with different content. Open the saved Ticket.",
      );
  }
  return { id: input.id, projectId: input.projectId, title: input.title, state };
}
