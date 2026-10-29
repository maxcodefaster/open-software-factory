import { expect, test } from "bun:test";
import { agentActivityStream } from "./activity-stream";

test("initial snapshot, event-driven replacement, and browser cancellation detach only reads", async () => {
  let notify = () => {};
  let reads = 0;
  let detached = false;
  let version = 1;
  const request = new AbortController();
  const stream = agentActivityStream({
    signal: request.signal,
    authorize: async () => {},
    read: async () => {
      reads++;
      return { version };
    },
    subscribe: async (listener) => {
      notify = listener;
      return () => {
        detached = true;
      };
    },
    reconcileMS: 60_000,
    coalesceMS: 0,
  });
  const reader = stream.getReader();
  expect((await reader.read()).value).toEqual({ type: "snapshot", view: { version: 1 } });
  await Bun.sleep(50);
  expect(reads).toBe(1);
  version = 2;
  notify();
  expect((await reader.read()).value).toEqual({ type: "snapshot", view: { version: 2 } });
  await reader.cancel();
  for (let i = 0; i < 20 && !detached; i++) await Bun.sleep(5);
  expect(detached).toBe(true);
});

test("authority is checked again after a slow snapshot read, before any source is sent", async () => {
  let authorized = true;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stream = agentActivityStream({
    signal: new AbortController().signal,
    authorize: async () => {
      if (!authorized) throw new Error("revoked");
    },
    read: async () => {
      started();
      await blocked;
      return { source: "must-not-leak" };
    },
    subscribe: async () => () => {},
  });
  const reader = stream.getReader();
  const result = reader.read();
  await reading;
  authorized = false;
  release();
  await expect(result).rejects.toThrow("Build activity disconnected");
});

test.each([0, 20])(
  "a slow reader keeps only the newest pending snapshot with %dms coalescing",
  async (coalesceMS) => {
    let notify = () => {};
    let version = 0;
    let reads = 0;
    const stream = agentActivityStream({
      signal: new AbortController().signal,
      authorize: async () => {},
      read: async () => {
        reads++;
        return { version };
      },
      subscribe: async (listener) => {
        notify = listener;
        return () => {};
      },
      reconcileMS: 60_000,
      coalesceMS,
    });
    const reader = stream.getReader();
    try {
      while (reads < 1) await Bun.sleep(1);
      for (let i = 1; i <= 5; i++) {
        version = i;
        notify();
        // Join the replacement read instead of guessing when its timer will run.
        while (reads < i + 1) await Bun.sleep(1);
      }
      expect((await reader.read()).value).toEqual({ type: "snapshot", view: { version: 0 } });
      expect((await reader.read()).value).toEqual({ type: "snapshot", view: { version: 5 } });
    } finally {
      await reader.cancel();
    }
  },
);
