import { and, asc, eq, sql as expression, notInArray } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { accountAccess, operation } from "#db/schema";
import { reportFailure } from "../failure-log";

const ACCESS_REVOCATION_KIND = "access.revocation";
const accessRevocationKey = (userID: string) => `${ACCESS_REVOCATION_KIND}:${userID}`;

type Database = ReturnType<typeof createDatabase>;
type Revocation = { userID: string; version: string; disabled: boolean };

// SQL commits intent and NOTIFY together. Startup/fallback reads repair a lost notification.
export function createAccessRevocation(
  database: Database,
  revoke: (userID: string, disabled: boolean) => Promise<void>,
) {
  let running: Promise<void> | undefined;
  let wakeAgain = false;
  let closed = false;
  let listener: Awaited<ReturnType<Database["client"]["listen"]>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function drain() {
    if (closed) return;
    if (running) {
      wakeAgain = true;
      return running;
    }
    running = (async () => {
      const failures: unknown[] = [];
      const attempted: string[] = [];
      do {
        wakeAgain = false;
        const db = drizzleTransaction(database.client);
        const rows: Revocation[] = await db
          .select({
            userID: operation.scopeId,
            // Keep the native bigint exact across the external acknowledgement boundary.
            version: expression<string>`${operation.payload}->>'version'`,
            disabled: expression<boolean>`${accountAccess.disabledAt} IS NOT NULL OR ${accountAccess.directoryDisabledAt} IS NOT NULL`,
          })
          .from(operation)
          .innerJoin(
            accountAccess,
            eq(expression<string>`${accountAccess.userId}::text`, operation.scopeId),
          )
          .where(
            and(
              eq(operation.kind, ACCESS_REVOCATION_KIND),
              eq(operation.scopeType, "user"),
              eq(operation.state, "pending"),
              expression`CASE WHEN ${operation.kind} = ${ACCESS_REVOCATION_KIND} THEN (${operation.payload}->>'processedVersion')::bigint < (${operation.payload}->>'version')::bigint ELSE false END`,
              attempted.length ? notInArray(operation.scopeId, attempted) : undefined,
            ),
          )
          .orderBy(asc(operation.updatedAt), asc(operation.scopeId))
          .limit(64);
        for (const row of rows) {
          if (closed) return;
          attempted.push(row.userID);
          try {
            await revoke(row.userID, row.disabled);
            // Recheck the version after external work. A newer revocation stays pending.
            const version = expression`${row.version}::bigint`;
            await db
              .update(operation)
              .set({
                state: "processed",
                payload: expression`jsonb_set(${operation.payload}, '{processedVersion}', to_jsonb(${version}))`,
                completedAt: expression`now()`,
                updatedAt: expression`now()`,
              })
              .where(
                and(
                  eq(operation.kind, ACCESS_REVOCATION_KIND),
                  eq(operation.idempotencyKey, accessRevocationKey(row.userID)),
                  expression`(${operation.payload}->>'version')::bigint = ${version}`,
                  expression`(${operation.payload}->>'processedVersion')::bigint < ${version}`,
                ),
              );
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (rows.length === 64) wakeAgain = true;
      } while (wakeAgain && !closed);
      if (failures.length) throw failures[0];
    })().finally(() => {
      running = undefined;
    });
    return running;
  }
  function wake() {
    void drain().catch(reportFailure("Access revocation remains pending"));
  }
  return {
    drain,
    async start() {
      listener = await database.client.listen("factory_access_revoked", wake);
      timer = setInterval(wake, 30_000);
      timer.unref();
      await drain().catch(reportFailure("Access revocation remains pending"));
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await listener?.unlisten();
      await running?.catch(() => {});
    },
  };
}
