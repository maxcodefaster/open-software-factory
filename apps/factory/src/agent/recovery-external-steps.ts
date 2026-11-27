import { and, eq, exists, sql as expression, gt, ne, not } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { agentTurn, changeAgentSession } from "#db/schema";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import {
  type AgentActivity,
  type AgentTurnStore,
  type AgentUsageJournal,
  type Database,
  readAgentRow,
  readCurrentChange,
} from "./controller-types";
import { bounded, readableError } from "./native-errors";
import { ensureOpenCodeMessageBoundary, promptRecordedOpenCodeInput } from "./opencode-adapter";
import type { AgentIntent, OpenCodeClient } from "./turn-lifecycle";
import type { AgentTurnRecord } from "./turn-record";

export async function claimTurnForRecovery(
  turns: AgentTurnStore,
  activity: Pick<AgentActivity, "isClosed">,
  turnID: string,
): Promise<AgentTurnRecord | null> {
  // A restarted Factory may arrive before the dead process's lease expires.
  // Wait for that lease, never infer process death merely from startup.
  for (let observation = 0; observation < 60 && !activity.isClosed(); observation += 1) {
    const current = await turns.get(turnID);
    if (!current || !["dispatching", "running", "uncertain"].includes(current.state)) return null;
    const owned = await turns.claimExternalRecovery(turnID);
    if (owned) return owned;
    await Bun.sleep(1_000);
  }
  return null;
}

export async function restoreTerminalSession(params: {
  turns: AgentTurnStore;
  changeID: string;
  turnID: string;
  ownerToken: string;
  attemptID: string;
  intent: AgentIntent;
}): Promise<boolean> {
  const { turns, changeID, turnID, ownerToken, attemptID, intent } = params;
  // A durable terminal observation closes inference, including after
  // process loss. Do not re-admit/wake its input or recreate grants.
  let restored = false;
  const allowed = await turns.validateExecution(turnID, ownerToken, async (sql) => {
    const db = drizzleTransaction(sql);
    const rows = await db
      .update(changeAgentSession)
      .set({
        state: "working",
        lastError: null,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(changeAgentSession.changeId, changeID),
          eq(changeAgentSession.activeTurnId, turnID),
          eq(changeAgentSession.activeInboxId, intent.promptID),
          ne(changeAgentSession.state, "stopped"),
          not(changeAgentSession.stopPending),
          expression`${changeAgentSession.runtimeAttemptId} = ${attemptID}::uuid`,
          eq(changeAgentSession.opencodeSessionId, intent.sessionID),
          exists(
            db
              .select({ id: agentTurn.id })
              .from(agentTurn)
              .where(
                and(
                  eq(agentTurn.id, turnID),
                  eq(agentTurn.state, "running"),
                  eq(agentTurn.ownerToken, ownerToken),
                  gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
                ),
              ),
          ),
        ),
      )
      .returning({ id: changeAgentSession.changeId });
    restored = rows.length === 1;
  });
  return allowed && restored;
}

export async function admitOrWakeMissingInput(params: {
  database: Database;
  hub: RuntimeHub;
  turns: AgentTurnStore;
  usageJournal: AgentUsageJournal;
  client: OpenCodeClient;
  changeID: string;
  turnID: string;
  ownerToken: string;
  attemptID: string;
  intent: AgentIntent;
  queueWakeRequested: boolean;
}): Promise<{ woke: boolean }> {
  const {
    database,
    hub,
    turns,
    usageJournal,
    client,
    changeID,
    turnID,
    ownerToken,
    attemptID,
    intent,
    queueWakeRequested,
  } = params;
  // The exact deterministic admission may still be queued, or dispatch
  // may have stopped before admission. This endpoint can admit missing
  // input, so revalidate execution rather than treating it as a read.
  if (!(await turns.validateExecution(turnID, ownerToken)))
    throw new CommandError("conflict", "Build authority changed before queue admission");
  await ensureOpenCodeMessageBoundary(client, intent.sessionID);
  await usageJournal.prepare(turnID, client, intent.sessionID);
  const admitted = await promptRecordedOpenCodeInput(client, intent, false);
  if (admitted.state === "queued" && !queueWakeRequested) {
    const latest = await readCurrentChange(database, changeID);
    const latestSession = await readAgentRow(database, changeID);
    if (
      latest.runtimeAttemptID !== attemptID ||
      latest.runtimeState !== "ready" ||
      latestSession?.activeTurnID !== turnID ||
      latestSession.sessionID !== intent.sessionID ||
      latestSession.state === "stopped" ||
      !hub.connected(attemptID) ||
      !(await turns.validateExecution(turnID, ownerToken))
    )
      throw new CommandError("conflict", "Build authority changed before queue wake");
    // Pinned wake drains pending input only. It is not the explicit
    // Session resume that can force another provider attempt. Reusing
    // the exact ID also cannot add a second input if promotion races us.
    await promptRecordedOpenCodeInput(client, intent, true);
    return { woke: true };
  }
  return { woke: false };
}

export async function restoreObservedSession(params: {
  database: Database;
  changeID: string;
  turnID: string;
  ownerToken: string;
  attemptID: string;
  intent: AgentIntent;
}): Promise<boolean> {
  const { database, changeID, turnID, ownerToken, attemptID, intent } = params;
  const restored = await database.db
    .update(changeAgentSession)
    .set({
      state: "working",
      activeInboxId: intent.promptID,
      lastError: null,
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(changeAgentSession.changeId, changeID),
        eq(changeAgentSession.activeTurnId, turnID),
        ne(changeAgentSession.state, "stopped"),
        eq(changeAgentSession.runtimeAttemptId, attemptID),
        eq(changeAgentSession.opencodeSessionId, intent.sessionID),
        exists(
          database.db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.id, turnID),
                eq(agentTurn.state, "running"),
                eq(agentTurn.ownerToken, ownerToken),
                gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
              ),
            ),
        ),
      ),
    )
    .returning({ id: changeAgentSession.changeId });
  return Boolean(restored[0]);
}

export async function settleUncertainRecovery(params: {
  database: Database;
  turns: AgentTurnStore;
  activity: Pick<AgentActivity, "isClosed">;
  turnID: string;
  owned: AgentTurnRecord | null;
  cause: unknown;
}): Promise<void> {
  const { database, turns, activity, turnID, owned, cause } = params;
  if (activity.isClosed()) return;
  if (!owned?.ownerToken || !("changeId" in owned.command)) return;
  const summary = bounded(readableError(cause), 2_000);
  if (await turns.settle(turnID, owned.ownerToken, "uncertain", summary)) {
    await database.db
      .update(changeAgentSession)
      .set({ state: "failed", lastError: summary, updatedAt: expression`now()` })
      .where(
        and(
          eq(changeAgentSession.changeId, owned.command.changeId),
          eq(changeAgentSession.activeTurnId, turnID),
          ne(changeAgentSession.state, "stopped"),
          exists(
            database.db
              .select({ id: agentTurn.id })
              .from(agentTurn)
              .where(and(eq(agentTurn.id, turnID), eq(agentTurn.state, "uncertain"))),
          ),
        ),
      );
  }
}
