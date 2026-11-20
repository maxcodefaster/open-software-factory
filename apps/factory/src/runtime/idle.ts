import type { createDatabase } from "../../../../packages/db/src/client";
import { reportFailure } from "../failure-log";
import type { RuntimeHub } from "./hub";

type Database = ReturnType<typeof createDatabase>;

// Idle policy is independent of lifecycle latency. An unattached Workspace
// receives the existing shorter grace; activity remains ephemeral.
function minutes(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
) {
  const configured = environment[name] ?? fallback;
  if (!/^\d+$/.test(configured) || Number(configured) > 1440)
    throw new Error(`${name} requires 0–1440 minutes`);
  return Number(configured) * 60_000;
}

export function executionIdleMS(environment: Readonly<Record<string, string | undefined>>) {
  return minutes(environment, "FACTORY_EXECUTION_IDLE_MINUTES", "15");
}

/** Grace for a Workspace with no open IDE or Preview connection and nothing in flight. */
export function executionQuietMS(environment: Readonly<Record<string, string | undefined>>) {
  return Math.min(
    minutes(environment, "FACTORY_EXECUTION_QUIET_MINUTES", "2"),
    executionIdleMS(environment),
  );
}

/** How long a submitted Change keeps its Sandbox warm for review and Verification. */
export function executionReviewMS(environment: Readonly<Record<string, string | undefined>>) {
  return minutes(environment, "FACTORY_EXECUTION_REVIEW_MINUTES", "30");
}

// Activity stays in memory. Restart starts a new grace; it never stores user heartbeats.
export function createIdleCompute(
  database: Database,
  hub: Pick<RuntimeHub, "claimIdle" | "releaseIdle">,
  runtimes: {
    pause(attemptID: string): Promise<unknown>;
  },
  idleMS = executionIdleMS(process.env),
  quietMS = Math.min(executionQuietMS(process.env), idleMS),
  reviewMS = executionReviewMS(process.env),
) {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let after: string | null = null;

  async function reconcile() {
    if (!idleMS || closed) return;
    const candidates = await database.client<
      Array<{ id: string; projectID: string; workspaceID: string; changeID: string | null }>
    >`SELECT id,project_id AS "projectID",workspace_id AS "workspaceID",change_id AS "changeID" FROM factory.runtime_attempt
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
          await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${attempt.workspaceID}`}))`;
          if (attempt.changeID) {
            // Same locks as Build admission. Read work again only after acquiring them.
            await sql`SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id=change.ticket_id
              WHERE change.id=${attempt.changeID} FOR UPDATE OF change,ticket`;
          }
          const [current] = await sql<Array<{ state: string }>>`
            SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id} FOR UPDATE`;
          if (current?.state !== "ready") return false;
          const [work] = await sql<Array<{ active: boolean; reviewing: boolean }>>`
            SELECT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${attempt.changeID}
              AND state IN ('pending','dispatching','running','uncertain'))
              OR EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=${attempt.changeID}
                AND (state IN ('starting','working') OR stop_pending))
              OR EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=${attempt.changeID}
                AND state NOT IN ('succeeded','failed')) AS active,
              ${reviewMS} > 0 AND (
                EXISTS(SELECT 1 FROM factory.verification verification
                  WHERE verification.change_id=${attempt.changeID}
                    AND (verification.state IN ('pending','runner-starting','running')
                      OR verification.updated_at > now() - make_interval(secs => ${reviewMS / 1000})))
                OR EXISTS(SELECT 1 FROM factory.change_commit_operation commit
                  WHERE commit.change_id=${attempt.changeID} AND commit.state='succeeded'
                    AND commit.updated_at > now() - make_interval(secs => ${reviewMS / 1000}))) AS reviewing`;
          // A submitted Change stays warm while Verification runs and for the
          // review window after its last commit or verdict. Fences are unchanged.
          if (work?.active || work?.reviewing || !hub.claimIdle(attempt.id, idleMS, quietMS))
            return false;
          claimed = true;
          // Idle is Pause, never an implicit destructive Stop. Official
          // Substrate owns snapshot retention; no Factorybox pause cap applies.
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
        void sweep().catch(reportFailure("Idle compute reconciliation failed"));
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
