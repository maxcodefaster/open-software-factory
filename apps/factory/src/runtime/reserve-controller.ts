import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  defaultReservePolicy,
  type ReservePolicy,
  type ReserveRole,
  requireReservePolicy,
} from "../../../../packages/runtime-domain/src/reserve";
import { createKubernetesClient } from "../../../../packages/runtime-kubernetes/src/client";
import { factoryboxRuntimeProfile } from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  createReserveClient,
  type ReserveClient,
} from "../../../../packages/runtime-kubernetes/src/reserve";
import { createReserveStore } from "./reserve-store";
import { createFactoryboxWorker, rememberFactoryboxIdentity } from "./worker";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | TransactionSql;

export function executionReservePolicy(
  environment: Readonly<Record<string, string | undefined>>,
): ReservePolicy {
  const read = (key: string, fallback: number) => {
    const value = environment[key];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value))
      throw new Error("Execution reserve configuration requires bounded integers");
    return Number(value);
  };
  const readyPerRole = read("FACTORY_EXECUTION_RESERVE_TARGET", defaultReservePolicy.readyPerRole);
  return requireReservePolicy({
    ...defaultReservePolicy,
    readyPerRole,
    maxSlots: Math.max(2, 2 * readyPerRole),
    maxExecutionSlots: read("FACTORY_EXECUTION_MAX_SLOTS", defaultReservePolicy.maxExecutionSlots),
  });
}

export function createExecutionReserve(
  database: Database,
  images: Readonly<Record<ReserveRole, string>>,
  policy = executionReservePolicy(process.env),
  adapter: ReserveClient = createReserveClient(),
) {
  const store = createReserveStore(policy, images);
  const worker = createFactoryboxWorker(database, createKubernetesClient());
  let closed = false;
  let running: Promise<void> | null = null;
  let requested = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function withSlotLock<T>(id: string, action: (sql: Database["client"]) => Promise<T>) {
    const sql = database.coordination();
    const key = `execution-slot:${id}`;
    try {
      await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
      return await action(sql);
    } finally {
      try {
        await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  }
  async function reconcile() {
    const due = await database.client.begin((sql) => store.plan(sql));
    for (const planned of due) {
      if (closed) return;
      await withSlotLock(planned.id, async (sql) => {
        const [state] = await sql<
          Array<{ state: string }>
        >`SELECT state FROM factory.execution_slot WHERE id=${planned.id}`;
        if (state?.state !== planned.state) return;
        try {
          if (planned.state === "retiring") {
            await adapter.retire(planned, {
              intendDelete: () => store.intendDelete(sql, planned.id),
              intendRetirement: (request) => store.intendRetirement(sql, planned.id, request),
              completeRetirement: (observation) =>
                store.completeRetirement(sql, planned.id, observation),
            });
            await store.retired(sql, planned.id);
            requested = true;
          } else {
            const startAllowed = await store.intendStart(sql, planned.id);
            const observed = await adapter.prepare(planned, {
              startAllowed,
              intendStandby: (action) => store.intendStandby(sql, planned.id, action),
              provision: (resources) =>
                worker.provision(
                  resources,
                  factoryboxRuntimeProfile.parse(planned.factoryboxProfile),
                  planned.runtimeHostImage,
                ),
            });
            if (observed.factoryboxIdentity)
              await rememberFactoryboxIdentity(
                sql,
                planned.workerID,
                observed.factoryboxIdentity as Parameters<typeof rememberFactoryboxIdentity>[2],
              );
            await store.observe(sql, planned.id, observed);
            if (observed.failed) await store.retire(sql, planned.id);
            if (observed.ready || observed.failed) requested = true;
          }
        } catch {
          await store.defer(sql, planned.id);
        }
      });
    }
  }
  function wake(): Promise<void> {
    requested = true;
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      do {
        requested = false;
        await reconcile();
      } while (requested && !closed);
    })()
      .catch(() => {})
      .finally(() => {
        running = null;
      });
    return running;
  }
  return {
    admit: (
      sql: SQL,
      attemptID: string,
      role?: ReserveRole,
      owner?: {
        projectID: string;
        kind: "development" | "staging" | "verification" | "prebuild" | "publication";
      },
    ) => store.admit(sql, attemptID, role, owner),
    assigned: (sql: SQL, attemptID: string) => store.assigned(sql, attemptID),
    async activate(attemptID: string, resources: readonly unknown[]) {
      const slot = await store.assigned(database.client, attemptID);
      if (!slot) return null;
      if (slot.state !== "assigned")
        throw new Error("Used execution slot cannot restart as unassigned compute");
      return withSlotLock(slot.id, (sql) =>
        adapter.activate(slot, resources, {
          intendStandby: (action) => store.intendStandby(sql, slot.id, action),
        }),
      );
    },
    removed: (sql: SQL, attemptID: string) => store.usedRemoved(sql, attemptID),
    async cleanup(attemptID: string, generation: number) {
      const slot = await store.assigned(database.client, attemptID);
      if (!slot) return false;
      return withSlotLock(slot.id, (sql) =>
        adapter.removeAssigned(slot, generation, {
          intendDelete: () => store.intendDelete(sql, slot.id),
          intendRetirement: (request) => store.intendRetirement(sql, slot.id, request),
          completeRetirement: (observation) => store.completeRetirement(sql, slot.id, observation),
        }),
      );
    },
    async start() {
      await wake();
      timer = setInterval(() => void wake(), 5_000);
      timer.unref();
    },
    refill: () => {
      void wake();
    },
    reconcile: wake,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await running;
    },
  };
}
export type ExecutionReserve = ReturnType<typeof createExecutionReserve>;
