import { unknownCounters } from "../../../../packages/conversation-domain/src/usage";
import type { createDatabase } from "../../../../packages/db/src/client";
import { type createOpenCodeClient, listOpenCodeSessionTree } from "../agent/opencode-client";
import { createContractRates } from "./contract-rates";
import { createUsageJournal } from "./journal";
import { drainOpenCodeUsage } from "./opencode";

type Database = ReturnType<typeof createDatabase>;
type Client = ReturnType<typeof createOpenCodeClient>;

export function createRecordedOpenCodeUsage(database: Database) {
  const journal = createUsageJournal(database);
  async function drain(turnID: string, client: Client, root: string) {
    const operationID = `turn:${turnID}`;
    const admitted =
      await database.client`SELECT id FROM factory.usage_operation WHERE id=${operationID}`;
    if (!admitted.length) return;
    const [next] = await database.client<Array<{ id: string; created_at: Date }>>`
      SELECT operation.id,operation.created_at FROM factory.usage_operation operation
      JOIN factory.change_agent_turn_intent intent ON operation.id='turn:'||intent.turn_id
      JOIN factory.usage_operation current ON current.id=${operationID}
      JOIN factory.change_agent_turn_intent current_intent ON current_intent.turn_id::text=substring(current.id from 6)
      WHERE intent.change_id=current_intent.change_id AND operation.created_at>current.created_at
      ORDER BY operation.created_at LIMIT 1`;
    for (const sessionID of await listOpenCodeSessionTree(client, root)) {
      const [boundary] = next
        ? await database.client<
            Array<{ start_sequence: string }>
          >`SELECT start_sequence FROM factory.usage_replay_cursor WHERE operation_id=${next.id} AND session_id=${sessionID}`
        : [];
      const ceiling = boundary ? Number(boundary.start_sequence) : null;
      await drainOpenCodeUsage({
        sessionID,
        after: await journal.cursor(operationID, sessionID),
        log: (after) =>
          client.session.log(
            { sessionID, after, follow: false },
            { signal: AbortSignal.timeout(5000) },
          ),
        record: (entry, sequence) => {
          if (
            (ceiling !== null && sequence > ceiling) ||
            (next &&
              !boundary &&
              Date.parse(entry.occurredAt) >= new Date(next.created_at).getTime())
          )
            return Promise.resolve();
          return journal.record(operationID, entry, { sessionID, sequence });
        },
        advance: (sequence) =>
          journal.advance(
            operationID,
            sessionID,
            ceiling === null ? sequence : Math.min(sequence, ceiling),
          ),
      });
    }
  }
  return {
    drain,
    async prepare(turnID: string, client: Client, root: string) {
      const operationID = `turn:${turnID}`;
      const existing =
        await database.client`SELECT id FROM factory.usage_operation WHERE id=${operationID}`;
      if (existing.length) return;
      const [turn] = await database.client<
        Array<{
          project_id: string;
          created_by: string;
          provider: string | null;
          model: string;
        }>
      >`SELECT turn.project_id,turn.created_by,connection.provider,
        turn.authority->>'modelId' AS model FROM factory.agent_turn turn
        LEFT JOIN factory.model_connection_version connection
          ON connection.connection_id=(turn.authority->'modelConnection'->>'connectionID')::uuid
          AND connection.version=(turn.authority->'modelConnection'->>'version')::bigint
        WHERE turn.id=${turnID}`;
      if (!turn) throw new Error("Usage needs an admitted Build turn");
      const provider = turn.provider ?? "openai";
      // Finish the previous owner before freezing the next turn's baseline, including late titles.
      const previous = await database.client<Array<{ turn_id: string }>>`
        SELECT intent.turn_id FROM factory.change_agent_turn_intent intent
        JOIN factory.usage_operation operation ON operation.id='turn:'||intent.turn_id
        JOIN factory.change_agent_turn_intent current ON current.turn_id=${turnID}
        WHERE intent.change_id=current.change_id AND intent.session_id=${root} AND intent.turn_id<>${turnID}
        ORDER BY operation.created_at DESC LIMIT 1`;
      if (previous[0]) await drain(previous[0].turn_id, client, root);
      // Capture prior Session watermarks before this turn can dispatch paid inference.
      const baselines: Array<{ sessionID: string; sequence: number }> = [];
      for (const sessionID of await listOpenCodeSessionTree(client, root)) {
        const sequence = await drainOpenCodeUsage({
          sessionID,
          after: 0,
          log: (after) =>
            client.session.log(
              { sessionID, after, follow: false },
              { signal: AbortSignal.timeout(5000) },
            ),
          record: async () => {},
          advance: async () => {},
        });
        baselines.push({ sessionID, sequence });
      }
      await journal.begin(
        {
          id: operationID,
          projectID: turn.project_id,
          userID: turn.created_by,
          purpose: "coding",
          engine: "opencode",
          provider,
          model: turn.model,
          rate: await createContractRates(database).get(provider, turn.model),
        },
        baselines,
      );
    },
    async settle(
      turnID: string,
      outcome: "completed" | "failed" | "interrupted" | "unknown",
      locallyDenied = false,
    ) {
      const operationID = `turn:${turnID}`;
      const [operation] = await database.client<Array<{ created_at: Date }>>`
        SELECT created_at FROM factory.usage_operation WHERE id=${operationID} AND settled_at IS NULL`;
      if (!operation) return;
      if (outcome !== "completed" && !locallyDenied)
        await journal.record(operationID, {
          eventID: "unobserved",
          source: "unobserved",
          outcome,
          counters: unknownCounters(),
          occurredAt: new Date(operation.created_at).toISOString(),
        });
      await journal.settle(operationID, outcome);
    },
    async drainAttempt(attemptID: string, client: Client) {
      const pending = await database.client<Array<{ turn_id: string; session_id: string }>>`
        SELECT intent.turn_id,intent.session_id FROM factory.change_agent_turn_intent intent
        JOIN factory.usage_operation operation ON operation.id='turn:'||intent.turn_id
        WHERE intent.runtime_attempt_id=${attemptID} ORDER BY operation.created_at`;
      for (const input of pending) await drain(input.turn_id, client, input.session_id);
    },
    async markUnavailable(attemptID: string) {
      const pending = await database.client<Array<{ id: string; created_at: Date }>>`
        SELECT operation.id,operation.created_at FROM factory.change_agent_turn_intent intent
        JOIN factory.usage_operation operation ON operation.id='turn:'||intent.turn_id
        WHERE intent.runtime_attempt_id=${attemptID}`;
      for (const operation of pending) {
        await journal.record(operation.id, {
          eventID: "storage-unavailable",
          source: "unobserved",
          outcome: "unknown",
          counters: unknownCounters(),
          occurredAt: new Date(operation.created_at).toISOString(),
        });
        await journal.settle(operation.id, "unknown");
      }
    },
  };
}
