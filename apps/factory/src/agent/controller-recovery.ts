import {
  and,
  asc,
  eq,
  exists,
  sql as expression,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
} from "drizzle-orm";
import {
  agentTurn,
  changeAgentSession,
  changeAgentTurnIntent,
  change as changeTable,
} from "#db/schema";
import type { RuntimeHub } from "../runtime/transport-api";
import {
  type AgentActivity,
  type AgentAdmission,
  type AgentBrowser,
  type AgentCandidates,
  type AgentSessionArchives,
  type AgentStop,
  type AgentTurnStore,
  type AgentUsageJournal,
  type AgentWriters,
  type Database,
  type ExecuteTurn,
  type MonitorTurn,
  type ReconcileStop,
  type RenewExecution,
  type RuntimeController,
  readAgentRow,
} from "./controller-types";
import { createExternalTurnRecovery } from "./recovery-external";

export type StopReconcilerDeps = {
  database: Database;
  stop: AgentStop;
  activity: AgentActivity;
};

export function createStopReconciler(deps: StopReconcilerDeps): ReconcileStop {
  const { database, stop, activity } = deps;
  const stopping = new Set<string>();
  const readyStops = new Set<string>();

  async function reconcileStop(changeID: string, runtimeReady = false, expectedStopID?: string) {
    if (activity.isClosed()) return;
    const target = await readAgentRow(database, changeID);
    if (
      activity.isClosed() ||
      !target?.stopPending ||
      !target.stopID ||
      (expectedStopID && target.stopID !== expectedStopID)
    )
      return;
    if (stopping.has(target.stopID)) {
      // Readiness can arrive while the final old observation still sees a
      // disconnected runtime. Coalesce one follow-up instead of losing it.
      if (runtimeReady) readyStops.add(target.stopID);
      return;
    }
    stopping.add(target.stopID);
    try {
      for (let observation = 0; observation < 5 && !activity.isClosed(); observation += 1) {
        const session = observation === 0 ? target : await readAgentRow(database, changeID);
        if (!session?.stopPending || session.stopID !== target.stopID) return;
        try {
          if (await stop.confirm(changeID, target.stopID)) return;
        } catch {
          /* Keep admission blocked until persisted Stop is confirmed. */
        }
        if (observation < 4 && !activity.isClosed()) await Bun.sleep(1_000);
      }
      if (!activity.isClosed())
        await stop.recordUnconfirmed(changeID, {
          stopID: target.stopID,
          attemptID: target.runtimeAttemptID,
          sessionID: target.sessionID,
        });
    } finally {
      stopping.delete(target.stopID);
      const becameReady = readyStops.delete(target.stopID);
      if (becameReady && !activity.isClosed())
        activity.run(reconcileStop(changeID, false, target.stopID));
    }
  }

  return reconcileStop;
}

export type AgentRecoveryDeps = {
  database: Database;
  hub: RuntimeHub;
  runtime: RuntimeController;
  browser: AgentBrowser | undefined;
  writers: AgentWriters | undefined;
  turns: AgentTurnStore;
  admission: AgentAdmission;
  usageJournal: AgentUsageJournal;
  archives: AgentSessionArchives;
  candidates: AgentCandidates;
  activity: AgentActivity;
  renewExecution: RenewExecution;
  reconcileStop: ReconcileStop;
  monitor: MonitorTurn;
  execute: ExecuteTurn;
  isMonitoring(turnID: string): boolean;
  isStarting(turnID: string): boolean;
  hasRetainedStopSettler: boolean;
};

