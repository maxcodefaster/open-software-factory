import type { createDatabase } from "../../../../packages/db/src/client";
import type { ComputeClass } from "../../../../packages/runtime-domain/src/compute";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import type { ExecutionReserve } from "../runtime/reserve-controller";
import { admitComputeIn, ComputeCapacityError } from "./compute";
import { codingBudgetIn } from "./policy";

type Database = ReturnType<typeof createDatabase>;
export function createComputeWait(database: Database, reserve?: ExecutionReserve) {
  return {
    async launch<T>(attemptID: string, create: () => Promise<T>) {
      return database.client.begin(async (sql) => {
        const [attempt] = await sql<
          Array<{
            projectID: string;
            userID: string;
            personal: boolean;
            changeID: string | null;
            state: string;
            stopped: boolean;
            coding: boolean;
          }>
        >`
          SELECT attempt.project_id AS "projectID",attempt.created_by AS "userID",
            coalesce(workspace.kind='personal',false) AS personal,
            coalesce(attempt.change_id,verification.change_id) AS "changeID",attempt.state,
            attempt.stop_intended_at IS NOT NULL AS stopped,attempt.change_id IS NOT NULL AS coding
          FROM factory.runtime_attempt attempt
          LEFT JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
          LEFT JOIN factory.verification verification ON verification.id=attempt.verification_id
          WHERE attempt.id=${attemptID}`;
        if (!attempt || attempt.state !== "create-intended" || attempt.stopped) return undefined;
        if (attempt.changeID) {
          await sql`SELECT id FROM factory.agent_turn WHERE change_id=${attempt.changeID} AND state='pending' ORDER BY created_at LIMIT 1 FOR UPDATE`;
          await lockChangeWriterIn(sql, attempt.changeID);
        }
        // Keep current account/membership grants locked through the external create.
        // Revocation serializes here; it cannot leave a stale capacity grant launching work.
        try {
          await (attempt.personal ? projectDevelopmentAuthorityIn : projectAuthorityIn)(
            sql,
            attempt.userID,
            attempt.projectID,
          );
        } catch (cause) {
          if (!(cause instanceof CommandError)) throw cause;
          await sql`UPDATE factory.runtime_attempt SET state='stop-intended',stop_intended_at=now(),updated_at=now() WHERE id=${attemptID}`;
          return undefined;
        }
        if (
          (
            await sql`SELECT attempt_id FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`
          ).length
        )
          return undefined;
        if (attempt.changeID) {
          const [active] =
            await sql`SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id=change.ticket_id
            WHERE change.id=${attempt.changeID} AND change.state IN ('starting','active') AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=change.id AND
                (stop_pending OR (state='stopped' AND NOT EXISTS(
                  SELECT 1 FROM factory.change_writer WHERE change_id=change.id AND state='human'
                ))))`;
          if (!active) return undefined;
          // CI runs no inference. Its subsequent automatic repair is separately budgeted.
          if (!attempt.coding) return create();
          const budget = await codingBudgetIn(sql, attempt.projectID, true);
          if (!budget.allowed) {
            await sql`INSERT INTO factory.runtime_compute_wait(attempt_id,reason) VALUES(${attemptID},${budget.reason})
              ON CONFLICT(attempt_id) DO UPDATE SET reason=EXCLUDED.reason`;
            const [turn] = await sql<
              Array<{ id: string }>
            >`SELECT id FROM factory.agent_turn WHERE change_id=${attempt.changeID} AND state='pending' ORDER BY created_at LIMIT 1`;
            if (turn)
              await sql`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${turn.id},${budget.reason})
              ON CONFLICT(turn_id) DO UPDATE SET reason=EXCLUDED.reason,resumed_by_turn_id=NULL,created_at=now()`;
            return undefined;
          }
          if (
            (
              await sql`SELECT pause.turn_id FROM factory.coding_pause pause JOIN factory.agent_turn turn ON turn.id=pause.turn_id
            WHERE turn.change_id=${attempt.changeID} AND pause.resumed_by_turn_id IS NULL`
            ).length
          )
            return undefined;
        }
        return create();
      });
    },
    async admit(attemptID: string) {
      return database.client.begin(async (sql) => {
        const [target] = await sql<
          Array<{ projectID: string; userID: string; changeID: string | null; personal: boolean }>
        >`
          SELECT attempt.project_id AS "projectID",attempt.created_by AS "userID",coalesce(attempt.change_id,verification.change_id) AS "changeID",
            coalesce(workspace.kind='personal',false) AS personal FROM factory.runtime_attempt attempt
          LEFT JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
          LEFT JOIN factory.verification verification ON verification.id=attempt.verification_id WHERE attempt.id=${attemptID}`;
        if (!target) return false;
        if (target.changeID) {
          await sql`SELECT id FROM factory.agent_turn WHERE change_id=${target.changeID} AND state='pending' ORDER BY created_at LIMIT 1 FOR UPDATE`;
          await lockChangeWriterIn(sql, target.changeID);
        }
        let authorized = true;
        try {
          await (target.personal ? projectDevelopmentAuthorityIn : projectAuthorityIn)(
            sql,
            target.userID,
            target.projectID,
          );
        } catch (cause) {
          if (!(cause instanceof CommandError)) throw cause;
          authorized = false;
        }
        await sql`SELECT pg_advisory_xact_lock(hashtext('factory-usage-admission'))`;
        await sql`SELECT pg_advisory_xact_lock(hashtext('factory-execution-capacity'))`;
        const [attempt] = await sql<
          Array<{
            projectID: string;
            userID: string;
            changeID: string | null;
            personal: boolean;
            kind: ComputeClass;
            state: string;
            stopped: boolean;
            coding: boolean;
          }>
        >`
          SELECT attempt.project_id AS "projectID",attempt.created_by AS "userID",coalesce(attempt.change_id,verification.change_id) AS "changeID",
            coalesce(workspace.kind='personal',false) AS personal,coalesce(attempt.isolated_kind::text,'development') AS kind,
            attempt.state,attempt.stop_intended_at IS NOT NULL AS stopped,attempt.change_id IS NOT NULL AS coding
          FROM factory.runtime_compute_wait waiting JOIN factory.runtime_attempt attempt ON attempt.id=waiting.attempt_id
          LEFT JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
          LEFT JOIN factory.verification verification ON verification.id=attempt.verification_id
          WHERE attempt.id=${attemptID} FOR UPDATE OF attempt,waiting`;
        if (!attempt) return false;
        if (attempt.state !== "create-intended" || attempt.stopped) {
          await sql`DELETE FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`;
          return false;
        }
        if (!authorized) {
          await sql`UPDATE factory.runtime_attempt SET state='stop-intended',stop_intended_at=now(),updated_at=now() WHERE id=${attemptID}`;
          await sql`DELETE FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`;
          return false;
        }
        if (attempt.changeID) {
          const [current] =
            await sql`SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id=change.ticket_id
            WHERE change.id=${attempt.changeID} AND change.state IN ('starting','active') AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=change.id AND
                (stop_pending OR (state='stopped' AND NOT EXISTS(
                  SELECT 1 FROM factory.change_writer WHERE change_id=change.id AND state='human'
                ))))`;
          if (!current) {
            await sql`UPDATE factory.runtime_attempt SET state='stop-intended',stop_intended_at=now(),updated_at=now() WHERE id=${attemptID}`;
            await sql`DELETE FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`;
            return false;
          }
          const budget = attempt.coding
            ? await codingBudgetIn(sql, attempt.projectID, true)
            : { allowed: true, reason: null };
          if (!budget.allowed) {
            await sql`UPDATE factory.runtime_compute_wait SET reason=${budget.reason} WHERE attempt_id=${attemptID}`;
            const [turn] = await sql<
              Array<{ id: string }>
            >`SELECT id FROM factory.agent_turn WHERE change_id=${attempt.changeID} AND state='pending' ORDER BY created_at LIMIT 1`;
            if (turn)
              await sql`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${turn.id},${budget.reason})
                ON CONFLICT(turn_id) DO UPDATE SET reason=EXCLUDED.reason,resumed_by_turn_id=NULL,created_at=now()`;
            return false;
          }
          if (
            attempt.coding &&
            (
              await sql`SELECT pause.turn_id FROM factory.coding_pause pause JOIN factory.agent_turn turn ON turn.id=pause.turn_id
            WHERE turn.change_id=${attempt.changeID} AND pause.resumed_by_turn_id IS NULL`
            ).length
          )
            return false;
        }
        try {
          if (reserve)
            await reserve.admit(sql, attemptID, undefined, {
              projectID: attempt.projectID,
              kind: attempt.kind,
            });
          else await admitComputeIn(sql, attempt.projectID, attempt.kind);
        } catch (cause) {
          if (!(cause instanceof ComputeCapacityError)) throw cause;
          return false;
        }
        await sql`DELETE FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`;
        await sql`UPDATE factory.project_image_preparation SET updated_at=now() WHERE runtime_attempt_id=${attemptID} AND state='running'`;
        return true;
      });
    },
  };
}
