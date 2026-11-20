import { and, asc, eq, sql as expression, lt, notInArray } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { accessRevocation, accountAccess } from "../../../../packages/db/src/schema";
import { reportFailure } from "../failure-log";

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
            userID: accessRevocation.userId,
            // Keep the native bigint exact across the external acknowledgement boundary.
            version: expression<string>`${accessRevocation.version}::text`,
            disabled: expression<boolean>`${accountAccess.disabledAt} IS NOT NULL OR ${accountAccess.directoryDisabledAt} IS NOT NULL`,
          })
          .from(accessRevocation)
          .innerJoin(accountAccess, eq(accountAccess.userId, accessRevocation.userId))
          .where(
            and(
              lt(accessRevocation.processedVersion, accessRevocation.version),
              attempted.length ? notInArray(accessRevocation.userId, attempted) : undefined,
            ),
          )
          .orderBy(asc(accessRevocation.updatedAt), asc(accessRevocation.userId))
          .limit(64);
        for (const row of rows) {
          if (closed) return;
          attempted.push(row.userID);
          try {
            await revoke(row.userID, row.disabled);
            // Recheck the version after external work. A newer revocation stays pending.
            const version = expression`${row.version}::bigint`;
            await db
              .update(accessRevocation)
              .set({ processedVersion: version })
              .where(
                and(
                  eq(accessRevocation.userId, row.userID),
                  eq(accessRevocation.version, version),
                  lt(accessRevocation.processedVersion, version),
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
