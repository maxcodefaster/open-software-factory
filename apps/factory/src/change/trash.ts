import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

type TrashRuntime = { stop(id: string): Promise<unknown> };
type TrashAgent = { stop(id: string): Promise<unknown> };
type TrashVerification = { stopForTrash(id: string): Promise<void> };

export function createTicketTrashController(
  database: ReturnType<typeof createDatabase>,
  runtime: TrashRuntime,
  agent: TrashAgent,
  verification: TrashVerification,
) {
  const running = new Set<string>();
  let closed = false;
  async function reconcile(ticketID: string) {
    if (closed || running.has(ticketID)) return;
    running.add(ticketID);
    try {
      // Outside the Ticket transaction: Turn settlement locks Turn before Ticket.
      await database.client`UPDATE factory.agent_turn SET state = 'stopped', owner_token = NULL,
        owner_expires_at = NULL, outcome_summary = 'Ticket moved to Trash.', updated_at = now()
        WHERE ticket_id = ${ticketID} AND change_id IS NULL AND state IN ('pending', 'dispatching', 'running')`;
      const changes = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.change WHERE ticket_id = ${ticketID}`;
      for (const change of changes) await agent.stop(change.id);
      for (const change of changes) await verification.stopForTrash(change.id);
      const attempts = await database.client<Array<{ id: string }>>`
        SELECT attempt.id FROM factory.runtime_attempt attempt
        LEFT JOIN factory.development_workspace workspace ON workspace.id = attempt.workspace_id
        LEFT JOIN factory.verification verification ON verification.id = attempt.verification_id
        JOIN factory.change change ON change.id = COALESCE(attempt.change_id, verification.change_id)
        WHERE change.ticket_id = ${ticketID} AND (workspace.kind = 'ticket' OR attempt.isolated_kind = 'verification')
          AND attempt.state <> 'stopped'`;
      for (const attempt of attempts) await runtime.stop(attempt.id);
      for (let observation = 0; observation < 60 && !closed; observation += 1) {
        const [work] = await database.client`
          SELECT attempt.id FROM factory.runtime_attempt attempt
          LEFT JOIN factory.development_workspace workspace ON workspace.id = attempt.workspace_id
          LEFT JOIN factory.verification verification ON verification.id = attempt.verification_id
          JOIN factory.change change ON change.id = COALESCE(attempt.change_id, verification.change_id)
          WHERE change.ticket_id = ${ticketID} AND (workspace.kind = 'ticket' OR attempt.isolated_kind = 'verification')
            AND attempt.state <> 'stopped' LIMIT 1`;
        if (!work) {
          await database.client`UPDATE factory.ticket SET trash_stop_pending = false, trash_error = NULL WHERE id = ${ticketID} AND trashed_at IS NOT NULL`;
          return;
        }
        await Bun.sleep(1_000);
      }
      if (!closed)
        throw new Error("Workspace stop is not confirmed. Retry stopping before restoring.");
    } catch {
      if (!closed)
        await database.client`UPDATE factory.ticket SET trash_error = 'Workspace stop is not confirmed. Retry stopping before restoring.' WHERE id = ${ticketID} AND trashed_at IS NOT NULL`;
    } finally {
      running.delete(ticketID);
    }
  }
  return {
    async trash(ticketID: string, userID: string) {
      await database.client.begin(async (sql) => {
        // Match admission's Change/Ticket barrier without locking a Turn.
        await sql`SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id WHERE ticket.id = ${ticketID} FOR UPDATE OF change, ticket`;
        const [ticket] = await sql<
          Array<{ projectID: string }>
        >`SELECT project_id AS "projectID" FROM factory.ticket WHERE id = ${ticketID} FOR UPDATE`;
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        const [delivery] =
          await sql`SELECT id FROM factory.change WHERE ticket_id = ${ticketID} AND state = 'delivering'`;
        if (delivery)
          throw new CommandError(
            "conflict",
            "Wait for the approved Delivery to finish before moving this Ticket to Trash",
          );
        await sql`UPDATE factory.ticket SET trashed_at = COALESCE(trashed_at, now()), trashed_by = COALESCE(trashed_by, ${userID}),
          version = CASE WHEN trashed_at IS NULL THEN version + 1 ELSE version END,
          trash_stop_pending = true, trash_error = NULL, updated_at = now() WHERE id = ${ticketID}`;
        await sql`UPDATE factory.verification SET state = 'cancelled', completed_at = COALESCE(completed_at, now()), updated_at = now()
          WHERE change_id IN (SELECT id FROM factory.change WHERE ticket_id = ${ticketID})
            AND state IN ('pending', 'runner-starting', 'running')`;
      });
      void reconcile(ticketID);
    },
    async restore(ticketID: string, userID: string, expectedVersion: number) {
      return database.client.begin(async (sql) => {
        const [ticket] = await sql<
          Array<{ projectID: string; pending: boolean; version: number }>
        >`SELECT project_id AS "projectID", trash_stop_pending AS pending, version::integer AS version FROM factory.ticket WHERE id = ${ticketID} FOR UPDATE`;
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        if (ticket.version !== expectedVersion)
          throw new CommandError("conflict", "Ticket changed. Refresh Trash before restoring.");
        if (ticket.pending)
          throw new CommandError(
            "conflict",
            "Wait for Workspace stop confirmation before restoring",
          );
        await sql`UPDATE factory.ticket SET trashed_at = NULL, trashed_by = NULL, trash_error = NULL, version = version + 1, updated_at = now() WHERE id = ${ticketID} AND trashed_at IS NOT NULL`;
      });
    },
    async recover() {
      const tickets = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.ticket WHERE trashed_at IS NOT NULL AND trash_stop_pending`;
      for (const ticket of tickets) void reconcile(ticket.id);
    },
    close() {
      closed = true;
    },
  };
}
