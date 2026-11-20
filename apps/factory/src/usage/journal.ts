import { and, eq, exists, sql as expression, isNotNull, isNull, lt, notExists } from "drizzle-orm";
import { z } from "zod";
import {
  estimateUsage,
  unknownCounters,
  usageCounters,
  usagePurpose,
  usageRate,
} from "../../../../packages/conversation-domain/src/usage";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import { usageEntry, usageOperation, usageReplayCursor } from "../../../../packages/db/src/schema";
import { lockUsageIn } from "./policy";

const identity = z.string().min(1).max(400);
const operation = z.object({
  id: identity,
  projectID: z.uuid().nullable(),
  userID: z.uuid().nullable(),
  purpose: usagePurpose,
  engine: z.enum(["opencode", "mastra"]),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  rate: usageRate.nullable(),
});
export type UsageOperation = z.infer<typeof operation>;
const entry = z.object({
  eventID: identity,
  source: z.enum(["step", "title", "compaction", "unobserved"]),
  outcome: z.enum(["completed", "failed", "interrupted", "unknown"]),
  counters: usageCounters,
  occurredAt: z.iso.datetime(),
});
export type UsageEntry = z.infer<typeof entry>;
type Database = Pick<ReturnType<typeof createDatabase>, "db"> & {
  client: ReturnType<typeof createDatabase>["client"] | DatabaseTransaction;
};

