import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  defaultReservePolicy,
  type ReservePolicy,
  type ReserveRole,
  requireReservePolicy,
} from "../../../../packages/runtime-domain/src/reserve";
import { nativeLifecycleWindowMS } from "../../../../packages/runtime-domain/src/timing";
import { createKubernetesClient } from "../../../../packages/runtime-kubernetes/src/client";
import { withCommandDeadline } from "../../../../packages/runtime-kubernetes/src/command";
import {
  factoryboxOriginalWorkerRetired,
  factoryboxRuntimeProfile,
  releaseFactoryboxRuntime,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  executeFactoryboxOperation,
  factoryboxWorkerIdentity,
  runFactoryboxKubernetes,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import {
  createReserveClient,
  factoryboxReserveInput,
  type ReserveClient,
} from "../../../../packages/runtime-kubernetes/src/reserve";
import { reportFailure } from "../failure-log";
import {
  createNativeLease,
  currentNativeLease,
  gatedFactoryboxTransport,
  type NativeLease,
  type NativePriority,
  withNativeLease,
} from "./native-lock";
import { createReserveStore } from "./reserve-store";
import { createStagingTemplateProducer } from "./staging-template";
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
  const readyTarget = read("FACTORY_EXECUTION_RESERVE_TARGET", defaultReservePolicy.readyTarget);
  return requireReservePolicy({
    ...defaultReservePolicy,
    readyTarget,
    maxSlots: Math.max(2, readyTarget),
    maxExecutionSlots: read("FACTORY_EXECUTION_MAX_SLOTS", defaultReservePolicy.maxExecutionSlots),
  });
}

