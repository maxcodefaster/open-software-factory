import { and, eq, inArray, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentSession,
  changeAgentTurnIntent,
  change as changeTable,
  runtimeAttempt,
} from "#db/schema";
import type { RuntimeHub } from "../runtime/transport-api";
import type { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import {
  cancelQueuedOpenCodeInput,
  confirmEmptyOpenCodeSession,
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  interruptOpenCodeSession,
} from "./opencode-adapter";
import {
  type Database,
  pendingStopSessionPredicate,
  type RetainedStopTarget,
  type StopCandidate,
  type StopConfirmationProof,
} from "./stop-state";
import { createStopTransport } from "./stop-transport";

type OpenCodeUsageRecorder = ReturnType<typeof createRecordedOpenCodeUsage>;

export async function readPendingStopCandidate(
  database: Database,
  changeID: string,
  expectedStopID?: string,
): Promise<StopCandidate | undefined> {
  const rows = await database.db
    .select({
      attemptID: changeAgentSession.runtimeAttemptId,
      sessionID: changeAgentSession.opencodeSessionId,
      runtimeState: runtimeAttempt.state,
      dispatched: changeAgentSession.stopDispatched,
      stopID: changeAgentSession.stopId,
      turnID: changeAgentSession.stopTurnId,
      promptID: changeAgentTurnIntent.promptId,
      intentAttemptID: changeAgentTurnIntent.runtimeAttemptId,
      currentAttemptID: changeTable.runtimeAttemptId,
      bootstrap: changeAgentTurnIntent.bootstrap,
      intendedSessionID: changeAgentTurnIntent.sessionId,
      sessionConfirmed: query<boolean>`${changeAgentSession.nativeSessionConfirmedAt} IS NOT NULL`,
      implementationConfirmed: query<boolean>`${changeAgentSession.implementationSessionConfirmedAt} IS NOT NULL`,
      turnState: agentTurn.state,
    })
    .from(changeAgentSession)
    .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
    .innerJoin(changeTable, eq(changeTable.id, changeAgentSession.changeId))
    .leftJoin(
      changeAgentTurnIntent,
      eq(changeAgentTurnIntent.turnId, changeAgentSession.stopTurnId),
    )
    .leftJoin(agentTurn, eq(agentTurn.id, changeAgentSession.stopTurnId))
    .where(pendingStopSessionPredicate(changeID, { stopID: expectedStopID }));
  return rows[0];
}

export async function dispatchLiveStop(
  database: Database,
  hub: RuntimeHub,
  usage: OpenCodeUsageRecorder,
  changeID: string,
  current: StopCandidate,
  mode: RetainedStopTarget["mode"],
): Promise<boolean> {
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
    const dispatched = await database.db
      .update(changeAgentSession)
      .set({
        stopDispatched: true,
        updatedAt: query`now()`,
      })
      .where(
        pendingStopSessionPredicate(changeID, {
          dispatched: false,
          stopID: current.stopID,
          attemptID: current.attemptID,
          sessionID: current.sessionID,
          matchSessionID: true,
        }),
      )
      .returning({ id: changeAgentSession.changeId });
    if (!dispatched[0]) return false;
    const interruption = await interruptOpenCodeSession(client, current.sessionID);
    if (interruption === "unconfirmed") return false;
    absent = interruption === "absent";
    if (interruption !== "absent" && current.promptID && current.intentAttemptID) {
      if (!(await cancelQueuedOpenCodeInput(client, current.sessionID, current.promptID)))
        return false;
    }
    if (
      !absent &&
      !(await confirmSettledOpenCodeInput(client, current.sessionID, current.promptID ?? ""))
    )
      return false;
  }
  if (current.turnID && current.turnState === "stopped") {
    if (!absent) await usage.drain(current.turnID, client, current.sessionID);
    await usage.settle(current.turnID, "interrupted");
  }
  return true;
}

