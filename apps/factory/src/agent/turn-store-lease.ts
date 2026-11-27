import { and, eq, sql as expression, isNotNull, isNull } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn } from "#db/schema";
import { currentAuthorityIn, lockTurnChangeIn, notPausedCodingTurn } from "./turn-store-coding";
import {
  type Database,
  DISPATCHED_TURN_STATES,
  LIVE_TURN_STATES,
  leaseDuration,
  leaseExpirySql,
  RECOVERABLE_TURN_STATES,
  toTurnRecord,
  turnLeasePredicate,
} from "./turn-store-types";

export async function validateTurnExecutionIn(
  database: Database,
  sql: DatabaseTransaction,
  id: string,
  ownerToken: string,
  forward?: (sql: DatabaseTransaction) => Promise<void>,
) {
  await lockTurnChangeIn(sql, id);
  const db = drizzleTransaction(sql);
  const liveLease = turnLeasePredicate(id, LIVE_TURN_STATES, { kind: "live", ownerToken });
  const rows = await db.select().from(agentTurn).where(liveLease).for("update");
  if (!rows[0] || !(await currentAuthorityIn(database, sql, toTurnRecord(rows[0])))) return false;
  // Authority locks can outlast the lease. Recheck after the last lock wait.
  const live = await db.select({ id: agentTurn.id }).from(agentTurn).where(liveLease);
  if (!live[0]) return false;
  await forward?.(sql);
  return true;
}

export async function observeTurnCommit(
  database: Database,
  id: string,
  persist: (sql: DatabaseTransaction, current: boolean) => Promise<void>,
) {
  return database.client.begin(async (sql) => {
    await lockTurnChangeIn(sql, id);
    const rows = await drizzleTransaction(sql)
      .select()
      .from(agentTurn)
      .where(
        and(eq(agentTurn.id, id), isNotNull(agentTurn.changeId), eq(agentTurn.state, "completed")),
      )
      .for("update");
    if (!rows[0]) return false;
    const current = await currentAuthorityIn(database, sql, toTurnRecord(rows[0]));
    await persist(sql, current);
    return current;
  });
}

export async function claimPendingTurn(database: Database, id: string, milliseconds = 30_000) {
  const duration = leaseDuration(milliseconds);
  const rows = await database.db
    .update(agentTurn)
    .set({
      ownerToken: crypto.randomUUID(),
      ownerExpiresAt: leaseExpirySql(duration),
      updatedAt: expression`now()`,
    })
    .where(
      and(
        turnLeasePredicate(id, "pending", { kind: "claimable" }),
        notPausedCodingTurn(database, id),
      ),
    )
    .returning();
  return rows[0] ? toTurnRecord(rows[0]) : null;
}

export async function releasePendingTurn(database: Database, id: string, ownerToken: string) {
  await database.db
    .update(agentTurn)
    .set({ ownerToken: null, ownerExpiresAt: null, updatedAt: expression`now()` })
    .where(
      and(
        eq(agentTurn.id, id),
        eq(agentTurn.state, "pending"),
        eq(agentTurn.ownerToken, ownerToken),
      ),
    );
}

export async function claimExternalRecoveryTurn(
  database: Database,
  id: string,
  milliseconds = 30_000,
) {
  const duration = leaseDuration(milliseconds);
  // Recovery may observe an external operation, but never acquires permission
  // to repeat it. A still-live owner and terminal decisions remain untouched.
  const rows = await database.db
    .update(agentTurn)
    .set({
      state: "running",
      ownerToken: crypto.randomUUID(),
      ownerExpiresAt: leaseExpirySql(duration),
      updatedAt: expression`now()`,
    })
    .where(
      and(
        isNotNull(agentTurn.changeId),
        turnLeasePredicate(id, RECOVERABLE_TURN_STATES, { kind: "claimable" }),
      ),
    )
    .returning();
  return rows[0] ? toTurnRecord(rows[0]) : null;
}

export async function quarantineExpiredProjectTurn(database: Database, id: string) {
  // The provider has no recoverable operation identity. Lease loss permits
  // recording uncertainty, never submitting the admitted input again.
  const rows = await database.db
    .update(agentTurn)
    .set({
      state: "uncertain",
      ownerToken: null,
      ownerExpiresAt: null,
      outcomeSummary:
        "The provider outcome was lost after dispatch. Retry requires a new explicit attempt.",
      updatedAt: expression`now()`,
    })
    .where(
      and(
        isNull(agentTurn.changeId),
        turnLeasePredicate(id, DISPATCHED_TURN_STATES, { kind: "claimable" }),
      ),
    )
    .returning({ id: agentTurn.id });
  return rows.length === 1;
}

export async function renewTurnLease(
  database: Database,
  id: string,
  ownerToken: string,
  milliseconds = 30_000,
) {
  const duration = leaseDuration(milliseconds);
  return database.client.begin(async (sql) => {
    await lockTurnChangeIn(sql, id);
    const db = drizzleTransaction(sql);
    const [owned] = await db
      .select()
      .from(agentTurn)
      .where(and(eq(agentTurn.id, id), eq(agentTurn.ownerToken, ownerToken)))
      .for("update");
    // Renew only the current pending preparation while its previous input
    // settles. Ordinary execution validation still rejects that Stop.
    if (!owned || !(await currentAuthorityIn(database, sql, toTurnRecord(owned), true)))
      return false;
    const rows = await db
      .update(agentTurn)
      .set({
        ownerExpiresAt: leaseExpirySql(duration),
        updatedAt: expression`now()`,
      })
      .where(turnLeasePredicate(id, LIVE_TURN_STATES, { kind: "live", ownerToken }))
      .returning({ id: agentTurn.id });
    return rows.length === 1;
  });
}