export function createExecutionReserve(
  database: Database,
  images: Readonly<Record<ReserveRole, string>>,
  policy = executionReservePolicy(process.env),
  adapter: ReserveClient = createReserveClient(
    undefined,
    undefined,
    {
      // Each native mutation holds the native lease only while it runs. The
      // lease was taken by the intent callback that preceded it.
      execute: async (...args: Parameters<typeof executeFactoryboxOperation>) => {
        try {
          return await executeFactoryboxOperation(...args);
        } finally {
          await currentNativeLease()?.release();
        }
      },
      release: releaseFactoryboxRuntime,
      retired: factoryboxOriginalWorkerRetired,
    },
    gatedFactoryboxTransport(runFactoryboxKubernetes),
  ),
) {
  const store = createReserveStore(policy, images);
  const templates = createStagingTemplateProducer(database, store, images);
  const worker = createFactoryboxWorker(database, createKubernetesClient());
  let closed = false;
  let running: Promise<void> | null = null;
  let requested = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  // The slot lock serializes one slot across processes. The native worker lock
  // is separate: a pass takes it only for native mutations (see native-lock.ts),
  // so preparing one slot never waits behind another slot's image export,
  // source archive or Kubernetes reads. Retirements yield to foreground work.
  async function withSlotLock<T>(
    id: string,
    priority: NativePriority,
    action: (sql: Database["client"], lease: NativeLease) => Promise<T>,
  ) {
    const sql = database.coordination();
    const key = `execution-slot:${id}`;
    const deadline = performance.now() + nativeLifecycleWindowMS;
    const lease = createNativeLease(sql, priority, () => deadline);
    try {
      await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
      return await withCommandDeadline(deadline, () =>
        withNativeLease(lease, () => action(sql, lease)),
      );
    } finally {
      try {
        await lease.release();
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    }
  }
  async function reconcile() {
    if (policy.readyTarget) {
      try {
        await templates.refresh();
      } catch (cause) {
        console.error(
          "Staging template source preparation deferred",
          cause instanceof Error ? cause.message : "Source is unavailable",
        );
      }
    }
    const due = await database.client.begin((sql) => store.plan(sql));
    for (const planned of due) {
      if (closed) return;
      await withSlotLock(
        planned.id,
        planned.state === "retiring" ? "background" : "foreground",
        async (sql, lease) => {
          // Intent and dispatch share one native lease: take it first, then record.
          // Another controller can finish preparation without changing "creating"
          // while this one waits. Start admission and the adapter must use the
          // same current preparation, never the pre-lock plan.
          const slot = await store.get(sql, planned.id);
          if (!slot || slot.state !== planned.state) return;
          try {
            if (slot.state === "retiring") {
              let retiring = slot;
              if (!slot.templateID && slot.sourceImportSHA256 && !slot.sourceImportObservation) {
                const id = slot.id;
                await templates.importSource(
                  slot,
                  factoryboxReserveInput(slot),
                  factoryboxWorkerIdentity.parse(slot.factoryboxIdentity),
                  async () => false,
                  (observation) => store.completeSourceImport(sql, id, observation),
                );
                const refreshed = await store.get(sql, id);
                if (refreshed?.state !== "retiring") return;
                retiring = refreshed;
              }
              await adapter.retire(retiring, {
                intendDelete: async () => {
                  await lease.acquire();
                  return store.intendDelete(sql, slot.id);
                },
                intendRetirement: (request) => store.intendRetirement(sql, slot.id, request),
                completeRetirement: (observation) =>
                  store.completeRetirement(sql, slot.id, observation),
                completeRetirementPart: (observation) =>
                  store.completeRetirementPart(sql, slot.id, observation),
              });
              await store.retired(sql, slot.id);
              requested = true;
            } else {
              // Start is dispatched in this same pass once it is admitted.
              if (
                slot.state === "creating" &&
                !slot.templateID &&
                slot.sourceImportObservation &&
                slot.factoryboxIdentity &&
                slot.factoryboxPreparation &&
                !slot.factoryboxStartAttempted
              )
                await lease.acquire();
              const startAllowed = await store.intendStart(sql, slot.id);
              const observed = await adapter.prepare(slot, {
                startAllowed,
                sourceTemplate: slot.templateID ? await store.get(sql, slot.templateID) : null,
                intendFork: async (request) => {
                  await lease.acquire();
                  return store.intendFork(sql, slot.id, request);
                },
                importSource: (input, identity) =>
                  templates.importSource(
                    slot,
                    input,
                    identity,
                    (sha256) => store.intendSourceImport(sql, slot.id, sha256),
                    (observation) => store.completeSourceImport(sql, slot.id, observation),
                  ),
                intendStandby: async (action) => {
                  await lease.acquire();
                  return store.intendStandby(sql, slot.id, action);
                },
                provision: (resources) =>
                  worker.provision(
                    resources,
                    factoryboxRuntimeProfile.parse(slot.factoryboxProfile),
                    slot.runtimeHostImage,
                  ),
              });
              if (observed.factoryboxIdentity)
                await rememberFactoryboxIdentity(
                  sql,
                  slot.workerID,
                  observed.factoryboxIdentity as Parameters<typeof rememberFactoryboxIdentity>[2],
                );
              await store.observe(sql, slot.id, observed);
              if (observed.failed) await store.retire(sql, slot.id);
              if (observed.ready || observed.failed) requested = true;
            }
          } catch (cause) {
            // Reconciliation errors are ephemeral operator diagnostics, not
            // authorization to replay an uncertain native command.
            console.error("Factorybox reserve reconciliation deferred", {
              slotID: slot.id,
              state: slot.state,
              error: (cause instanceof Error
                ? cause.message
                : "Native outcome is unconfirmed"
              ).slice(-2000),
            });
            await store.defer(sql, slot.id);
          }
        },
      );
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
      .catch(reportFailure("Execution reserve reconciliation"))
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
      return withSlotLock(slot.id, "foreground", (sql, lease) =>
        adapter.activate(slot, resources, {
          intendStandby: async (action) => {
            await lease.acquire();
            return store.intendStandby(sql, slot.id, action);
          },
        }),
      );
    },
    removed: (sql: SQL, attemptID: string) => store.usedRemoved(sql, attemptID),
    async cleanup(attemptID: string, generation: number) {
      const slot = await store.assigned(database.client, attemptID);
      if (!slot) return false;
      return withSlotLock(slot.id, "foreground", (sql, lease) =>
        adapter.removeAssigned(slot, generation, {
          intendDelete: async () => {
            await lease.acquire();
            return store.intendDelete(sql, slot.id);
          },
          intendRetirement: (request) => store.intendRetirement(sql, slot.id, request),
          completeRetirement: (observation) => store.completeRetirement(sql, slot.id, observation),
          completeRetirementPart: (observation) =>
            store.completeRetirementPart(sql, slot.id, observation),
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