export function createUsageJournal(database: Database) {
  async function advanceIn(
    db: Pick<Database["db"], "insert">,
    operationID: string,
    sessionID: string,
    sequence: number,
  ) {
    await db
      .insert(usageReplayCursor)
      .values({ operationId: operationID, sessionId: sessionID, sequence })
      .onConflictDoUpdate({
        target: [usageReplayCursor.operationId, usageReplayCursor.sessionId],
        set: { sequence: expression`GREATEST(${usageReplayCursor.sequence},${sequence})` },
      });
  }
  async function begin(
    input: UsageOperation,
    baselines: Array<{ sessionID: string; sequence: number }> = [],
  ) {
    const value = operation.parse(input);
    if (value.rate && (value.rate.provider !== value.provider || value.rate.model !== value.model))
      throw new Error("Usage rate must name the exact admitted model");
    await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const inserted = await db
        .insert(usageOperation)
        .values({
          id: value.id,
          projectId: value.projectID,
          userId: value.userID,
          purpose: value.purpose,
          engine: value.engine,
          provider: value.provider,
          model: value.model,
          rate: value.rate,
        })
        .onConflictDoNothing()
        .returning({ id: usageOperation.id });
      if (inserted.length)
        for (const baseline of baselines) {
          identity.parse(baseline.sessionID);
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(baseline.sequence);
          await db.insert(usageReplayCursor).values({
            operationId: value.id,
            sessionId: baseline.sessionID,
            sequence: baseline.sequence,
            startSequence: baseline.sequence,
          });
        }
      const [row] = await db
        .select({
          projectId: usageOperation.projectId,
          userId: usageOperation.userId,
          purpose: usageOperation.purpose,
          engine: usageOperation.engine,
          provider: usageOperation.provider,
          model: usageOperation.model,
        })
        .from(usageOperation)
        .where(eq(usageOperation.id, value.id));
      if (
        !row ||
        row.projectId !== value.projectID ||
        row.userId !== value.userID ||
        row.purpose !== value.purpose ||
        row.engine !== value.engine ||
        row.provider !== value.provider ||
        row.model !== value.model
      )
        throw new Error("Usage operation replay changed attribution");
      // Existing operations retain their original rate even if the catalogue has refreshed.
    });
  }
  async function record(
    operationID: string,
    input: UsageEntry,
    cursor?: { sessionID: string; sequence: number },
  ) {
    const value = entry.parse(input);
    if (cursor) {
      identity.parse(cursor.sessionID);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(cursor.sequence);
    }
    await database.client.begin(async (sql) => {
      await lockUsageIn(sql);
      const db = drizzleTransaction(sql);
      const [row] = await db
        .select({ rate: usageOperation.rate })
        .from(usageOperation)
        .where(eq(usageOperation.id, operationID))
        .for("update");
      if (!row) throw new Error("Usage must be admitted before observation");
      const estimate = estimateUsage(value.counters, row.rate ? usageRate.parse(row.rate) : null);
      await db
        .insert(usageEntry)
        .values({
          operationId: operationID,
          eventId: value.eventID,
          source: value.source,
          outcome: value.outcome,
          counters: value.counters,
          nanoUsd: estimate.nanoUSD === null ? null : BigInt(estimate.nanoUSD),
          knownNanoUsd: BigInt(estimate.knownNanoUSD),
          occurredAt: expression`${value.occurredAt}::timestamptz`,
        })
        .onConflictDoNothing();
      const [existing] = await db
        .select({
          source: usageEntry.source,
          outcome: usageEntry.outcome,
          counters: usageEntry.counters,
          occurredAt: usageEntry.occurredAt,
        })
        .from(usageEntry)
        .where(and(eq(usageEntry.operationId, operationID), eq(usageEntry.eventId, value.eventID)));
      if (
        !existing ||
        existing.source !== value.source ||
        existing.outcome !== value.outcome ||
        JSON.stringify(usageCounters.parse(existing.counters)) !== JSON.stringify(value.counters) ||
        existing.occurredAt.getTime() !== Date.parse(value.occurredAt)
      )
        throw new Error("Usage event replay changed observation");
      if (cursor) await advanceIn(db, operationID, cursor.sessionID, cursor.sequence);
    });
  }
  return {
    begin,
    record,
    async abandon(operationID: string) {
      const [operation] = await database.db
        .select({ createdAt: usageOperation.createdAt })
        .from(usageOperation)
        .where(and(eq(usageOperation.id, operationID), isNull(usageOperation.settledAt)));
      if (!operation) return;
      await record(operationID, {
        eventID: "recovery:unobserved",
        source: "unobserved",
        outcome: "unknown",
        counters: unknownCounters(),
        occurredAt: operation.createdAt.toISOString(),
      });
      await database.db
        .update(usageOperation)
        .set({ outcome: "unknown", settledAt: expression`now()` })
        .where(and(eq(usageOperation.id, operationID), isNull(usageOperation.settledAt)));
    },
    async advance(operationID: string, sessionID: string, sequence: number) {
      identity.parse(sessionID);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(sequence);
      await advanceIn(database.db, operationID, sessionID, sequence);
    },
    async settle(operationID: string, outcome: UsageEntry["outcome"]) {
      await database.db
        .update(usageOperation)
        .set({ outcome, settledAt: expression`now()` })
        .where(and(eq(usageOperation.id, operationID), isNull(usageOperation.settledAt)));
    },
    async cursor(operationID: string, sessionID: string) {
      const [row] = await database.db
        .select({ sequence: usageReplayCursor.sequence })
        .from(usageReplayCursor)
        .where(
          and(
            eq(usageReplayCursor.operationId, operationID),
            eq(usageReplayCursor.sessionId, sessionID),
          ),
        );
      return row ? Number(row.sequence) : 0;
    },
    async prune(now = new Date()) {
      // PostgreSQL calendar subtraction avoids an approximate 365-day retention window.
      return database.client.begin(async (sql) => {
        await lockUsageIn(sql);
        const db = drizzleTransaction(sql);
        const cutoff = expression`${now.toISOString()}::timestamptz - interval '12 months'`;
        const removed = await db
          .delete(usageOperation)
          .where(
            and(
              isNotNull(usageOperation.settledAt),
              lt(usageOperation.createdAt, cutoff),
              notExists(
                db
                  .select({ eventId: usageEntry.eventId })
                  .from(usageEntry)
                  .where(
                    and(
                      eq(usageEntry.operationId, usageOperation.id),
                      expression`${usageEntry.occurredAt} >= ${cutoff}`,
                    ),
                  ),
              ),
            ),
          )
          .returning({ id: usageOperation.id });
        await db.delete(usageEntry).where(
          and(
            lt(usageEntry.occurredAt, cutoff),
            exists(
              db
                .select({ id: usageOperation.id })
                .from(usageOperation)
                .where(
                  and(
                    eq(usageOperation.id, usageEntry.operationId),
                    isNotNull(usageOperation.settledAt),
                  ),
                ),
            ),
          ),
        );
        return removed;
      });
    },
  };
}
