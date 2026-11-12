import { expect, test } from "bun:test";
import { percentile, summarizeLifecycle } from "./benchmark-model";

test("nearest-rank percentiles keep all samples and do not mutate their order", () => {
  const values = [5, 1, 3, 2, 4];
  expect(percentile(values, 0.5)).toBe(3);
  expect(percentile(values, 0.95)).toBe(5);
  expect(values).toEqual([5, 1, 3, 2, 4]);
  expect(() => percentile([], 0.5)).toThrow();
  expect(() => percentile([Number.NaN], 0.5)).toThrow();
  expect(() => percentile([1], 0)).toThrow();
  expect(() => percentile([1], Number.NaN)).toThrow();
});

test("a failed state check or retained anonymous memory cannot be reported as success", () => {
  const summary = summarizeLifecycle([
    { pauseMS: 2, resumeToHealthyMS: 3, beforeAnonBytes: 100, afterAnonBytes: 0, preserved: true },
    {
      pauseMS: 4,
      resumeToHealthyMS: 5,
      beforeAnonBytes: 100,
      afterAnonBytes: 10,
      preserved: false,
    },
  ]);
  expect(summary.successfulRestores).toBe(1);
  expect(summary.samples).toBe(2);
  expect(summary.anonymousRAMReleased).toBe(false);
  expect(summary.resumeToHealthy.p95MS).toBe(5);
});

test("optional App-ready timing stays separate from full integrity timing", () => {
  const sample = {
    pauseMS: 2,
    resumeToHealthyMS: 5,
    beforeAnonBytes: 100,
    afterAnonBytes: 0,
    preserved: true,
  };
  expect(summarizeLifecycle([sample])).not.toHaveProperty("resumeToReady");
  const summary = summarizeLifecycle([{ ...sample, resumeToReadyMS: 3 }]);
  expect(summary.resumeToReady?.medianMS).toBe(3);
  expect(summary.resumeToHealthy.medianMS).toBe(5);
  expect(() => summarizeLifecycle([sample, { ...sample, resumeToReadyMS: 3 }])).toThrow();
  expect(() => summarizeLifecycle([{ ...sample, resumeToReadyMS: Number.NaN }])).toThrow();
});
