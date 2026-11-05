import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

let restoreConfiguration: () => void;
beforeAll(() => {
  restoreConfiguration = installOwnedRuntimeConfiguration();
});
afterAll(() => {
  restoreConfiguration();
});

// Start fresh discards a paused Sandbox only when its failed Resume is confirmed, then starts a
// normal new Attempt. Stop and Start are spied here; their native behaviour has its own proofs.
test("Start fresh needs a confirmed failed Resume, waits for the Stop and repeats safely", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const owned = await fixture(undefined, undefined, database);
  const hub = new RuntimeHub(async () => {});
  const controller = createRuntimeController(
    database,
    hub,
    "owned-start-fresh-secret",
    {
      prepareExecution: async () => {
        throw new Error("Start fresh must not prepare source itself");
      },
    },
    createKubernetesClient(),
    async () => "",
  );
  const state = async () =>
    (
      await database.client<
        Array<{ state: string; stamped: boolean }>
      >`SELECT state,resume_failed_at IS NOT NULL AS stamped FROM factory.runtime_attempt WHERE id=${owned.attemptID}`
    )[0];
  const calls: string[] = [];
  const stop = spyOn(controller, "stop");
  const startPersisted = spyOn(controller, "startPersisted");
  try {
    stop.mockImplementation(async (attemptID: string) => {
      calls.push("stop");
      await database.client`UPDATE factory.runtime_attempt SET state='stopped',stop_intended_at=now(),stopped_at=now(),failure=NULL WHERE id=${attemptID}`;
      return controller.get(attemptID);
    });
    startPersisted.mockImplementation((async (changeID: string, userID: string) => {
      calls.push(`start:${changeID === owned.changeID}:${userID === owned.userID}`);
      return null;
    }) as never);

    // An unknown outcome is never discarded, however the attempt looks.
    await database.client`UPDATE factory.runtime_attempt SET state='resuming',failure='Factorybox resume outcome is unconfirmed: reply lost' WHERE id=${owned.attemptID}`;
    await expect(controller.startFresh(owned.attemptID, owned.userID)).rejects.toThrow(
      "has not confirmed that the restore failed",
    );
    expect(calls).toEqual([]);
    expect((await controller.get(owned.attemptID))?.restoreFailed).toBe(false);

    // A confirmed failure is offered as restoreFailed, and only while the attempt is resuming.
    await database.client`UPDATE factory.runtime_attempt SET resume_failed_at=now(),failure='The paused Sandbox could not be restored: EAGAIN' WHERE id=${owned.attemptID}`;
    expect((await controller.get(owned.attemptID))?.restoreFailed).toBe(true);
    expect(
      (await controller.list(owned.projectID, owned.userID)).find(
        (row) => row.id === owned.attemptID,
      )?.restoreFailed,
    ).toBe(true);

    await controller.startFresh(owned.attemptID, owned.userID);
    expect(calls).toEqual(["stop", "start:true:true"]);
    expect(await state()).toEqual({ state: "stopped", stamped: true });
    expect((await controller.get(owned.attemptID))?.restoreFailed).toBe(false);

    // Repeating after the Stop finished goes straight to Start; it never stops again.
    await controller.startFresh(owned.attemptID, owned.userID);
    expect(calls).toEqual(["stop", "start:true:true", "start:true:true"]);

    // A Stop still in progress is waited for rather than repeated.
    await database.client`UPDATE factory.runtime_attempt SET state='stopping' WHERE id=${owned.attemptID}`;
    const waiting = controller.startFresh(owned.attemptID, owned.userID);
    await Bun.sleep(700);
    expect(calls).toHaveLength(3);
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    await waiting;
    expect(calls).toEqual(["stop", "start:true:true", "start:true:true", "start:true:true"]);

    // Unconfirmed cleanup starts nothing new and says so.
    await database.client`UPDATE factory.runtime_attempt SET state='cleanup-failed' WHERE id=${owned.attemptID}`;
    stop.mockImplementationOnce(async (attemptID: string) => {
      calls.push("stop-retry");
      return controller.get(attemptID);
    });
    await expect(controller.startFresh(owned.attemptID, owned.userID)).rejects.toThrow(
      "could not be confirmed",
    );
    expect(calls.at(-1)).toBe("stop-retry");
    // A discard that could not be confirmed is offered again, not left as a dead end.
    expect((await controller.get(owned.attemptID))?.restoreFailed).toBe(true);
    // A running Sandbox is not waiting to be restored.
    await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
    await expect(controller.startFresh(owned.attemptID, owned.userID)).rejects.toThrow(
      "not waiting to be restored",
    );
    expect(calls).toHaveLength(5);
  } finally {
    stop.mockRestore();
    startPersisted.mockRestore();
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);
