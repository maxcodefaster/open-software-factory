import { and, eq, inArray, isNull, lte, or, sql as expression } from "drizzle-orm";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import { agentTurn, installationMaintenance } from "../../../../packages/db/src/schema";
import { confirmUndispatchedReviewStopsIn } from "../agent/stop";
import { createAgentTurnStore } from "../agent/turn-store";
import { createUsageJournal } from "../usage/journal";

type Database = ReturnType<typeof createDatabase>;
export type RetainedMaintenanceStop = {
  changeID: string;
  stopID: string;
  attemptID: string;
  workspaceID: string;
  projectID: string;
};

export async function installationInMaintenance(database: Database) {
  const [state] = await database.db
    .select({ enabled: installationMaintenance.enabled })
    .from(installationMaintenance)
    .where(eq(installationMaintenance.singleton, true));
  if (!state) throw new Error("Installation maintenance state is unavailable");
  return state.enabled;
}

export async function beginInstallationMaintenance(
  database: Database,
  observePausedStop?: (
    sql: DatabaseTransaction,
    target: RetainedMaintenanceStop,
  ) => Promise<boolean>,
) {
  // Older processes could leave a dispatched Project turn behind after losing
  // its lease. Reconcile only that already-expired Project execution, through
  // the normal recovery boundary. This neither retries inference nor stops a
  // live owner. The fenced admission check below still rejects all active work.
  const expired = await database.db
    .select({ id: agentTurn.id })
    .from(agentTurn)
    .where(
      and(
        isNull(agentTurn.changeId),
        inArray(agentTurn.state, ["dispatching", "running"]),
        or(
          isNull(agentTurn.ownerToken),
          lte(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
        ),
      ),
    );
  const turns = createAgentTurnStore(database);
  const usage = createUsageJournal(database);
  for (const { id } of expired)
    if (await turns.quarantineExpiredProject(id)) await usage.abandon(`turn:${id}`);
  await database.client.begin(async (sql) => {
    const [state] = await drizzleTransaction(sql)
      .update(installationMaintenance)
      .set({ enabled: true, requestedAt: expression`now()` })
      .where(eq(installationMaintenance.singleton, true))
      .returning({ singleton: installationMaintenance.singleton });
    if (!state) throw new Error("Installation maintenance state is unavailable");
    // Only the same pure, fenced no-input proof used by normal Stop. Never
    // interrupt native work or equate an unknown Session with an empty one.
    // A later rejection rolls this publication back with the admission fence.
    await confirmUndispatchedReviewStopsIn(sql);
    const retained: RetainedMaintenanceStop[] = [];
    if (observePausedStop) {
      const paused = await sql<RetainedMaintenanceStop[]>`
        SELECT session.change_id AS "changeID",session.stop_id AS "stopID",
          attempt.id AS "attemptID",attempt.workspace_id AS "workspaceID",
          attempt.project_id AS "projectID"
        FROM factory.change_agent_session session
        JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
        WHERE session.state='stopped' AND session.stop_pending AND session.stop_id IS NOT NULL
          AND attempt.state='paused' AND attempt.workspace_id IS NOT NULL
        ORDER BY attempt.workspace_id,session.change_id`;
      for (const target of paused) {
        // Native lifecycle owns this same lock. Never wait for it while holding
        // the installation admission fence, or use a cached pause as live proof.
        const [lock] = await sql<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${`runtime:${target.workspaceID}`})) AS acquired`;
        if (lock?.acquired && (await observePausedStop(sql, target))) retained.push(target);
      }
    }
    const [work] = await sql<{ active: boolean }[]>`
      SELECT
        EXISTS(SELECT 1 FROM factory.agent_turn WHERE state IN ('pending','dispatching','running')
          OR (change_id IS NOT NULL AND state='uncertain'))
        OR EXISTS(SELECT 1 FROM factory.knowledge_generation WHERE state IN ('pending','running'))
        OR EXISTS(SELECT 1 FROM factory.model_role_probe WHERE state='probing')
        OR EXISTS(SELECT 1 FROM factory.project_setup_inspection WHERE state IN ('inspecting','confirming'))
        OR EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE stop_pending
          AND NOT EXISTS(
            SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(retained)}::text::jsonb)
              AS retained("changeID" uuid,"stopID" uuid,"attemptID" uuid)
            WHERE retained."changeID"=session.change_id AND retained."stopID"=session.stop_id
              AND retained."attemptID"=session.runtime_attempt_id))
        OR EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE state NOT IN ('succeeded','failed'))
        AS active`;
    if (work?.active)
      throw new Error(
        "Finish or explicitly stop active and unresolved work before upgrading. The running installation was not changed.",
      );
  });
}

export async function finishInstallationMaintenance(database: Database) {
  await database.db
    .update(installationMaintenance)
    .set({ enabled: false, requestedAt: null })
    .where(eq(installationMaintenance.singleton, true));
}
