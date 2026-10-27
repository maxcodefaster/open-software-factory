import { expect, spyOn, test } from "bun:test";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import type { ReserveClient } from "../../packages/runtime-kubernetes/src/reserve";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

test("queued reserve controllers use the preparation committed under the slot lock before admitting Start", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controllers: ReturnType<typeof createExecutionReserve>[] = [];
  const pending: Promise<void>[] = [];
  const images = {
    staging: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    verification: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  };
  const store = createReserveStore(defaultReservePolicy, images);
  const prepared = { bundle: "owned-private-input" };
  const observations = { namespaceUID: "namespace", podUID: "pod", claimUID: "claim" };
  const starts: string[] = [];
  const calls: Array<{ prepared: boolean; startAllowed: boolean; startAttempted: boolean }> = [];
  try {
    const [slot] = await database.client.begin((sql) => store.plan(sql));
    if (!slot) throw new Error("Owned reserve slot missing");
    await store.observe(database.client, slot.id, {
      ...observations,
      ready: false,
      factoryboxIdentity: { epoch: "owned" },
    });
    await database.client`UPDATE factory.execution_slot SET reconcile_after=now() WHERE id=${slot.id}`;
    const adapter: ReserveClient = {
      async prepare(current, options) {
        if (!options) throw new Error("Expected durable Start admission");
        calls.push({
          prepared: Boolean(current.factoryboxPreparation),
          startAllowed: options.startAllowed,
          startAttempted: current.factoryboxStartAttempted === true,
        });
        if (!current.factoryboxPreparation) {
          entered.resolve();
          await release.promise;
          return {
            ...observations,
            ready: false,
            failed: false,
            factoryboxPreparation: prepared,
          };
        }
        if (options.startAllowed) starts.push(current.id);
        if (!starts.includes(current.id))
          throw new Error("Native Sandbox record is absent despite recorded Start intent");
        return { ...observations, ready: false, failed: false };
      },
      async retire() {
        throw new Error("Unexpected retirement");
      },
      async activate() {
        throw new Error("Unexpected assignment");
      },
      async removeAssigned() {
        throw new Error("Unexpected assigned cleanup");
      },
    };
    const first = createExecutionReserve(database, images, defaultReservePolicy, adapter);
    const second = createExecutionReserve(database, images, defaultReservePolicy, adapter);
    controllers.push(first, second);
    pending.push(first.reconcile());
    await entered.promise;
    pending.push(second.reconcile());
    // Prove the second controller has planned the old slot and is waiting on
    // the real PostgreSQL lock. A sleep would not establish this interleaving.
    await eventually(
      () => database.client`
        SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event='advisory' AND query LIKE '%pg_advisory_lock%'`,
      (rows) => rows.length === 1,
      "Second reserve controller never waited on the first slot owner",
    );
    release.resolve();
    await Promise.all(pending);
    expect(calls.slice(0, 2)).toEqual([
      { prepared: false, startAllowed: false, startAttempted: false },
      { prepared: true, startAllowed: true, startAttempted: false },
    ]);
    expect(starts).toEqual([slot.id]);
    const [persisted] = await database.client`
      SELECT state,factorybox_start_attempted AS started,factorybox_preparation AS preparation
        FROM factory.execution_slot WHERE id=${slot.id}`;
    expect(persisted).toEqual({ state: "creating", started: true, preparation: prepared });
    await database.client`UPDATE factory.execution_slot SET reconcile_after=now() WHERE id=${slot.id}`;
    await first.reconcile();
    expect(calls.at(-1)).toEqual({
      prepared: true,
      startAllowed: false,
      startAttempted: true,
    });
    expect(starts).toEqual([slot.id]);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await Promise.all(controllers.map((controller) => controller.close()));
    await database.client.end({ timeout: 2 });
    await host.dispose();
    restoreConfiguration();
  }
}, 30_000);

test("a missing native record never authorizes another Start after durable admission", async () => {
  const restoreConfiguration = installOwnedRuntimeConfiguration();
  const host = await factoryProcess();
  const database = host.connect();
  const images = {
    staging: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    verification: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  };
  const store = createReserveStore(defaultReservePolicy, images);
  const admissions: boolean[] = [];
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const controller = createExecutionReserve(database, images, defaultReservePolicy, {
    async prepare(slot, options) {
      if (!options) throw new Error("Expected durable Start admission");
      admissions.push(options.startAllowed);
      expect(slot.factoryboxPreparation).toEqual({ bundle: "owned-private-input" });
      expect(slot.factoryboxStartAttempted).toBe(true);
      throw new Error("Native Sandbox record is absent");
    },
    async retire() {
      throw new Error("Unexpected retirement");
    },
    async activate() {
      throw new Error("Unexpected assignment");
    },
    async removeAssigned() {
      throw new Error("Unexpected assigned cleanup");
    },
  });
  try {
    const [slot] = await database.client.begin((sql) => store.plan(sql));
    if (!slot) throw new Error("Owned reserve slot missing");
    await store.observe(database.client, slot.id, {
      namespaceUID: "namespace",
      podUID: "pod",
      claimUID: "claim",
      ready: false,
      factoryboxIdentity: { epoch: "owned" },
      factoryboxPreparation: { bundle: "owned-private-input" },
    });
    expect(await store.intendStart(database.client, slot.id)).toBe(true);
    for (let index = 0; index < 2; index++) {
      await database.client`UPDATE factory.execution_slot SET reconcile_after=now() WHERE id=${slot.id}`;
      await controller.reconcile();
    }
    expect(admissions).toEqual([false, false]);
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(await store.get(database.client, slot.id)).toMatchObject({
      state: "creating",
      factoryboxStartAttempted: true,
      factoryboxDeleteAttempted: false,
    });
  } finally {
    await controller.close();
    diagnostic.mockRestore();
    await database.client.end({ timeout: 2 });
    await host.dispose();
    restoreConfiguration();
  }
}, 30_000);
