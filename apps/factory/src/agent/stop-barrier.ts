import { and, desc, eq, exists, inArray, isNull, ne, or, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentSession,
  changeAgentTurnIntent,
  change as changeTable,
  ticket,
} from "#db/schema";
import { CommandError } from "../command-error";
import { requirePendingWriterHandoffIn } from "./stop-fencing";
import {
  ACTIVE_TURN_STATES,
  noOtherActiveTurnPredicate,
  type PendingWriterHandoff,
  type StopOrigin,
  settleStopTurnIn,
} from "./stop-state";

async function tryCancelUnboundPendingTurnIn(
  sql: DatabaseTransaction,
  changeID: string,
  pendingTurnID: string,
  origin: StopOrigin,
): Promise<boolean> {
  const db = drizzleTransaction(sql);
  const [settled] = await db
    .select({ changeId: changeAgentSession.changeId })
    .from(changeAgentSession)
    .where(
      and(
        eq(changeAgentSession.changeId, changeID),
        eq(changeAgentSession.state, "stopped"),
        eq(changeAgentSession.stopPending, false),
        query`${changeAgentSession.activeTurnId} IS DISTINCT FROM ${pendingTurnID}::uuid`,
        noOtherActiveTurnPredicate(db, pendingTurnID),
      ),
    );
  if (!settled) return false;
  // Never wait on Turn while holding Change. If execute already owns it, publish
  // the normal Stop barrier below. Otherwise this lock makes cancellation atomic
  // with runtime binding/dispatch.
  const [unbound] = await sql`SELECT turn.id FROM factory.agent_turn turn
    WHERE turn.id=${pendingTurnID} AND turn.change_id=${changeID} AND turn.state='pending'
      AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
        WHERE intent.turn_id=turn.id AND intent.change_id=turn.change_id
          AND intent.runtime_attempt_id IS NULL)
    FOR UPDATE OF turn SKIP LOCKED`;
  if (!unbound) return false;
  // Binding can commit after the locking statement took its snapshot without
  // updating Turn itself. Recheck both records in a fresh statement, now that
  // the Turn lock excludes it.
  const [cancellable] = await db
    .select({ changeId: changeAgentSession.changeId })
    .from(changeAgentSession)
    .innerJoin(
      changeAgentTurnIntent,
      and(
        eq(changeAgentTurnIntent.turnId, pendingTurnID),
        eq(changeAgentTurnIntent.changeId, changeAgentSession.changeId),
      ),
    )
    .innerJoin(
      agentTurn,
      and(eq(agentTurn.id, changeAgentTurnIntent.turnId), eq(agentTurn.state, "pending")),
    )
    .where(
      and(
        eq(changeAgentSession.changeId, changeID),
        eq(changeAgentSession.state, "stopped"),
        eq(changeAgentSession.stopPending, false),
        isNull(changeAgentTurnIntent.runtimeAttemptId),
        query`${changeAgentSession.activeTurnId} IS DISTINCT FROM ${agentTurn.id}`,
        noOtherActiveTurnPredicate(db, agentTurn.id),
      ),
    );
  if (!cancellable) return false;
  await settleStopTurnIn(sql, changeID, { stopID: null, turnID: pendingTurnID }, origin);
  return true;
}

export async function publishStopBarrierIn(
  sql: DatabaseTransaction,
  changeID: string,
  stopID: string,
  origin: StopOrigin,
  handoff?: PendingWriterHandoff,
): Promise<{ stopID: string | null; turnID: string | null; pendingTurnID: string | null }> {
  const db = drizzleTransaction(sql);
  const lockedChange = alias(changeTable, "change");
  const lockedTicket = alias(ticket, "ticket");
  const [change] = await db
    .select({ attemptID: lockedChange.runtimeAttemptId })
    .from(lockedChange)
    .innerJoin(lockedTicket, eq(lockedTicket.id, lockedChange.ticketId))
    .where(eq(lockedChange.id, changeID))
    .for("update", { of: [lockedChange, lockedTicket] });
  if (handoff) {
    if (!change?.attemptID)
      throw new CommandError(
        "conflict",
        "Pending writer handoff no longer owns cleanup of the original Workspace.",
      );
    await requirePendingWriterHandoffIn(sql, change.attemptID, handoff);
  }
  // A pending admission may not yet have prepared the Session. With no active
  // turn, retain this exact Session's last assigned input: a failed outcome
  // does not prove that its native Inbox entry was removed.
  const turns = await db
    .select({
      id: agentTurn.id,
      unbound: query<boolean>`${agentTurn.state}='pending' AND ${exists(
        db
          .select({ turnId: changeAgentTurnIntent.turnId })
          .from(changeAgentTurnIntent)
          .where(
            and(
              eq(changeAgentTurnIntent.turnId, agentTurn.id),
              eq(changeAgentTurnIntent.changeId, agentTurn.changeId),
              isNull(changeAgentTurnIntent.runtimeAttemptId),
            ),
          ),
      )}`,
    })
    .from(agentTurn)
    .where(
      and(
        eq(agentTurn.changeId, changeID),
        inArray(agentTurn.state, [...ACTIVE_TURN_STATES]),
        query`${agentTurn.id} IS DISTINCT FROM ${handoff?.turnID ?? null}::uuid`,
      ),
    )
    .orderBy(desc(agentTurn.createdAt))
    .limit(1);
  const pending = turns[0];
  if (
    !handoff &&
    pending?.unbound &&
    (await tryCancelUnboundPendingTurnIn(sql, changeID, pending.id, origin))
  ) {
    // There is no new native input. Preserve the previous Session's confirmed
    // Stop instead of inventing a target.
    return { stopID: null, turnID: pending.id, pendingTurnID: null };
  }
  const rows = await db
    .update(changeAgentSession)
    .set({
      state: "stopped",
      stopId: query`CASE WHEN ${changeAgentSession.stopPending} THEN ${changeAgentSession.stopId} ELSE ${stopID}::uuid END`,
      stopTurnId: query`CASE WHEN ${changeAgentSession.stopPending} THEN ${changeAgentSession.stopTurnId} ELSE COALESCE(
            ${turns[0]?.id ?? null}::uuid,
            ${db
              .select({ turnId: changeAgentTurnIntent.turnId })
              .from(changeAgentTurnIntent)
              .where(
                and(
                  eq(changeAgentTurnIntent.turnId, changeAgentSession.activeTurnId),
                  eq(changeAgentTurnIntent.changeId, changeAgentSession.changeId),
                  eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
                  or(
                    isNull(changeAgentTurnIntent.runtimeAttemptId),
                    eq(changeAgentTurnIntent.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
                  ),
                ),
              )}
          ) END`,
      stopPending: true,
      activeInboxId: null,
      updatedAt: query`now()`,
    })
    .where(
      and(
        eq(changeAgentSession.changeId, changeID),
        or(
          eq(changeAgentSession.stopPending, true),
          ne(changeAgentSession.state, "stopped"),
          query`${turns[0]?.id ?? null}::uuid IS NOT NULL`,
        ),
      ),
    )
    .returning({
      stopID: changeAgentSession.stopId,
      turnID: changeAgentSession.stopTurnId,
    });
  return {
    ...(rows[0] ?? { stopID: null, turnID: turns[0]?.id ?? null }),
    pendingTurnID: handoff ? null : (turns[0]?.id ?? null),
  };
}
