import { expect, test } from "bun:test";
import { agentActivityResponse } from "./activity-response";

test("initial snapshot, event-driven replacement, and browser cancellation detach only reads", async () => {
  let notify = () => {};
  let reads = 0;
  let detached = false;
  let version = 1;
  const request = new AbortController();
  const response = agentActivityResponse({
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
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("Activity response has no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain('"version":1');
  await Bun.sleep(50);
  expect(reads).toBe(1);
  version = 2;
  notify();
  expect(decoder.decode((await reader.read()).value)).toContain('"version":2');
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
  const response = agentActivityResponse({
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
  if (!response.body) throw new Error("Activity response has no stream");
  const reader = response.body.getReader();
  const result = reader.read();
  await reading;
  authorized = false;
  release();
  await expect(result).rejects.toThrow("Build activity disconnected");
});

test("a slow reader keeps only the newest pending snapshot and receives it on pull", async () => {
  let notify = () => {};
  let version = 0;
  let reads = 0;
  const response = agentActivityResponse({
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
    coalesceMS: 0,
  });
  for (let i = 1; i <= 5; i++) {
    while (reads < i) await Bun.sleep(1);
    version = i;
    notify();
    await Bun.sleep(5);
  }
  if (!response.body) throw new Error("Activity response has no stream");
  const reader = response.body.getReader();
  const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
  expect(decode((await reader.read()).value)).toContain('"version":0');
  expect(decode((await reader.read()).value)).toContain('"version":5');
  await reader.cancel();
});
