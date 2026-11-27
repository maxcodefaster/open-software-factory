import { expect, test } from "bun:test";
import { startFactoryLifecycle } from "./lifecycle";

function startupFixture() {
  const calls: string[] = [];
  const work = async () => {
    calls.push("work");
  };
  const idle = async () => {};
  const observer = {
    start: work,
    close: idle,
    recover: work,
    sweep: work,
    drain: work,
    repair: work,
    reconcile: work,
    admitNativeCapacity: work,
    dispatchReadyPending: work,
    recoverRetainedStops: work,
    reconcileCleanup: work,
    shutdown: idle,
    renew: work,
  };
  return {
    calls,
    application: {
      ...Object.fromEntries(
        [
          "agentController",
          "attachmentStore",
          "buildBrowserController",
          "developerIDEEdge",
          "deliveryController",
          "environmentController",
          "environmentSecrets",
          "idleCompute",
          "implementationOrders",
          "knowledgeController",
          "learningWorker",
          "mcpConnections",
          "monitoringWorker",
          "projectAgentController",
          "projectSetup",
          "setupReadiness",
          "releaseController",
          "reviewMedia",
          "runtimeAccess",
          "runtimeController",
          "wikiSourceUpdates",
          "accessRevocation",
          "workspaceCommands",
          "workspaceFiles",
          "workspaceCollaboration",
          "workspaceSubmission",
        ].map((name) => [name, observer]),
      ),
      observeRecoveredRuntimes() {
        calls.push("runtime-recovery");
      },
    } as unknown as Parameters<typeof startFactoryLifecycle>[0],
  };
}

test("startup never dispatches recovery before its own public callback route is ready", async () => {
  const f = startupFixture();
  let ready = false;
  const close = startFactoryLifecycle(f.application, async () => ready);
  try {
    await Bun.sleep(20);
    expect(f.calls).toEqual([]);
    ready = true;
    const deadline = Date.now() + 2_500;
    while (!f.calls.length && Date.now() < deadline) await Bun.sleep(10);
    expect(f.calls).toContain("runtime-recovery");
    expect(f.calls.filter((value) => value === "runtime-recovery")).toHaveLength(1);
  } finally {
    await close();
  }
});

test("shutdown while callback readiness is pending cannot start delayed recovery", async () => {
  const f = startupFixture();
  const ready = Promise.withResolvers<boolean>();
  const close = startFactoryLifecycle(f.application, () => ready.promise);
  await Bun.sleep(10);
  const closing = close();
  ready.resolve(true);
  await closing;
  expect(f.calls).toEqual([]);
});

test("native startup never admits the retired Project image producer", async () => {
  const f = startupFixture();
  let producers = 0;
  Object.assign(f.application, {
    projectPreparation: {
      async drain() {
        producers++;
      },
    },
  });
  const close = startFactoryLifecycle(f.application);
  try {
    await Bun.sleep(2_100);
    expect(producers).toBe(0);
  } finally {
    await close();
  }
});

test("the process owns Delivery and Monitoring observations and drains them before shutdown", async () => {
  const finish = Promise.withResolvers<void>();
  const finishSetup = Promise.withResolvers<void>();
  const closed: string[] = [];
  let deliveries = 0;
  let monitoring = 0;
  let browserCleanups = 0;
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
    recoverRetainedStops: idle,
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
    buildBrowserController: {
      async reconcileCleanup() {
        browserCleanups++;
        await finish.promise;
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
    knowledgeController: {
      ...observer,
      async close() {
        closed.push("wiki");
      },
    },
    setupReadiness: {
      async close() {
        closed.push("setup");
        await finishSetup.promise;
      },
    },
    workspaceCommands: {
      async close() {
        closed.push("commands");
        await finish.promise;
      },
    },
    workspaceFiles: { close: idle },
    workspaceCollaboration: { close: idle },
    workspaceSubmission: { close: idle, recover: idle },
  } as unknown as Parameters<typeof startFactoryLifecycle>[0];
  const close = startFactoryLifecycle(application);
  try {
    await Bun.sleep(10);
    expect(deliveries).toBe(1);
    expect(monitoring).toBe(1);
    expect(browserCleanups).toBe(1);
    let drained = false;
    const pending = close().then(() => {
      drained = true;
    });
    expect(close()).toBe(close());
    await Bun.sleep(10);
    expect(closed).toContain("monitoring");
    expect(closed).toContain("wiki");
    expect(closed).toContain("commands");
    expect(closed).toContain("setup");
    expect(drained).toBe(false);
    finish.resolve();
    await Bun.sleep(10);
    expect(drained).toBe(false);
    finishSetup.resolve();
    await pending;
    expect(closed.sort()).toEqual(["commands", "delivery", "monitoring", "setup", "wiki"]);
    expect(deliveries).toBe(1);
    expect(browserCleanups).toBe(1);
  } finally {
    finish.resolve();
    finishSetup.resolve();
    await close();
  }
});
