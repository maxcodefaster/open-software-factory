import { setTimeout as wait } from "node:timers/promises";
import { and, asc, inArray, isNull } from "drizzle-orm";
import { agentTurn } from "#db/schema";
import type { AgentTurnRecord } from "../agent/turn-record";
import type { createAgentTurnStore } from "../agent/turns-api";
import { reportFailure } from "../failure-log";
import { createUsageJournal } from "../usage/journal-api";
import type { ProjectAgentDatabase } from "./turn-types";

export function createTurnRecovery(deps: {
  database: ProjectAgentDatabase;
  turns: ReturnType<typeof createAgentTurnStore>;
  lifetime: AbortController;
  isClosed: () => boolean;
  track: (work: Promise<void>) => Promise<void>;
  dispatch: (record: AgentTurnRecord) => Promise<void>;
}) {
  const { database, turns, lifetime, isClosed, track, dispatch } = deps;
  const recovering = new Set<string>();

  async function recoverTurn(id: string) {
    if (recovering.has(id)) return;
    recovering.add(id);
    try {
      // A live owner may outlast the first observation window. Recheck at its
      // lease boundary until terminal, without stealing work or polling each second.
      // SQL remains authoritative if clocks drift or another owner renews the lease.
      while (!isClosed()) {
        try {
          const record = await turns.get(id);
          if (!record || record.authority.mode === "build" || "changeId" in record.command) return;
          if (record.state === "pending") {
            // Dispatch is tracked independently. Awaiting a provider here would
            // stop this very watcher from observing its lost lease.
            void dispatch(record).catch(reportFailure("Project agent dispatch"));
          } else if (record.state === "dispatching" || record.state === "running") {
            if (await turns.quarantineExpiredProject(id)) {
              await createUsageJournal(database).abandon(`turn:${id}`);
              return;
            }
          } else return;
          const expiry = record.ownerExpiresAt
            ? new Date(record.ownerExpiresAt).getTime()
            : Date.now();
          await wait(Math.max(25, Math.min(30_000, expiry - Date.now() + 25)), undefined, {
            signal: lifetime.signal,
          });
        } catch {
          // A failed observation is not a terminal result. Keep observing the
          // same identity at the existing lease cadence, never replay dispatch.
          if (!isClosed())
            await wait(30_000, undefined, { signal: lifetime.signal }).catch(() => {});
        }
      }
    } finally {
      recovering.delete(id);
    }
  }

  function observe(id: string) {
    if (!isClosed())
      void track(recoverTurn(id)).catch(reportFailure("Project agent turn recovery"));
  }

  async function recoverAll() {
    if (isClosed()) return;
    const openTurns = await database.db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          isNull(agentTurn.changeId),
          inArray(agentTurn.state, ["pending", "dispatching", "running"]),
        ),
      )
      .orderBy(asc(agentTurn.createdAt));
    for (const record of openTurns) {
      // respond records unavailable/failed/uncertain outcomes itself. A DB
      // failure leaves durable intent for the next startup, not a paid retry.
      observe(record.id);
    }
  }

  return { observe, recoverAll };
}
