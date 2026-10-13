import type { createDatabase } from "../../../../packages/db/src/client";

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
        const rows = await database.client<Revocation[]>`
          SELECT intent.user_id AS "userID",intent.version::text AS version,
            (access.disabled_at IS NOT NULL OR access.directory_disabled_at IS NOT NULL) AS disabled
          FROM factory.access_revocation intent JOIN factory.account_access access ON access.user_id=intent.user_id
          WHERE processed_version<version AND NOT intent.user_id=ANY(${attempted}::uuid[])
          ORDER BY intent.updated_at,intent.user_id LIMIT 64`;
        for (const row of rows) {
          if (closed) return;
          attempted.push(row.userID);
          try {
            await revoke(row.userID, row.disabled);
            // Recheck the version after external work. A newer revocation stays pending.
            await database.client`UPDATE factory.access_revocation SET processed_version=${row.version}
              WHERE user_id=${row.userID} AND version=${row.version} AND processed_version<${row.version}`;
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
    void drain().catch(() => console.error("Access revocation remains pending"));
  }
  return {
    drain,
    async start() {
      listener = await database.client.listen("factory_access_revoked", wake);
      timer = setInterval(wake, 30_000);
      timer.unref();
      await drain().catch(() => console.error("Access revocation remains pending"));
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await listener?.unlisten();
      await running?.catch(() => {});
    },
  };
}
