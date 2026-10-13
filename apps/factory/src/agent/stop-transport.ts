import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/hub";

// Recovery may confirm Stop while its original dispatcher is still awaiting a
// connection/body. Serialize the actual send with that exact pending Stop.
export function createStopTransport(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  target: { changeID: string; stopID: string; attemptID: string; sessionID: string },
) {
  return (request: Request, path: string) =>
    hub.request(
      target.attemptID,
      "agent",
      request,
      path,
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : async (send) => {
            await database.client.begin(async (sql) => {
              const current = await sql<Array<{ id: string }>>`SELECT session.change_id AS id
          FROM factory.change_agent_session session
          JOIN factory.change change ON change.id = session.change_id
          JOIN factory.runtime_attempt attempt ON attempt.id = session.runtime_attempt_id
          WHERE session.change_id = ${target.changeID} AND session.state = 'stopped'
            AND session.stop_pending AND session.stop_dispatched AND session.stop_id = ${target.stopID}
            AND session.runtime_attempt_id = ${target.attemptID} AND change.runtime_attempt_id = ${target.attemptID}
            AND session.opencode_session_id = ${target.sessionID} AND attempt.state = 'ready'
          FOR UPDATE OF session`;
              if (!current[0])
                throw new CommandError("conflict", "Stop authority changed before dispatch");
              send();
            });
          },
    );
}
