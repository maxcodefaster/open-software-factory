import { expect, spyOn, test } from "bun:test";
import { createBackgroundJobs } from "./background-jobs";

test("observations never overlap and shutdown drains admitted work without replaying skipped ticks", async () => {
  const jobs = createBackgroundJobs();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  jobs.every(
    "unexpected failure",
    async () => {
      calls++;
      entered.resolve();
      await finish.promise;
    },
    1,
    true,
  );
  await entered.promise;
  await Bun.sleep(15);
  expect(calls).toBe(1);
  let closed = false;
  const closing = jobs.close().then(() => {
    closed = true;
  });
  expect(jobs.close()).toBe(jobs.close());
  await Bun.sleep(5);
  expect(closed).toBe(false);
  finish.resolve();
  await closing;
  expect(closed).toBe(true);
  await Bun.sleep(5);
  expect(calls).toBe(1);
});

test("a failed observation logs its redacted cause and does not prevent the next tick", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const jobs = createBackgroundJobs();
  const recovered = Promise.withResolvers<void>();
  let calls = 0;
  try {
    jobs.every(
      "Owned observation failed",
      async () => {
        if (++calls === 1) throw new Error("provider refused token=sk-secret-value");
        recovered.resolve();
      },
      1,
      true,
    );
    await recovered.promise;
    await jobs.close();
    expect(calls).toBeGreaterThanOrEqual(2);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("Owned observation failed");
    expect(logged).toContain("provider refused");
    expect(logged).not.toContain("sk-secret-value");
  } finally {
    await jobs.close();
    log.mockRestore();
  }
});
