import { and, asc, eq, sql as expression, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, changeAgentSession, operation, runtimeAttempt } from "#db/schema";
import { confirmUndispatchedReviewStopsIn } from "../agent/runtime-api";
import { createAgentTurnStore } from "../agent/turns-api";
import { createUsageJournal } from "../usage/journal-api";

const INSTALLATION_MAINTENANCE_KIND = "installation.maintenance";
const INSTALLATION_MAINTENANCE_KEY = "installation.maintenance:singleton";

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
    .select({ state: operation.state })
    .from(operation)
    .where(
      and(
        eq(operation.kind, INSTALLATION_MAINTENANCE_KIND),
        eq(operation.idempotencyKey, INSTALLATION_MAINTENANCE_KEY),
      ),
    );
  if (!state) throw new Error("Installation maintenance state is unavailable");
  return state.state === "enabled";
}

export async function beginInstallationMaintenance(
  database: Database,
  observeRetainedStop?: (
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
      .update(operation)
      .set({
        state: "enabled",
        payload: expression`jsonb_build_object('singleton', true, 'enabled', true, 'requestedAt', now())`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.kind, INSTALLATION_MAINTENANCE_KIND),
          eq(operation.idempotencyKey, INSTALLATION_MAINTENANCE_KEY),
        ),
      )
      .returning({ id: operation.id });
    if (!state) throw new Error("Installation maintenance state is unavailable");
    // Only the same pure, fenced no-input proof used by normal Stop. Never
    // interrupt native work or equate an unknown Session with an empty one.
    // A later rejection rolls this publication back with the admission fence.
    await confirmUndispatchedReviewStopsIn(sql);
    const retained: RetainedMaintenanceStop[] = [];
    if (observeRetainedStop) {
      const candidates: RetainedMaintenanceStop[] = await drizzleTransaction(sql)
        .select({
          changeID: changeAgentSession.changeId,
          stopID: expression<string>`${changeAgentSession.stopId}`,
          attemptID: runtimeAttempt.id,
          workspaceID: expression<string>`${runtimeAttempt.workspaceId}`,
          projectID: runtimeAttempt.projectId,
        })
        .from(changeAgentSession)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
        .where(
          and(
            eq(changeAgentSession.state, "stopped"),
            eq(changeAgentSession.stopPending, true),
            isNotNull(changeAgentSession.stopId),
            inArray(runtimeAttempt.state, ["paused", "ready"]),
            isNotNull(runtimeAttempt.workspaceId),
          ),
        )
        .orderBy(asc(runtimeAttempt.workspaceId), asc(changeAgentSession.changeId));
      for (const target of candidates) {
        // Native lifecycle owns this same lock. Never wait for it while holding
        // the installation admission fence, or use cached state as native proof.
        const [lock] = await sql<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${`runtime:${target.workspaceID}`})) AS acquired`;
        if (lock?.acquired && (await observeRetainedStop(sql, target))) retained.push(target);
      }
    }
    const [work] = await sql<{ active: boolean }[]>`
      SELECT
        EXISTS(SELECT 1 FROM factory.agent_turn WHERE state IN ('pending','dispatching','running')
          OR (change_id IS NOT NULL AND state='uncertain'))
        OR EXISTS(SELECT 1 FROM factory.operation WHERE kind='knowledge.generation' AND state IN ('pending','running'))
        OR EXISTS(SELECT 1 FROM factory.operation WHERE kind='models.role_probe' AND state='probing')
        OR EXISTS(SELECT 1 FROM factory.operation WHERE kind='project.setup_inspection' AND state IN ('inspecting','confirming'))
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
    .update(operation)
    .set({
      state: "disabled",
      payload: { singleton: true, enabled: false, requestedAt: null },
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(operation.kind, INSTALLATION_MAINTENANCE_KIND),
        eq(operation.idempotencyKey, INSTALLATION_MAINTENANCE_KEY),
      ),
    );
}
