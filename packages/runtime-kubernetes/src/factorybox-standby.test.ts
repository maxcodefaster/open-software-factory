import { expect, test } from "bun:test";
import { settleFactoryboxStandby } from "./factorybox-standby";

const sandboxID = `runtime-${"a".repeat(32)}`;
const snapshotID = "b".repeat(32);
function observation(phase: "running" | "paused", resumed = false) {
  return {
    record: {
      id: sandboxID,
      runtime_id: `fbx-${"c".repeat(32)}`,
      phase,
      pause: {
        snapshot_id: snapshotID,
        completed_at: "2026-10-26T12:00:00Z",
        after: { anon: 0 },
        snapshot: { resident_bytes_after: 0 },
        ...(resumed ? { resume: { completed_at: "2026-10-26T12:01:00Z" } } : {}),
      },
    },
    ...(phase === "running" ? { runtime: { status: "running" } } : {}),
  };
}

for (const action of ["pause", "resume"] as const) {
  test(`standby ${action} persists intent before exactly one native mutation`, async () => {
    const calls: string[] = [];
    const result = await settleFactoryboxStandby(sandboxID, snapshotID, action, {
      state: async () => observation(action === "pause" ? "running" : "paused"),
      intend: async (value) => {
        calls.push(`intend:${value}`);
        return true;
      },
      execute: async (operation) => {
        calls.push(`execute:${operation.action}`);
        expect(operation).toEqual({ action, sandboxID, snapshotID });
        return observation(action === "pause" ? "paused" : "running", action === "resume");
      },
    });
    expect(calls).toEqual([`intend:${action}`, `execute:${action}`]);
    expect(result.record.phase).toBe(action === "pause" ? "paused" : "running");
  });

  test(`lost standby ${action} output settles through observation without replay`, async () => {
    let mutations = 0;
    let intended = false;
    let current = observation(action === "pause" ? "running" : "paused");
    const commands = {
      state: async () => current,
      intend: async () => {
        expect(intended).toBe(false);
        intended = true;
        return true;
      },
      execute: async () => {
        mutations++;
        current = observation(action === "pause" ? "paused" : "running", action === "resume");
        throw new Error("lost native response");
      },
    };
    await expect(settleFactoryboxStandby(sandboxID, snapshotID, action, commands)).rejects.toThrow(
      "lost native response",
    );
    await settleFactoryboxStandby(sandboxID, snapshotID, action, commands);
    expect(mutations).toBe(1);
  });

  test(`an attempted but unconfirmed standby ${action} cannot be repeated`, async () => {
    let mutations = 0;
    await expect(
      settleFactoryboxStandby(sandboxID, snapshotID, action, {
        state: async () => observation(action === "pause" ? "running" : "paused"),
        intend: async () => false,
        execute: async () => {
          mutations++;
        },
      }),
    ).rejects.toThrow("observe without replay");
    expect(mutations).toBe(0);
  });
}

test("standby readiness requires the exact Sandbox, snapshot and released memory", async () => {
  for (const corrupt of [
    (value: ReturnType<typeof observation>) => {
      value.record.id = "runtime-other";
    },
    (value: ReturnType<typeof observation>) => {
      value.record.pause.snapshot_id = "d".repeat(32);
    },
    (value: ReturnType<typeof observation>) => {
      value.record.pause.completed_at = "";
    },
    (value: ReturnType<typeof observation>) => {
      value.record.pause.after.anon = 4096;
    },
    (value: ReturnType<typeof observation>) => {
      value.record.pause.snapshot.resident_bytes_after = 4096;
    },
  ]) {
    const value = observation("paused");
    corrupt(value);
    let mutations = 0;
    await expect(
      settleFactoryboxStandby(sandboxID, snapshotID, "pause", {
        state: async () => value,
        intend: async () => false,
        execute: async () => {
          mutations++;
        },
      }),
    ).rejects.toThrow();
    expect(mutations).toBe(0);
  }
});

test("a cold running slot cannot masquerade as a resumed standby", async () => {
  await expect(
    settleFactoryboxStandby(sandboxID, snapshotID, "resume", {
      state: async () => observation("running"),
      intend: async () => {
        throw new Error("must not commission work");
      },
      execute: async () => {
        throw new Error("must not cold-start");
      },
    }),
  ).rejects.toThrow("Resume is not confirmed");
});

test("another paused snapshot cannot commission standby Resume", async () => {
  const value = observation("paused");
  value.record.pause.snapshot_id = "d".repeat(32);
  let intended = false;
  await expect(
    settleFactoryboxStandby(sandboxID, snapshotID, "resume", {
      state: async () => value,
      intend: async () => {
        intended = true;
        return true;
      },
      execute: async () => {
        throw new Error("must not resume another snapshot");
      },
    }),
  ).rejects.toThrow("exact completed Pause");
  expect(intended).toBe(false);
});