async function reconcileFailedSessionProjections(database: Database): Promise<void> {
  // Failure settlement and its Session projection can lose their connection
  // independently. Restore only the exact failed Turn's diagnostic state;
  // this neither executes work nor resolves uncertain external outcomes.
  await database.db
    .update(changeAgentSession)
    .set({
      state: "failed",
      lastError: agentTurn.outcomeSummary,
      updatedAt: expression`now()`,
    })
    .from(agentTurn)
    .where(
      and(
        eq(changeAgentSession.activeTurnId, agentTurn.id),
        eq(agentTurn.state, "failed"),
        inArray(changeAgentSession.state, ["starting", "working"]),
        not(changeAgentSession.stopPending),
        eq(agentTurn.changeId, changeAgentSession.changeId),
        exists(
          database.db
            .select({ id: changeAgentTurnIntent.turnId })
            .from(changeAgentTurnIntent)
            .innerJoin(changeTable, eq(changeTable.id, changeAgentTurnIntent.changeId))
            .where(
              and(
                eq(changeTable.id, changeAgentSession.changeId),
                inArray(changeTable.state, ["starting", "active"]),
                eq(changeAgentTurnIntent.turnId, agentTurn.id),
                eq(changeAgentTurnIntent.changeId, changeAgentSession.changeId),
                eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
                eq(changeAgentTurnIntent.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
                eq(changeTable.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
                or(
                  and(
                    eq(changeAgentSession.state, "starting"),
                    isNull(changeAgentSession.activeInboxId),
                  ),
                  and(
                    eq(changeAgentSession.state, "working"),
                    eq(changeAgentSession.activeInboxId, changeAgentTurnIntent.promptId),
                  ),
                ),
              ),
            ),
        ),
      ),
    );
}

export function createAgentRecovery(deps: AgentRecoveryDeps) {
  const {
    database,
    runtime,
    archives,
    candidates,
    activity,
    reconcileStop,
    execute,
    hasRetainedStopSettler,
  } = deps;
  const recoverExternal = createExternalTurnRecovery(deps);

  async function recover() {
    if (activity.isClosed()) return;
    activity.run(archives.savePending());
    await reconcileFailedSessionProjections(database);
    for (const operation of await candidates.pending())
      activity.run(candidates.reconcile(operation.id, true));
    const external = await database.db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          isNotNull(agentTurn.changeId),
          inArray(agentTurn.state, ["dispatching", "running", "uncertain"]),
        ),
      )
      .orderBy(asc(agentTurn.createdAt));
    for (const turn of external) activity.run(recoverExternal(turn.id));
    const pending = await database.db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(and(isNotNull(agentTurn.changeId), eq(agentTurn.state, "pending")))
      .orderBy(asc(agentTurn.createdAt));
    for (const turn of pending) activity.run(execute(turn.id));
    const stopped = await database.db
      .select({ changeID: changeAgentSession.changeId })
      .from(changeAgentSession)
      .where(eq(changeAgentSession.stopPending, true));
    for (const session of stopped) activity.run(reconcileStop(session.changeID));
  }

  // Startup runs before the Connector listener exists. Readiness resumes
  // recorded commits and Stop only, never an inference request or new runtime.
  function recoverRuntimeWork(attemptID: string) {
    activity.run(archives.savePending());
    const work = Promise.all([
      candidates.recoverRuntime(attemptID),
      (async () => {
        const stopped = await database.db
          .select({ changeID: changeAgentSession.changeId })
          .from(changeAgentSession)
          .where(
            and(
              eq(changeAgentSession.runtimeAttemptId, attemptID),
              eq(changeAgentSession.stopPending, true),
            ),
          );
        await Promise.all(stopped.map((session) => reconcileStop(session.changeID, true)));
      })(),
    ]).then(() => {});
    activity.run(work);
    return work;
  }

  async function dispatchRuntimePending(attemptID: string) {
    const pending = await database.db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
      .where(
        and(eq(changeAgentTurnIntent.runtimeAttemptId, attemptID), eq(agentTurn.state, "pending")),
      );
    for (const turn of pending) activity.run(execute(turn.id));
  }

  async function recoverRetainedStops() {
    if (activity.isClosed() || (!hasRetainedStopSettler && !runtime.get)) return;
    const stopped = await database.client<{ changeID: string }[]>`
      SELECT session.change_id AS "changeID" FROM factory.change_agent_session session
      JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
      WHERE session.stop_pending AND (attempt.state IN ('failed','cleanup-failed','stopped')
        OR (${hasRetainedStopSettler} AND attempt.state IN ('paused','starting','pausing'))
        OR (${Boolean(runtime.get)} AND attempt.state='paused'
          AND session.native_session_confirmed_at IS NULL
          AND session.implementation_session_confirmed_at IS NULL
          AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
            WHERE intent.turn_id=session.stop_turn_id AND intent.bootstrap
              AND intent.session_id=session.opencode_session_id
              AND intent.runtime_attempt_id=attempt.id)))`;
    for (const session of stopped) activity.run(reconcileStop(session.changeID));
  }

  async function dispatchReadyPending() {
    activity.run(archives.savePending());
    const pending = await database.client<
      Array<{ id: string }>
    >`SELECT turn.id FROM factory.agent_turn turn
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
      LEFT JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
      WHERE turn.state='pending' AND (
        attempt.state='ready'
        OR (intent.runtime_attempt_id IS NULL AND EXISTS(
          SELECT 1 FROM factory.change_writer writer
          JOIN factory.change change ON change.id=writer.change_id
          JOIN factory.runtime_attempt prepared ON prepared.id=change.runtime_attempt_id
            AND prepared.change_id=change.id AND prepared.project_id=change.project_id
          WHERE writer.change_id=turn.change_id AND writer.turn_id=turn.id
            AND writer.state='agent' AND NOT writer.fence_required AND prepared.state='ready'
        ))
        OR (intent.runtime_attempt_id IS NULL AND EXISTS(
          SELECT 1 FROM factory.change_writer writer
          JOIN factory.runtime_attempt previous ON previous.id=writer.fence_attempt_id
          WHERE writer.change_id=turn.change_id AND writer.turn_id=turn.id
            AND writer.state='agent-preparing' AND writer.fence_required
            AND (previous.state='stopped' OR (previous.state='paused'))
        )))
        AND (turn.owner_token IS NULL OR turn.owner_expires_at<=clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM factory.operation
          WHERE kind='usage.coding_pause' AND scope_type='agent_turn' AND scope_id=turn.id::text
            AND state='paused' AND payload->>'resumedByTurnId' IS NULL)
      ORDER BY turn.created_at LIMIT 16`;
    for (const turn of pending) activity.run(execute(turn.id));
  }

  return {
    recover,
    recoverRuntimeWork,
    dispatchRuntimePending,
    recoverRetainedStops,
    dispatchReadyPending,
  };
}
