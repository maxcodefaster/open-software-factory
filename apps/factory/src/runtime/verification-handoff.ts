import type { createDatabase } from "../../../../packages/db/src/client";
import type { RuntimeHub } from "./hub";

type Database = ReturnType<typeof createDatabase>;

// A submitted Agent Sandbox is not an input for fresh Verification. Record its
// ordinary Stop only when Verification has selected that SAME worker, then wait
// for its original cleanup result. Remote capacity never stops work on A.
export async function prepareVerificationHandoff(
  database: Database,
  hub: Pick<RuntimeHub, "claimIdle" | "releaseIdle">,
  verificationID: string,
  destinationWorkerID?: string,
): Promise<{ ready: boolean; stopAttemptID?: string }> {
  let claimed: string | undefined;
  let recorded = false;
  try {
    const result = await database.client.begin(async (sql) => {
      const [scope] = await sql<{ changeID: string; projectID: string }[]>`
        SELECT change.id AS "changeID",change.project_id AS "projectID"
        FROM factory.verification verification
        JOIN factory.change change ON change.id=verification.change_id
        WHERE verification.id=${verificationID}`;
      if (!scope) return { ready: false };
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${scope.projectID}`}))`;
      await sql`SELECT change.id FROM factory.change change
        JOIN factory.ticket ticket ON ticket.id=change.ticket_id
        WHERE change.id=${scope.changeID} FOR UPDATE OF change,ticket`;
      const [current] = await sql<
        {
          attemptID: string | null;
          state: string | null;
          verificationAttemptID: string | null;
          verificationState: string;
          workerID: string | null;
        }[]
      >`
        SELECT attempt.id AS "attemptID",attempt.state,attempt.factorybox_worker_id AS "workerID",
          verification.runtime_attempt_id AS "verificationAttemptID",
          verification.state AS "verificationState"
        FROM factory.verification verification
        JOIN factory.change change ON change.id=verification.change_id
        JOIN factory.ticket ticket ON ticket.id=change.ticket_id
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id=change.runtime_attempt_id
          AND attempt.change_id=change.id AND attempt.workspace_id IS NOT NULL
        WHERE verification.id=${verificationID}
          AND verification.state IN ('pending','runner-starting','running')
          AND change.state='active' AND change.cancel_requested_at IS NULL
          AND ticket.trashed_at IS NULL FOR UPDATE OF verification`;
      if (!current) return { ready: false };
      if (destinationWorkerID && current.workerID !== destinationWorkerID) return { ready: true };
      if (current.verificationAttemptID && current.verificationState === "running")
        return { ready: true };
      if (!current.attemptID || current.state === "stopped") return { ready: true };
      if (["stop-intended", "stopping", "cleanup-failed"].includes(current.state ?? ""))
        return { ready: false };
      if (current.state !== "ready") return { ready: true };
      const [work] = await sql<{ active: boolean; submitted: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${scope.changeID}
          AND state IN ('pending','dispatching','running','uncertain'))
          OR EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=${scope.changeID}
            AND (state IN ('starting','working') OR stop_pending))
          OR EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=${scope.changeID}
            AND state NOT IN ('succeeded','failed')) AS active,
           (EXISTS(SELECT 1 FROM factory.workspace_submission receipt
             JOIN factory.change_commit_operation submitted ON submitted.id=receipt.id
             JOIN factory.verification verification ON verification.change_id=submitted.change_id
             JOIN factory.change_writer writer ON writer.change_id=submitted.change_id
             WHERE submitted.change_id=${scope.changeID} AND verification.id=${verificationID}
               AND submitted.state='succeeded' AND submitted.commit_sha=verification.commit_sha
               AND submitted.runtime_attempt_id=${current.attemptID} AND writer.state='unassigned') OR EXISTS(SELECT 1 FROM factory.change_agent_session session
            JOIN factory.change_writer writer ON writer.change_id=session.change_id
            JOIN factory.agent_turn turn ON turn.id=session.active_turn_id
              AND turn.change_id=session.change_id
            JOIN factory.verification verification ON verification.change_id=session.change_id
            JOIN LATERAL (SELECT commit_sha,runtime_attempt_id FROM factory.change_commit_operation
              WHERE change_id=session.change_id AND state='succeeded'
              ORDER BY sequence DESC LIMIT 1) submitted ON true
            WHERE session.change_id=${scope.changeID} AND verification.id=${verificationID}
              AND session.state='committed' AND NOT session.stop_pending AND turn.state='completed'
              AND (writer.state='unassigned' OR (writer.state='agent' AND writer.turn_id=turn.id))
              AND submitted.commit_sha=verification.commit_sha
              AND (session.runtime_attempt_id=${current.attemptID}
                 OR submitted.runtime_attempt_id=${current.attemptID}))) AS submitted`;
      // An active or unrelated writer is never reclaimed for this purpose.
      // Existing admission rules still own independently commissioned execution.
      if (work?.active || !work?.submitted) return { ready: true };
      if (!hub.claimIdle(current.attemptID, 0)) return { ready: false };
      claimed = current.attemptID;
      const [intent] = await sql<{ id: string }[]>`
        UPDATE factory.runtime_attempt SET state='stop-intended',
          stop_intended_at=COALESCE(stop_intended_at,now()),updated_at=now()
        WHERE id=${current.attemptID} AND state='ready' RETURNING id`;
      if (!intent) return { ready: false };
      return { ready: false, stopAttemptID: intent.id };
    });
    recorded = result.stopAttemptID !== undefined;
    return result;
  } finally {
    if (claimed && !recorded) hub.releaseIdle(claimed);
  }
}
