import type { createDatabase } from "../../../../packages/db/src/client";
import type { RuntimeHub } from "../runtime/hub";
import {
  cancelQueuedOpenCodeInput,
  confirmSettledOpenCodeInput,
  confirmEmptyOpenCodeSession,
  createOpenCodeClient,
  interruptOpenCodeSession,
} from "./opencode-client";
import { createStopTransport } from "./stop-transport";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";

type Database = ReturnType<typeof createDatabase>;
type StopTarget = { stopID: string | null; turnID: string | null };

export function createChangeAgentStop(database: Database, hub: RuntimeHub) {
  const usage = createRecordedOpenCodeUsage(database);
  async function settleTarget(changeID: string, target: StopTarget) {
    if (!target.turnID) return;
    // Never hold Change while waiting on Turn: execution locks Turn first.
    // A delayed caller can affect only the Turn captured when its Stop began.
    await database.client`UPDATE factory.agent_turn SET state = 'stopped',
      owner_token = NULL, owner_expires_at = NULL,
      outcome_summary = 'Stopped by the user', updated_at = now()
      WHERE id = ${target.turnID} AND change_id = ${changeID}
        AND state IN ('pending', 'dispatching', 'running', 'uncertain')`;
  }

  return {
    async persist(changeID: string) {
      // Admission locks Change/Ticket before reading the barrier. Publish it
      // without waiting for any Turn lock: execution locks Turn before Change.
      const target = await database.client.begin(async (sql) => {
        await sql`SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
          WHERE change.id = ${changeID} FOR UPDATE OF change, ticket`;
        // A pending admission may not yet have prepared the Session.
        const turns = await sql<Array<{ id: string }>>`SELECT id FROM factory.agent_turn
          WHERE change_id = ${changeID} AND state IN ('pending', 'dispatching', 'running', 'uncertain')
          ORDER BY created_at DESC LIMIT 1`;
        const rows = await sql<
          StopTarget[]
        >`UPDATE factory.change_agent_session SET state = 'stopped',
          stop_id = CASE WHEN stop_pending THEN stop_id ELSE ${crypto.randomUUID()}::uuid END,
          stop_turn_id = CASE WHEN stop_pending THEN stop_turn_id ELSE ${turns[0]?.id ?? null}::uuid END,
          stop_pending = true, active_inbox_id = NULL, updated_at = now()
          WHERE change_id = ${changeID} AND (stop_pending OR state <> 'stopped' OR ${turns[0]?.id ?? null}::uuid IS NOT NULL)
          RETURNING stop_id AS "stopID", stop_turn_id AS "turnID"`;
        return rows[0] ?? { stopID: null, turnID: turns[0]?.id ?? null };
      });
      await settleTarget(changeID, target);
    },

    async recordUnconfirmed(
      changeID: string,
      target: { stopID: string; attemptID: string; sessionID: string | null },
    ) {
      // One compact recovery outcome after the observer's finite budget, not
      // persistent polling history. A late observer cannot overwrite a new Stop.
      await database.client`UPDATE factory.change_agent_session session SET
        last_error = 'Stop remains unconfirmed. The last confirmation check ended without confirmation. ' || CASE
          WHEN change.runtime_attempt_id IS DISTINCT FROM session.runtime_attempt_id
            OR (intent.runtime_attempt_id IS NOT NULL AND intent.runtime_attempt_id <> session.runtime_attempt_id)
            THEN 'The stopped input belongs to a different Workspace generation; its outcome still needs confirmation.'
          WHEN attempt.state = 'stopped' AND intent.runtime_attempt_id IS NOT NULL
            THEN 'Stopped compute cannot prove that assigned input was canceled. Restarting alone does not confirm Stop.'
          WHEN session.opencode_session_id IS NULL
            THEN 'The OpenCode Session is not yet identifiable; its create outcome still needs confirmation.'
          WHEN attempt.state <> 'ready' OR NOT ${hub.connected(target.attemptID)}
            THEN 'Live Workspace status is unavailable; execution and queued input still need confirmation.'
          WHEN NOT session.stop_dispatched
            THEN 'Interruption has not been dispatched. A read-only check will not send it.'
          ELSE 'Ordered history has not proved that execution and queued input are settled.'
        END, updated_at = now()
        FROM factory.change change, factory.runtime_attempt attempt,
          factory.change_agent_session current
          LEFT JOIN factory.change_agent_turn_intent intent ON intent.turn_id = current.stop_turn_id
        WHERE session.change_id = ${changeID} AND current.change_id = session.change_id
          AND change.id = session.change_id AND attempt.id = session.runtime_attempt_id
          AND session.state = 'stopped' AND session.stop_pending AND session.stop_id = ${target.stopID}
          AND session.runtime_attempt_id = ${target.attemptID}
          AND session.opencode_session_id IS NOT DISTINCT FROM ${target.sessionID}`;
    },

    async confirm(
      changeID: string,
      expectedStopID?: string,
      mode: "interrupt" | "observe" = "interrupt",
    ) {
      const rows = await database.client<
        Array<
          StopTarget & {
            attemptID: string;
            sessionID: string | null;
            runtimeState: string;
            dispatched: boolean;
            promptID: string | null;
            intentAttemptID: string | null;
            currentAttemptID: string | null;
            bootstrap: boolean | null;
            intendedSessionID: string | null;
            sessionConfirmed: boolean;
          }
        >
      >`SELECT session.runtime_attempt_id AS "attemptID", session.opencode_session_id AS "sessionID",
        attempt.state AS "runtimeState", session.stop_dispatched AS dispatched,
        session.stop_id AS "stopID", session.stop_turn_id AS "turnID",
        intent.prompt_id AS "promptID", intent.runtime_attempt_id AS "intentAttemptID",
        change.runtime_attempt_id AS "currentAttemptID",intent.bootstrap,
        intent.session_id AS "intendedSessionID",
        session.native_session_confirmed_at IS NOT NULL AS "sessionConfirmed"
        FROM factory.change_agent_session session
        JOIN factory.runtime_attempt attempt ON attempt.id = session.runtime_attempt_id
        JOIN factory.change change ON change.id = session.change_id
        LEFT JOIN factory.change_agent_turn_intent intent ON intent.turn_id = session.stop_turn_id
        WHERE session.change_id = ${changeID} AND session.state = 'stopped' AND session.stop_pending
          AND (${expectedStopID ?? null}::uuid IS NULL OR session.stop_id = ${expectedStopID ?? null})`;
      const current = rows[0];
      if (!current) return true;
      // Recovery fences the captured Turn after a crash between publication
      // and settlement. Admission remains blocked throughout.
      await settleTarget(changeID, current);
      if (current.currentAttemptID !== current.attemptID) return false;
      // A fresh Session cannot receive its prompt before native confirmation
      // is durable. Stop fences late confirmation. With exact compute teardown,
      // an unconfirmed bootstrap therefore has no queued input to cancel.
      // Reused or confirmed Sessions still require native history.
      const unsubmittedBootstrap =
        current.runtimeState === "stopped" &&
        current.bootstrap === true &&
        !current.sessionConfirmed &&
        current.sessionID === current.intendedSessionID;
      // OpenCode's queued state survives compute suspension. Destruction of a
      // runtime is not evidence that an assigned input has been removed.
      if (current.runtimeState === "stopped" && current.intentAttemptID && !unsubmittedBootstrap)
        return false;
      if (current.intentAttemptID && current.intentAttemptID !== current.attemptID) return false;
      if (current.runtimeState !== "stopped") {
        if (mode === "observe" && !current.dispatched) return false;
        if (
          !current.stopID ||
          !current.sessionID ||
          current.runtimeState !== "ready" ||
          !hub.connected(current.attemptID)
        )
          return false;
        const transport = createStopTransport(database, hub, {
          changeID,
          stopID: current.stopID,
          attemptID: current.attemptID,
          sessionID: current.sessionID,
        });
        const client = createOpenCodeClient((request, path) => {
          if (mode === "observe" && !["GET", "HEAD"].includes(request.method))
            throw new Error("Stop confirmation cannot mutate OpenCode");
          return transport(request, path);
        });
        let absent = false;
        if (current.dispatched) {
          const confirmed =
            (await confirmEmptyOpenCodeSession(client, current.sessionID)) ||
            (current.promptID &&
              current.intentAttemptID &&
              (await confirmSettledOpenCodeInput(client, current.sessionID, current.promptID)));
          if (!confirmed) return false;
        } else {
          // Commit the CAS before HTTP. It elects one dispatcher without holding
          // a pool connection. Unknown external outcomes are never replayed.
          const dispatched = await database.client<Array<{ id: string }>>`
          UPDATE factory.change_agent_session SET stop_dispatched = true, updated_at = now()
          WHERE change_id = ${changeID} AND state = 'stopped' AND stop_pending AND NOT stop_dispatched
            AND stop_id = ${current.stopID} AND runtime_attempt_id = ${current.attemptID}
            AND opencode_session_id IS NOT DISTINCT FROM ${current.sessionID}
          RETURNING change_id AS id`;
          if (!dispatched[0]) return false;
          const interruption = await interruptOpenCodeSession(client, current.sessionID);
          if (interruption === "unconfirmed") return false;
          absent = interruption === "absent";
          if (interruption !== "absent" && current.promptID && current.intentAttemptID) {
            if (!(await cancelQueuedOpenCodeInput(client, current.sessionID, current.promptID)))
              return false;
          }
        }
        if (current.turnID) {
          if (!absent) await usage.drain(current.turnID, client, current.sessionID);
          await usage.settle(current.turnID, "interrupted");
        }
      }
      return database.client.begin(async (sql) => {
        // Serialize proof publication with runtime replacement and admission.
        // No external I/O or Turn lock is held while Change is locked.
        const changes = await sql<Array<{ id: string }>>`SELECT id FROM factory.change
          WHERE id = ${changeID} AND runtime_attempt_id = ${current.attemptID} FOR UPDATE`;
        if (!changes[0]) return false;
        const confirmed = await sql<Array<{ id: string }>>`
        UPDATE factory.change_agent_session SET stop_pending = false, stop_dispatched = false,
          last_error = NULL,
          updated_at = now()
        WHERE change_id = ${changeID} AND state = 'stopped' AND stop_pending
          AND stop_id IS NOT DISTINCT FROM ${current.stopID} AND runtime_attempt_id = ${current.attemptID}
          AND opencode_session_id IS NOT DISTINCT FROM ${current.sessionID}
          AND (NOT ${unsubmittedBootstrap} OR native_session_confirmed_at IS NULL)
        RETURNING change_id AS id`;
        return confirmed.length === 1;
      });
    },
  };
}
