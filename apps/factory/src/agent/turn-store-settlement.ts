import { and, eq, sql as expression, notExists } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, changeAgentSession } from "#db/schema";
import { CommandError } from "../command-error";
import { codingBudgetIn } from "../usage/api";
import {
  currentAuthorityIn,
  lockTurnChangeIn,
  pauseCodingTurnIn,
  resumeCodingTurnIn,
} from "./turn-store-coding";
import {
  assertCodingPauseReason,
  assertOutcomeSummary,
  type Database,
  DISPATCHED_TURN_STATES,
  toTurnRecord,
  turnLeasePredicate,
} from "./turn-store-types";

export async function resumePendingTurnIn(
  database: Database,
  sql: DatabaseTransaction,
  id: string,
) {
  await lockTurnChangeIn(sql, id);
  const db = drizzleTransaction(sql);
  const [row] = await db
    .select()
    .from(agentTurn)
    .where(and(eq(agentTurn.id, id), eq(agentTurn.state, "pending")))
    .for("update");
  if (!row || !(await currentAuthorityIn(database, sql, toTurnRecord(row)))) {
    throw new CommandError("conflict", "Paused work no longer has execution authority");
  }
  const budget = await codingBudgetIn(sql, toTurnRecord(row).command.projectId, true);
  if (!budget.allowed) {
    throw new CommandError(
      "conflict",
      "Increase the Coding allowance or wait for its monthly reset before resuming",
    );
  }
  await resumeCodingTurnIn(db, id);
  return id;
}

export async function beginTurnDispatch(database: Database, id: string, ownerToken: string) {
  return database.client.begin(async (sql) => {
    await lockTurnChangeIn(sql, id);
    const db = drizzleTransaction(sql);
    const livePending = turnLeasePredicate(id, "pending", { kind: "live", ownerToken });
    const owned = await db.select().from(agentTurn).where(livePending).for("update");
    if (!owned[0] || !(await currentAuthorityIn(database, sql, toTurnRecord(owned[0])))) {
      return null;
    }
    const record = toTurnRecord(owned[0]);
    if (record.authority.mode === "build") {
      const budget = await codingBudgetIn(sql, record.command.projectId, true);
      if (!budget.allowed) {
        await pauseCodingTurnIn(db, id, assertCodingPauseReason(budget.reason));
        return null;
      }
    }
    const rows = await db
      .update(agentTurn)
      .set({ state: "dispatching", updatedAt: expression`now()` })
      .where(livePending)
      .returning();
    return rows[0] ? toTurnRecord(rows[0]) : null;
  });
}

export async function failPendingTurn(
  database: Database,
  id: string,
  ownerToken: string,
  summary: string,
) {
  assertOutcomeSummary(summary);
  const rows = await database.db
    .update(agentTurn)
    .set({
      state: "failed",
      outcomeSummary: summary,
      ownerToken: null,
      ownerExpiresAt: null,
      updatedAt: expression`now()`,
    })
    .where(turnLeasePredicate(id, "pending", { kind: "live", ownerToken }))
    .returning({ id: agentTurn.id });
  return rows.length === 1;
}

export async function failRevokedPendingPreparationTurn(
  database: Database,
  id: string,
  ownerToken: string,
  summary: string,
) {
  assertOutcomeSummary(summary);
  return database.client.begin(async (sql) => {
    await lockTurnChangeIn(sql, id);
    const db = drizzleTransaction(sql);
    const livePending = turnLeasePredicate(id, "pending", { kind: "live", ownerToken });
    const [owned] = await db.select().from(agentTurn).where(livePending).for("update");
    if (!owned) return false;
    const record = toTurnRecord(owned);
    if (
      record.authority.mode !== "build" ||
      !("changeId" in record.command) ||
      (await currentAuthorityIn(database, sql, record, true))
    ) {
      return false;
    }
    // A Source/predecessor fence can legitimately wait. Record only revoked
    // admission authority, and let every published Stop settle its own Turn.
    const failed = await db
      .update(agentTurn)
      .set({
        state: "failed",
        outcomeSummary: summary,
        ownerToken: null,
        ownerExpiresAt: null,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          livePending,
          notExists(
            db
              .select({ id: changeAgentSession.changeId })
              .from(changeAgentSession)
              .where(
                and(
                  eq(changeAgentSession.changeId, record.command.changeId),
                  eq(changeAgentSession.stopPending, true),
                ),
              ),
          ),
        ),
      )
      .returning({ id: agentTurn.id });
    return failed.length === 1;
  });
}

