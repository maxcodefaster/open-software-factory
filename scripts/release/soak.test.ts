import { expect, test } from "bun:test";
import { healthViolations, planCycle, unallowedLogLines } from "./soak";

test("a 20 minute cycle runs Wiki and backup hourly and one Ticket journey every six hours", () => {
  const plans = Array.from({ length: 72 }, (_, cycle) => planCycle(cycle, 20));
  expect(plans.filter((plan) => plan.wiki).length).toBe(24);
  expect(plans.filter((plan) => plan.backup).length).toBe(24);
  expect(plans.filter((plan) => plan.journey).map((plan) => plan.cycle)).toEqual([18, 36, 54]);
  expect(planCycle(0, 20).journey).toBe(false);
});

test("only log lines nobody allowed count as trouble", () => {
  const log = [
    "[factory] listening",
    "[factory] Error: connection reset by peer",
    "[factory] Wiki topic x failed: retrying",
    "[factory] runtime ready timing {}",
  ].join("\n");
  expect(unallowedLogLines(log, [])).toHaveLength(2);
  expect(unallowedLogLines(log, [/connection reset/, /Wiki topic/])).toEqual([]);
});

test("a restart, a replaced worker or a failed attempt stops the soak", () => {
  const healthy = {
    baseline: { restarts: 0, workerPod: "worker-a" },
    restarts: 0,
    workerPod: "worker-a",
    workerPhase: "Running",
    badAttempts: 0,
    freeDiskGiB: 40,
  };
  expect(healthViolations(healthy)).toEqual([]);
  expect(healthViolations({ ...healthy, restarts: 1 })).toHaveLength(1);
  expect(healthViolations({ ...healthy, workerPod: "worker-b" })).toHaveLength(1);
  expect(healthViolations({ ...healthy, badAttempts: 2, freeDiskGiB: 3 })).toHaveLength(2);
});
