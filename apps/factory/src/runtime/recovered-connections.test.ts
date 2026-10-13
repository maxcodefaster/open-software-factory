import { expect, test } from "bun:test";
import { recoveredConnectionObserver } from "./recovered-connections";

test("restart reconnect grace begins after listener availability, once, and covers transport detection", async () => {
  const checks: Array<{ check: () => Promise<void>; delayMS: number }> = [];
  const failed: string[] = [];
  const connected = new Set<string>();
  const states = new Map([
    ["ready", "starting"],
    ["starting", "starting"],
    ["stopped", "stopped"],
  ]);
  const arm = recoveredConnectionObserver(
    [
      { id: "ready", state: "ready" },
      { id: "starting", state: "starting" },
      { id: "stopped", state: "stopped" },
    ],
    {
      schedule: (check, delayMS) => checks.push({ check, delayMS }),
      connected: (id) => connected.has(id),
      state: async (id) => states.get(id),
      disconnected: async (id) => {
        failed.push(id);
      },
    },
  );
  expect(checks).toHaveLength(0);
  arm();
  arm();
  expect(checks.map(({ delayMS }) => delayMS)).toEqual([60_000, 300_000]);
  connected.add("ready");
  await checks[0]?.check();
  expect(failed).toEqual([]);
  states.set("starting", "stopped");
  await checks[1]?.check();
  expect(failed).toEqual([]);
  connected.delete("ready");
  await checks[0]?.check();
  expect(failed).toEqual(["ready"]);
});
