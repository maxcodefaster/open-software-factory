import type { createDatabase } from "./client";

/** Waits for PostgreSQL to accept connections, e.g. while a NetworkPolicy or Service is still syncing. */
export async function waitForDatabase(
  client: ReturnType<typeof createDatabase>["client"],
  attempts = 120,
  delayMS = 500,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client`SELECT 1`;
      return;
    } catch (cause) {
      if (attempt >= attempts) throw cause;
      await Bun.sleep(delayMS);
    }
  }
}
