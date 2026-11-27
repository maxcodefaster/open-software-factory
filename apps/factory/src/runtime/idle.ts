import {
  and,
  asc,
  eq,
  exists,
  sql as expression,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeCommitOperation,
  operation,
  runtimeAttempt,
  ticket,
  verification,
} from "#db/schema";
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
  const verificationRuntime = alias(runtimeAttempt, "verification_runtime");
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let after: string | null = null;

  async function reconcile() {
    if (!idleMS || closed) return;
    const candidates = await database.db
      .select({
        id: runtimeAttempt.id,
        projectID: runtimeAttempt.projectId,
        workspaceID: expression<string>`${runtimeAttempt.workspaceId}`,
        changeID: runtimeAttempt.changeId,
      })
      .from(runtimeAttempt)
      .where(
        and(
          isNotNull(runtimeAttempt.workspaceId),
          eq(runtimeAttempt.state, "ready"),
          after ? gt(runtimeAttempt.id, after) : undefined,
        ),
      )
      .orderBy(asc(runtimeAttempt.id))
      .limit(64);
    // Advance even when every candidate is busy. Activity remains ephemeral.
    after = candidates.length === 64 ? (candidates.at(-1)?.id ?? null) : null;
    for (const attempt of candidates) {
      if (closed) return;
      let claimed = false;
      let recorded = false;
      try {
        recorded = await database.client.begin(async (sql) => {
          const db = drizzleTransaction(sql);
          await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${attempt.projectID}`}))`;
          await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${attempt.workspaceID}`}))`;
          if (attempt.changeID) {
            // Same locks as Build admission. Read work again only after acquiring them.
            const changeTable = alias(change, "change");
            const ticketTable = alias(ticket, "ticket");
            await db
              .select({ id: changeTable.id })
              .from(changeTable)
              .innerJoin(ticketTable, eq(ticketTable.id, changeTable.ticketId))
              .where(eq(changeTable.id, attempt.changeID))
              .for("update", { of: [changeTable, ticketTable] });
          }
          const [current] = await db
            .select({ state: runtimeAttempt.state })
            .from(runtimeAttempt)
            .where(eq(runtimeAttempt.id, attempt.id))
            .for("update");
          if (current?.state !== "ready") return false;
          // The locked Attempt supplies its immutable, nullable Change identity
          // to all work predicates in this single demand snapshot.
          const [work] = await db
            .select({
              active: expression<boolean>`${or(
                exists(
                  db
                    .select({ id: agentTurn.id })
                    .from(agentTurn)
                    .where(
                      and(
                        eq(agentTurn.changeId, runtimeAttempt.changeId),
                        inArray(agentTurn.state, [
                          "pending",
                          "dispatching",
                          "running",
                          "uncertain",
                        ]),
                      ),
                    ),
                ),
                exists(
                  db
                    .select({ changeID: changeAgentSession.changeId })
                    .from(changeAgentSession)
                    .where(
                      and(
                        eq(changeAgentSession.changeId, runtimeAttempt.changeId),
                        or(
                          inArray(changeAgentSession.state, ["starting", "working"]),
                          changeAgentSession.stopPending,
                        ),
                      ),
                    ),
                ),
                exists(
                  db
                    .select({ id: changeCommitOperation.id })
                    .from(changeCommitOperation)
                    .where(
                      and(
                        eq(changeCommitOperation.changeId, runtimeAttempt.changeId),
                        notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                      ),
                    ),
                ),
              )}`,
              verificationWaiting: expression<boolean>`${exists(
                db
                  .select({ id: verification.id })
                  .from(verification)
                  .innerJoin(
                    verificationRuntime,
                    eq(verificationRuntime.id, verification.runtimeAttemptId),
                  )
                  .innerJoin(
                    operation,
                    and(
                      eq(operation.kind, "runtime.compute_wait"),
                      eq(operation.scopeType, "runtime_attempt"),
                      eq(operation.scopeId, expression`${verificationRuntime.id}::text`),
                      eq(
                        operation.idempotencyKey,
                        expression`'runtime.compute_wait:' || ${verificationRuntime.id}::text`,
                      ),
                    ),
                  )
                  .where(
                    and(
                      eq(verification.changeId, runtimeAttempt.changeId),
                      inArray(verification.state, ["pending", "runner-starting"]),
                      eq(verificationRuntime.state, "starting"),
                      isNull(verificationRuntime.stopIntendedAt),
                      expression`${operation.payload}->>'reason' = 'compute-capacity'`,
                    ),
                  ),
              )}`,
              reviewing: expression<boolean>`${and(
                expression`${reviewMS} > 0`,
                or(
                  exists(
                    db
                      .select({ id: verification.id })
                      .from(verification)
                      .where(
                        and(
                          eq(verification.changeId, runtimeAttempt.changeId),
                          or(
                            inArray(verification.state, ["pending", "runner-starting", "running"]),
                            gt(
                              verification.updatedAt,
                              expression`now() - make_interval(secs => ${reviewMS / 1000})`,
                            ),
                          ),
                        ),
                      ),
                  ),
                  exists(
                    db
                      .select({ id: changeCommitOperation.id })
                      .from(changeCommitOperation)
                      .where(
                        and(
                          eq(changeCommitOperation.changeId, runtimeAttempt.changeId),
                          eq(changeCommitOperation.state, "succeeded"),
                          gt(
                            changeCommitOperation.updatedAt,
                            expression`now() - make_interval(secs => ${reviewMS / 1000})`,
                          ),
                        ),
                      ),
                  ),
                ),
              )}`,
            })
            .from(runtimeAttempt)
            .where(eq(runtimeAttempt.id, attempt.id));
          // Keep submitted work warm unless its own Verification is waiting for
          // capacity. Ordinary idle/activity fences still protect attended work.
          if (
            work?.active ||
            (work?.reviewing && !work.verificationWaiting) ||
            !hub.claimIdle(attempt.id, idleMS, quietMS)
          )
            return false;
          claimed = true;
          // Idle is Pause, never an implicit destructive Stop. Official
          // Substrate owns snapshot retention; no Factorybox pause cap applies.
          await db
            .update(runtimeAttempt)
            .set({ state: "pausing", updatedAt: expression`now()` })
            .where(and(eq(runtimeAttempt.id, attempt.id), eq(runtimeAttempt.state, "ready")));
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
