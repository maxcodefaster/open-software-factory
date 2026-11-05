import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { factoryboxOperationFailure } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

let restore: () => void;
beforeAll(() => {
  restore = installOwnedRuntimeConfiguration();
});
afterAll(() => restore());

test("native Pause controls cannot prevent PostgreSQL from retaining the original failure", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const execution = createFactoryboxExecution(database, owned.hub, async () => {
      throw new Error("This diagnostic fixture must not call a native worker");
    });
    const controller = createRuntimeController(
      database,
      owned.hub,
      "owned-pause-diagnostic",
      {
        async prepareExecution() {
          throw new Error("Pause diagnostics must not prepare or replace Source");
        },
      },
      createKubernetesClient(),
      async () => "",
      undefined,
      {
        ...execution,
        async pause(id) {
          await database.client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${id}`;
          throw factoryboxOperationFailure("pause", "native\0 checkpoint\u0007 failed\n");
        },
      },
    );
    await expect(controller.pause(owned.attemptID)).rejects.toThrow(
      "Factorybox pause outcome is unconfirmed: native checkpoint failed",
    );
    const [retained] = await database.client<{ state: string; failure: string }[]>`
      SELECT state,failure FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    expect(retained?.state).toBe("pausing");
    expect(retained?.failure).toBe(
      "Factorybox pause outcome is unconfirmed: native checkpoint failed",
    );
  } finally {
    await database.client.end({ timeout: 1 });
    await process.dispose();
  }
}, 30_000);

test("a failed memory capture discards the Sandbox instead of leaving it half paused", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const execution = createFactoryboxExecution(database, owned.hub, async () => {
      throw new Error("This diagnostic fixture must not call a native worker");
    });
    const controller = createRuntimeController(
      database,
      owned.hub,
      "owned-pause-capture-failure",
      {
        async prepareExecution() {
          throw new Error("Pause diagnostics must not prepare or replace Source");
        },
      },
      createKubernetesClient(),
      async () => "",
      undefined,
      {
        ...execution,
        async pause(id) {
          await database.client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${id}`;
          throw factoryboxOperationFailure(
            "pause",
            "retained source capture: exit status 1: Error (criu/fsnotify.c:303): Can't dump that handle",
          );
        },
      },
    );
    await expect(controller.pause(owned.attemptID)).rejects.toThrow("retained source capture");
    const [retained] = await database.client<{ state: string }[]>`
      SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    expect(["stop-intended", "stopping", "stopped", "cleanup-failed"]).toContain(
      retained?.state ?? "",
    );
    // Let the Stop that Pause started settle before the owned database closes.
    await Bun.sleep(2_000);
  } finally {
    await database.client.end({ timeout: 1 });
    await process.dispose();
  }
}, 30_000);
