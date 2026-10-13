import { expect, spyOn, test } from "bun:test";
import { createLifecyclePoller } from "./lifecycle-poller";

test("joins overlapping refreshes and pauses reads while hidden", async () => {
  let reads = 0;
  let visible = true;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const poller = createLifecyclePoller({
    read: async () => {
      reads += 1;
      await gate;
    },
    visible: () => visible,
    onError() {},
  });
  const first = poller.refresh();
  const second = poller.refresh();
  expect(reads).toBe(1);
  release();
  await Promise.all([first, second]);
  visible = false;
  await poller.refresh();
  expect(reads).toBe(1);
  poller.stop();
});

test("stopping aborts the active read and does not schedule another", async () => {
  let signal: AbortSignal | undefined;
  const poller = createLifecyclePoller({
    read: async (value) => {
      signal = value;
    },
    visible: () => true,
    onError() {},
  });
  const request = poller.refresh();
  poller.stop();
  await request;
  expect(signal?.aborted).toBe(true);
});

test("backs off repeated failures to thirty seconds and resets after recovery", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  let failing = true;
  let error = "";
  const poller = createLifecyclePoller({
    read: async () => {
      if (failing) throw new Error("Offline");
    },
    visible: () => true,
    onError: (value) => {
      error = value;
    },
  });
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) await poller.refresh();
    expect(timer.mock.calls.map((call) => call[1])).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(error).toBe("Offline");
    failing = false;
    await poller.refresh();
    expect(timer.mock.calls.at(-1)?.[1]).toBe(1_000);
    expect(error).toBe("");
  } finally {
    poller.stop();
    timer.mockRestore();
  }
});