export async function commitStopConfirmation(
  database: Database,
  changeID: string,
  current: StopCandidate,
  proof: StopConfirmationProof,
): Promise<boolean> {
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    // Serialize proof publication with runtime replacement and admission.
    // No external I/O or Turn lock is held while Change is locked.
    const changes = await db
      .select({ id: changeTable.id })
      .from(changeTable)
      .where(and(eq(changeTable.id, changeID), eq(changeTable.runtimeAttemptId, current.attemptID)))
      .for("update");
    if (!changes[0]) return false;
    if (proof.pausedBootstrap) {
      const [paused] = await db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .where(
          and(
            eq(runtimeAttempt.id, current.attemptID),
            eq(runtimeAttempt.changeId, changeID),
            eq(runtimeAttempt.state, "paused"),
          ),
        );
      if (!paused) return false;
    }
    if (proof.retainedSettled) {
      const [stopped] = await db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .where(
          and(
            eq(runtimeAttempt.id, current.attemptID),
            inArray(runtimeAttempt.state, ["stopped", "paused"]),
          ),
        );
      if (!stopped) return false;
    }
    const confirmed = await db
      .update(changeAgentSession)
      .set({
        stopPending: false,
        stopDispatched: false,
        lastError: null,
        updatedAt: query`now()`,
      })
      .where(
        pendingStopSessionPredicate(changeID, {
          stopID: current.stopID,
          matchNullStopID: true,
          attemptID: current.attemptID,
          sessionID: current.sessionID,
          matchSessionID: true,
          requireUnconfirmedNative: proof.unsubmittedBootstrap,
          requireUnconfirmedImplementation: proof.pausedBootstrap,
        }),
      )
      .returning({ id: changeAgentSession.changeId });
    return confirmed.length === 1;
  });
}

export async function recordUnconfirmedStop(
  database: Database,
  hub: RuntimeHub,
  changeID: string,
  target: { stopID: string; attemptID: string; sessionID: string | null },
): Promise<void> {
  // One compact recovery outcome after the observer's finite budget, not
  // persistent polling history. A late observer cannot overwrite a new Stop.
  const current = alias(changeAgentSession, "current");
  await database.db
    .update(changeAgentSession)
    .set({
      lastError: query`'Stop remains unconfirmed. The last confirmation check ended without confirmation. ' || CASE
          WHEN ${changeTable.runtimeAttemptId} IS DISTINCT FROM ${changeAgentSession.runtimeAttemptId}
            OR (${changeAgentTurnIntent.runtimeAttemptId} IS NOT NULL AND ${changeAgentTurnIntent.runtimeAttemptId} <> ${changeAgentSession.runtimeAttemptId})
            THEN 'The stopped input belongs to a different Workspace generation; its outcome still needs confirmation.'
          WHEN ${runtimeAttempt.state} = 'stopped' AND ${changeAgentTurnIntent.runtimeAttemptId} IS NOT NULL
            THEN 'Stopped compute cannot prove that assigned input was canceled. Restarting alone does not confirm Stop.'
          WHEN ${runtimeAttempt.state} = 'paused' AND ${changeAgentTurnIntent.runtimeAttemptId} IS NOT NULL
            THEN 'Paused compute retains assigned input. A durable Source checkpoint does not confirm its cancellation.'
          WHEN ${changeAgentSession.opencodeSessionId} IS NULL
            THEN 'The OpenCode Session is not yet identifiable; its create outcome still needs confirmation.'
          WHEN ${runtimeAttempt.state} <> 'ready' OR NOT ${hub.connected(target.attemptID)}
            THEN 'Live Workspace status is unavailable; execution and queued input still need confirmation.'
          WHEN NOT ${changeAgentSession.stopDispatched}
            THEN 'Interruption has not been dispatched. A read-only check will not send it.'
          ELSE 'Ordered history has not proved that execution and queued input are settled.'
        END`,
      updatedAt: query`now()`,
    })
    .from(changeTable)
    .innerJoin(current, eq(current.changeId, changeTable.id))
    .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, current.runtimeAttemptId))
    .leftJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, current.stopTurnId))
    .where(
      and(
        pendingStopSessionPredicate(changeID, {
          stopID: target.stopID,
          attemptID: target.attemptID,
          sessionID: target.sessionID,
          matchSessionID: true,
        }),
        eq(current.changeId, changeAgentSession.changeId),
        eq(changeTable.id, changeAgentSession.changeId),
        eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId),
      ),
    );
}
