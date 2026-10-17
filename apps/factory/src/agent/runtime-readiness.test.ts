import { expect, test } from "bun:test";
import { waitForBuildSandbox } from "./runtime-readiness";

test("cold Build startup follows the recorded runtime lifecycle rather than an unrelated poll count", async () => {
  let observations = 0;
  const result = await waitForBuildSandbox(
    "owned-attempt",
    async () => ({
      active: true,
      runtimeAttemptID: "owned-attempt",
      runtimeState: ++observations > 370 ? "ready" : "starting",
    }),
    () => false,
    async () => {},
  );
  expect(result.runtimeAttemptID).toBe("owned-attempt");
  expect(observations).toBe(371);
});

test("failed or stopped runtime outcomes stop startup before any dispatch", async () => {
  for (const runtimeState of ["failed", "stopped", "cleanup-failed"])
    await expect(
      waitForBuildSandbox(
        "owned-attempt",
        async () => ({ active: true, runtimeAttemptID: "owned-attempt", runtimeState }),
        () => false,
        async () => {
          throw new Error("A terminal runtime must not be polled again");
        },
      ),
    ).rejects.toThrow("failed before OpenCode");
});

test("startup never retargets to a replacement runtime generation", async () => {
  await expect(
    waitForBuildSandbox(
      "original-attempt",
      async () => ({
        active: true,
        runtimeAttemptID: "different-attempt",
        runtimeState: "ready",
      }),
      () => false,
    ),
  ).rejects.toThrow("generation changed");
});

test("confirmed Stop and Factory shutdown interrupt waiting without claiming a runtime timeout", async () => {
  await expect(
    waitForBuildSandbox(
      "owned-attempt",
      async () => ({ active: false, runtimeAttemptID: "owned-attempt", runtimeState: "starting" }),
      () => false,
    ),
  ).rejects.toThrow("startup was stopped");
  let closed = false;
  await expect(
    waitForBuildSandbox(
      "owned-attempt",
      async () => ({ active: true, runtimeAttemptID: "owned-attempt", runtimeState: "starting" }),
      () => closed,
      async () => {
        closed = true;
      },
    ),
  ).rejects.toThrow("startup was stopped");
});
