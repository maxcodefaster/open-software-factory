import { expect, test } from "bun:test";
import { createInvalidatedRead } from "./invalidated-read";

test("idle read observers do not poll and an in-flight invalidation gets a fresh read", async () => {
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  const observer = createInvalidatedRead({
    visible: () => true,
    async read() {
      reads++;
      if (reads === 1) await gate.promise;
    },
  });
  const pending = observer.refresh();
  void observer.refresh();
  void observer.refresh();
  expect(reads).toBe(1);
  gate.resolve();
  await pending;
  expect(reads).toBe(2);
  await Bun.sleep(20);
  expect(reads).toBe(2);
  observer.stop();
});

test("hidden invalidations wait for wake and stopping aborts rather than rescheduling", async () => {
  let visible = false,
    reads = 0;
  let signal: AbortSignal | undefined;
  const observer = createInvalidatedRead({
    visible: () => visible,
    async read(current) {
      reads++;
      signal = current;
    },
  });
  await observer.refresh();
  expect(reads).toBe(0);
  visible = true;
  await observer.refresh();
  expect(reads).toBe(1);
  observer.stop();
  await observer.refresh();
  expect(reads).toBe(1);
  expect(signal).toBeDefined();
});

test("failed reads report once and need another invalidation or explicit retry", async () => {
  const errors: unknown[] = [];
  let reads = 0;
  const observer = createInvalidatedRead({
    visible: () => true,
    async read() {
      reads++;
      throw new Error("unavailable");
    },
    onError: (cause) => errors.push(cause),
  });
  await observer.refresh();
  await Bun.sleep(20);
  expect(reads).toBe(1);
  expect(errors).toHaveLength(1);
  await observer.refresh();
  expect(reads).toBe(2);
  observer.stop();
});

test("stopping aborts the active read and suppresses late errors", async () => {
  const gate = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined,
    errors = 0;
  const observer = createInvalidatedRead({
    visible: () => true,
    async read(current) {
      signal = current;
      await gate.promise;
      throw new Error("late");
    },
    onError() {
      errors++;
    },
  });
  const pending = observer.refresh();
  observer.stop();
  expect(signal?.aborted).toBe(true);
  gate.resolve();
  await pending;
  expect(errors).toBe(0);
});
