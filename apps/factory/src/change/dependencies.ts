import type { DatabaseTransaction } from "#db/client";
import type { PrerequisiteView } from "#ticket-domain/dependency";
import { CommandError } from "../command-error";

// Call after acquiring the dependent Ticket lock and checking Project access.
export async function requireDeliveredPrerequisites(
  sql: DatabaseTransaction,
  projectID: string,
  ticketID: string,
) {
  const prerequisites = await sql<PrerequisiteView[]>`
    SELECT prerequisite_id AS id, title, state, delivered
    FROM factory.ticket_prerequisites(${projectID}::uuid, ${ticketID}::uuid)
  `;
  const blockers = prerequisites.filter((prerequisite) => !prerequisite.delivered);
  if (blockers.length)
    throw new CommandError(
      "conflict",
      `Prerequisites must be delivered before implementation: ${blockers.map((blocker) => blocker.title).join(", ")}`,
    );
}
