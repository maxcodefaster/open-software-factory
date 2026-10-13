import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { lockUsageIn } from "./policy";
import {
  estimateUsage,
  usageCounters,
  usagePurpose,
  usageRate,
  unknownCounters,
} from "../../../../packages/conversation-domain/src/usage";

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
type Database = ReturnType<typeof createDatabase>;

export function createUsageJournal(database: Database) {
  async function begin(
    input: UsageOperation,
    baselines: Array<{ sessionID: string; sequence: number }> = [],
  ) {
    const value = operation.parse(input);
    if (value.rate && (value.rate.provider !== value.provider || value.rate.model !== value.model))
      throw new Error("Usage rate must name the exact admitted model");
    await database.client.begin(async (sql) => {
      const inserted =
        await sql`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,rate)
        VALUES(${value.id},${value.projectID},${value.userID},${value.purpose},${value.engine},${value.provider},${value.model},${value.rate ? JSON.stringify(value.rate) : null}::jsonb)
        ON CONFLICT DO NOTHING RETURNING id`;
      if (inserted.length)
        for (const baseline of baselines) {
          identity.parse(baseline.sessionID);
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(baseline.sequence);
          await sql`INSERT INTO factory.usage_replay_cursor(operation_id,session_id,sequence,start_sequence)
          VALUES(${value.id},${baseline.sessionID},${baseline.sequence},${baseline.sequence})`;
        }
      const [row] = await sql<
        Array<{
          project_id: string | null;
          user_id: string | null;
          purpose: string;
          engine: string;
          provider: string;
          model: string;
        }>
      >`SELECT project_id,user_id,purpose,engine,provider,model FROM factory.usage_operation WHERE id=${value.id}`;
      if (
        !row ||
        row.project_id !== value.projectID ||
        row.user_id !== value.userID ||
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
      const [row] = await sql<
        Array<{ rate: unknown }>
      >`SELECT rate FROM factory.usage_operation WHERE id=${operationID} FOR UPDATE`;
      if (!row) throw new Error("Usage must be admitted before observation");
      const estimate = estimateUsage(value.counters, row.rate ? usageRate.parse(row.rate) : null);
      await sql`INSERT INTO factory.usage_entry(operation_id,event_id,source,outcome,counters,nano_usd,known_nano_usd,occurred_at)
        VALUES(${operationID},${value.eventID},${value.source},${value.outcome},${JSON.stringify(value.counters)}::jsonb,${estimate.nanoUSD},${estimate.knownNanoUSD},${value.occurredAt}) ON CONFLICT DO NOTHING`;
      const [existing] = await sql<
        Array<{ source: string; outcome: string; counters: unknown; occurred_at: Date }>
      >`SELECT source,outcome,counters,occurred_at FROM factory.usage_entry WHERE operation_id=${operationID} AND event_id=${value.eventID}`;
      if (
        !existing ||
        existing.source !== value.source ||
        existing.outcome !== value.outcome ||
        JSON.stringify(usageCounters.parse(existing.counters)) !== JSON.stringify(value.counters) ||
        new Date(existing.occurred_at).getTime() !== Date.parse(value.occurredAt)
      )
        throw new Error("Usage event replay changed observation");
      if (cursor)
        await sql`INSERT INTO factory.usage_replay_cursor(operation_id,session_id,sequence)
        VALUES(${operationID},${cursor.sessionID},${cursor.sequence}) ON CONFLICT(operation_id,session_id)
        DO UPDATE SET sequence=GREATEST(factory.usage_replay_cursor.sequence,EXCLUDED.sequence)`;
    });
  }
  return {
    begin,
    record,
    async abandon(operationID: string) {
      const [operation] = await database.client<
        Array<{ created_at: Date }>
      >`SELECT created_at FROM factory.usage_operation WHERE id=${operationID} AND settled_at IS NULL`;
      if (!operation) return;
      await record(operationID, {
        eventID: "recovery:unobserved",
        source: "unobserved",
        outcome: "unknown",
        counters: unknownCounters(),
        occurredAt: new Date(operation.created_at).toISOString(),
      });
      await database.client`UPDATE factory.usage_operation SET outcome='unknown',settled_at=now() WHERE id=${operationID} AND settled_at IS NULL`;
    },
    async advance(operationID: string, sessionID: string, sequence: number) {
      identity.parse(sessionID);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(sequence);
      await database.client`INSERT INTO factory.usage_replay_cursor(operation_id,session_id,sequence)
        VALUES(${operationID},${sessionID},${sequence}) ON CONFLICT(operation_id,session_id)
        DO UPDATE SET sequence=GREATEST(factory.usage_replay_cursor.sequence,EXCLUDED.sequence)`;
    },
    async settle(operationID: string, outcome: UsageEntry["outcome"]) {
      await database.client`UPDATE factory.usage_operation SET outcome=${outcome},settled_at=now() WHERE id=${operationID} AND settled_at IS NULL`;
    },
    async cursor(operationID: string, sessionID: string) {
      const [row] = await database.client<
        Array<{ sequence: string }>
      >`SELECT sequence FROM factory.usage_replay_cursor WHERE operation_id=${operationID} AND session_id=${sessionID}`;
      return row ? Number(row.sequence) : 0;
    },
    async prune(now = new Date()) {
      // PostgreSQL calendar subtraction avoids an approximate 365-day retention window.
      return database.client.begin(async (sql) => {
        await lockUsageIn(sql);
        const removed = await sql`DELETE FROM factory.usage_operation WHERE settled_at IS NOT NULL
        AND created_at < ${now.toISOString()}::timestamptz - interval '12 months'
        AND NOT EXISTS(SELECT 1 FROM factory.usage_entry WHERE operation_id=factory.usage_operation.id
          AND occurred_at >= ${now.toISOString()}::timestamptz - interval '12 months') RETURNING id`;
        await sql`DELETE FROM factory.usage_entry entry USING factory.usage_operation operation
          WHERE entry.operation_id=operation.id AND operation.settled_at IS NOT NULL
          AND entry.occurred_at < ${now.toISOString()}::timestamptz - interval '12 months'`;
        return removed;
      });
    },
  };
}
