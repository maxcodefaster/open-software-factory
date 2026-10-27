import type { createDatabase } from "../../../../packages/db/src/client";
import type { RuntimeHub } from "./hub";

type Database = ReturnType<typeof createDatabase>;

export function executionIdleMS(environment: Readonly<Record<string, string | undefined>>) {
  const configured = environment["FACTORY_EXECUTION_IDLE_MINUTES"] ?? "5";
  if (!/^\d+$/.test(configured) || Number(configured) > 1440)
    throw new Error("Execution idle retention requires 0–1440 minutes");
  return Number(configured) * 60_000;
}

// Activity stays in memory. Restart starts a new grace; it never stores user heartbeats.
export function createIdleCompute(
  database: Database,
  hub: Pick<RuntimeHub, "claimIdle" | "releaseIdle">,
  runtimes: { pause(attemptID: string): Promise<unknown> },
  idleMS = executionIdleMS(process.env),
) {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let after: string | null = null;

  async function reconcile() {
    if (!idleMS || closed) return;
    const candidates = await database.client<
      Array<{ id: string; projectID: string; changeID: string | null }>
    >`SELECT id,project_id AS "projectID",change_id AS "changeID" FROM factory.runtime_attempt
      WHERE workspace_id IS NOT NULL AND state='ready'
        AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT 64`;
    // Advance even when every candidate is busy. Activity remains ephemeral.
    after = candidates.length === 64 ? (candidates.at(-1)?.id ?? null) : null;
    for (const attempt of candidates) {
      if (closed) return;
      let claimed = false;
      let recorded = false;
      try {
        recorded = await database.client.begin(async (sql) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${attempt.projectID}`}))`;
          if (attempt.changeID) {
            // Same locks as Build admission. Read work again only after acquiring them.
            await sql`SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id=change.ticket_id
              WHERE change.id=${attempt.changeID} FOR UPDATE OF change,ticket`;
          }
          const [current] = await sql<Array<{ state: string }>>`
            SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id} FOR UPDATE`;
          if (current?.state !== "ready") return false;
          const [work] = await sql<Array<{ active: boolean }>>`
            SELECT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${attempt.changeID}
              AND state IN ('pending','dispatching','running','uncertain'))
              OR EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=${attempt.changeID}
                AND (state IN ('starting','working') OR stop_pending))
              OR EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=${attempt.changeID}
                AND state NOT IN ('succeeded','failed')) AS active`;
          if (work?.active || !hub.claimIdle(attempt.id, idleMS)) return false;
          claimed = true;
          await sql`UPDATE factory.runtime_attempt SET state='pausing',updated_at=now()
            WHERE id=${attempt.id} AND state='ready'`;
          return true;
        });
        if (recorded) await runtimes.pause(attempt.id);
      } finally {
        if (claimed && !recorded) hub.releaseIdle(attempt.id);
      }
    }
  }
  function sweep() {
    if (running) return running;
    running = reconcile().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    sweep,
    start() {
      if (closed || timer || !idleMS) return;
      timer = setInterval(() => {
        void sweep().catch(() => console.error("Idle compute reconciliation failed"));
      }, 30_000);
      timer.unref();
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await running;
    },
  };
}
