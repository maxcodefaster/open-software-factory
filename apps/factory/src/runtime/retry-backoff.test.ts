import { expect, test } from "bun:test";
import { createRetryBackoff } from "./retry-backoff";

test("doubles the wait after each failure up to the limit and clears on success", () => {
  let now = 0;
  const backoff = createRetryBackoff(15_000, 60_000, () => now);
  expect(backoff.due("slot")).toBe(true);
  backoff.failed("slot");
  expect(backoff.due("slot")).toBe(false);
  now = 14_999;
  expect(backoff.due("slot")).toBe(false);
  now = 15_000;
  expect(backoff.due("slot")).toBe(true);
  backoff.failed("slot");
  now = 15_000 + 29_999;
  expect(backoff.due("slot")).toBe(false);
  now = 15_000 + 30_000;
  expect(backoff.due("slot")).toBe(true);
  backoff.failed("slot");
  backoff.failed("slot");
  now += 59_999;
  expect(backoff.due("slot")).toBe(false);
  now += 1;
  expect(backoff.due("slot")).toBe(true);
  expect(backoff.due("other")).toBe(true);
  backoff.failed("slot");
  backoff.succeeded("slot");
  expect(backoff.due("slot")).toBe(true);
});
