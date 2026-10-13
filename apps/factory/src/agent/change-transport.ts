import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/hub";
import { createAgentTurnStore } from "./turn-store";

// Factory serializes the frame send with persisted Stop, not the HTTP response.
// The Connector then retains that order through admission and control loss.
export function createChangeAgentTransport(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  attemptID: string,
  turnID: string,
  ownerToken: string,
) {
  const turns = createAgentTurnStore(database);
  return (request: Request, path: string) =>
    hub.request(
      attemptID,
      "agent",
      request,
      path,
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : async (send) => {
            const allowed = await turns.validateExecution(turnID, ownerToken, async (sql) => {
              const queryStarted = performance.now();
              const current = await sql<Array<{ id: string; leaseRemainingMS: number }>>`
                SELECT intent.turn_id AS id,
                  EXTRACT(EPOCH FROM (turn.owner_expires_at - clock_timestamp()))::float8 * 1000 AS "leaseRemainingMS"
                FROM factory.change_agent_turn_intent intent
                JOIN factory.agent_turn turn ON turn.id = intent.turn_id
                JOIN factory.change change ON change.id = intent.change_id
                JOIN factory.change_agent_session session ON session.change_id = change.id
                JOIN factory.runtime_attempt attempt ON attempt.id = intent.runtime_attempt_id
                JOIN factory.change_writer writer ON writer.change_id=change.id AND writer.state='agent' AND writer.turn_id=turn.id
                WHERE intent.turn_id = ${turnID} AND intent.runtime_attempt_id = ${attemptID}
                  AND turn.owner_token = ${ownerToken} AND turn.owner_expires_at > clock_timestamp()
                  AND turn.state IN ('pending', 'dispatching', 'running')
                  AND change.runtime_attempt_id = ${attemptID} AND attempt.state = 'ready'
                  AND session.runtime_attempt_id = ${attemptID} AND session.active_turn_id = ${turnID}
                  AND session.opencode_session_id = intent.session_id
                  AND session.state IN ('starting', 'working', 'failed') AND NOT session.stop_pending`;
              // Include SQL/result delivery time conservatively. This uses the
              // database lease clock without assuming the app clock matches it.
              if (!current[0] || performance.now() - queryStarted >= current[0].leaseRemainingMS)
                throw new CommandError(
                  "conflict",
                  "Build runtime authority changed before dispatch",
                );
              send();
            });
            if (!allowed)
              throw new CommandError("conflict", "Build authority changed before dispatch");
          },
    );
}
