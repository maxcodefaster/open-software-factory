import { setTimeout } from "node:timers/promises";

// Only this idempotent query is retried, never installation, migration or App work.
export async function waitForPostgres(
  probe: () => Promise<unknown>,
  pause: () => Promise<unknown> = () => setTimeout(1000),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await probe();
      return;
    } catch {
      if (attempt === 29) throw new Error("Starter PostgreSQL did not become ready");
      await pause();
    }
  }
}