// Only the worker whose runtime startup has rejected may record this
// never-bound input's failure after lease loss. This grants no execution
// authority, renews no lease and cannot settle another owner's preparation.
export async function failUnboundStartupTurn(
  database: Database,
  id: string,
  ownerToken: string,
  summary: string,
) {
  assertOutcomeSummary(summary);
  return database.client.begin(async (sql) => {
    await lockTurnChangeIn(sql, id);
    const [owned] = await drizzleTransaction(sql)
      .select()
      .from(agentTurn)
      .where(turnLeasePredicate(id, "pending", { kind: "expired-owner", ownerToken }))
      .for("update");
    if (!owned) return false;
    const record = toTurnRecord(owned);
    if (
      record.authority.mode !== "build" ||
      !("changeId" in record.command) ||
      !(await currentAuthorityIn(database, sql, record))
    ) {
      return false;
    }
    // Authority may wait on Change/Stop. A fresh statement after those
    // locks must still prove that no intent or Session was bound.
    const failed = await sql<{ id: string }[]>`UPDATE factory.agent_turn turn
      SET state='failed',outcome_summary=${summary},owner_token=NULL,owner_expires_at=NULL,updated_at=now()
      WHERE turn.id=${id} AND turn.change_id=${record.command.changeId}
        AND turn.state='pending' AND turn.owner_token=${ownerToken}
        AND turn.owner_expires_at<=clock_timestamp()
        AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
          WHERE intent.turn_id=turn.id AND intent.change_id=turn.change_id
            AND intent.runtime_attempt_id IS NULL)
        AND EXISTS(SELECT 1 FROM factory.change_writer writer
          WHERE writer.change_id=turn.change_id AND writer.turn_id=turn.id
            AND writer.state='agent' AND NOT writer.fence_required)
        AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session
          WHERE session.change_id=turn.change_id
            AND (session.active_turn_id=turn.id OR session.stop_pending))
      RETURNING turn.id`;
    return failed.length === 1;
  });
}

export async function markTurnRunning(
  database: Database,
  id: string,
  ownerToken: string,
  persistOutcome: (sql: DatabaseTransaction) => Promise<void>,
) {
  return database.client.begin(async (sql) => {
    await lockTurnChangeIn(sql, id);
    const db = drizzleTransaction(sql);
    const liveDispatching = turnLeasePredicate(id, "dispatching", { kind: "live", ownerToken });
    const admitted = await db.select().from(agentTurn).where(liveDispatching).for("update");
    if (!admitted[0] || !(await currentAuthorityIn(database, sql, toTurnRecord(admitted[0])))) {
      return false;
    }
    const rows = await db
      .update(agentTurn)
      .set({ state: "running", updatedAt: expression`now()` })
      .where(liveDispatching)
      .returning({ id: agentTurn.id });
    if (!rows[0]) return false;
    await persistOutcome(sql);
    const owned = await db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(turnLeasePredicate(id, "running", { kind: "live", ownerToken }));
    if (!owned[0]) {
      throw new CommandError("conflict", "Agent ownership expired while recording dispatch");
    }
    return true;
  });
}

export async function settleTurn(
  database: Database,
  id: string,
  ownerToken: string,
  state: "completed" | "failed" | "uncertain",
  summary: string,
  persistOutcome?: (transaction: DatabaseTransaction) => Promise<void>,
) {
  assertOutcomeSummary(summary);
  if (persistOutcome && state !== "completed") {
    throw new Error("Only a completed Agent turn may publish product effects");
  }
  return database.client.begin(async (transaction) => {
    if (persistOutcome) await lockTurnChangeIn(transaction, id);
    const db = drizzleTransaction(transaction);
    const liveDispatched = turnLeasePredicate(id, DISPATCHED_TURN_STATES, {
      kind: "live",
      ownerToken,
    });
    const owned = await db.select().from(agentTurn).where(liveDispatched).for("update");
    if (!owned[0]) return false;
    if (
      persistOutcome &&
      !(await currentAuthorityIn(database, transaction, toTurnRecord(owned[0])))
    ) {
      return false;
    }
    await persistOutcome?.(transaction);
    const settled = await db
      .update(agentTurn)
      .set({
        state,
        outcomeSummary: summary,
        ownerToken: null,
        ownerExpiresAt: null,
        updatedAt: expression`now()`,
      })
      .where(liveDispatched)
      .returning({ id: agentTurn.id });
    if (!settled[0]) {
      // Throwing rolls back effects if ownership expired while the transaction ran.
      throw new CommandError("conflict", "Agent turn ownership expired before settlement");
    }
    return true;
  });
}
