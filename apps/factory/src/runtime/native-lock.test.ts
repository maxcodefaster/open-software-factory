import { expect, test } from "bun:test";
import { drainNativeOperations, trackNativeOperation } from "./native-lock";

test("shutdown waits for an admitted native operation and leaves an expired wait unconfirmed", async () => {
  const finish = Promise.withResolvers<void>();
  expect(trackNativeOperation(finish.promise)).toBe(finish.promise);
  const waiting = drainNativeOperations(5_000);
  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  await Bun.sleep(30);
  expect(settled).toBe(false);
  finish.resolve();
  expect(await waiting).toBe(0);

  const stuck = Promise.withResolvers<void>();
  trackNativeOperation(stuck.promise);
  expect(await drainNativeOperations(40)).toBe(1);
  stuck.resolve();
  expect(await drainNativeOperations(1_000)).toBe(0);
});

test("a rejected native operation keeps its original error and releases its shutdown registration", async () => {
  const failure = Promise.withResolvers<void>();
  const operation = trackNativeOperation(failure.promise);
  failure.reject(new Error("Original native outcome is unavailable"));
  await expect(operation).rejects.toThrow("Original native outcome is unavailable");
  expect(await drainNativeOperations(1_000)).toBe(0);
});
