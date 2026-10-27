import { expect, test } from "bun:test";
import { startFactoryLifecycle } from "./lifecycle";

test("the process owns Delivery and Monitoring observations and drains them before shutdown", async () => {
  const finish = Promise.withResolvers<void>();
  const closed: string[] = [];
  let deliveries = 0;
  let monitoring = 0;
  const idle = async () => {};
  const observer = {
    start: idle,
    close: idle,
    recover: idle,
    sweep: idle,
    drain: idle,
    repair: idle,
    reconcile: idle,
    reclaimStorage: idle,
    drainComputeWaits: idle,
    dispatchReadyPending: idle,
    shutdown: idle,
    renew: idle,
  };
  const names = [
    "agentController",
    "attachmentStore",
    "developerIDEEdge",
    "environmentController",
    "environmentSecrets",
    "executionReserve",
    "idleCompute",
    "implementationOrders",
    "knowledgeController",
    "learningWorker",
    "mcpConnections",
    "projectPreparation",
    "projectSetup",
    "projectAgentController",
    "releaseController",
    "reviewMedia",
    "runtimeAccess",
    "runtimeController",
    "wikiSourceUpdates",
    "accessRevocation",
  ];
  const application = {
    ...Object.fromEntries(names.map((name) => [name, observer])),
    observeRecoveredRuntimes() {},
    deliveryController: {
      async sweep() {
        deliveries++;
        await finish.promise;
      },
      async close() {
        closed.push("delivery");
      },
    },
    monitoringWorker: {
      async sweep() {
        monitoring++;
      },
      async close() {
        closed.push("monitoring");
        await finish.promise;
      },
    },
  } as unknown as Parameters<typeof startFactoryLifecycle>[0];
  const close = startFactoryLifecycle(application);
  try {
    await Bun.sleep(10);
    expect(deliveries).toBe(1);
    expect(monitoring).toBe(1);
    let drained = false;
    const pending = close().then(() => {
      drained = true;
    });
    expect(close()).toBe(close());
    await Bun.sleep(10);
    expect(closed).toContain("monitoring");
    expect(drained).toBe(false);
    finish.resolve();
    await pending;
    expect(closed.sort()).toEqual(["delivery", "monitoring"]);
    expect(deliveries).toBe(1);
  } finally {
    finish.resolve();
    await close();
  }
});
