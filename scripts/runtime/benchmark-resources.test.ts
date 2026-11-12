import { expect, test } from "bun:test";
import { readBenchmarkResources } from "./benchmark-resources";

test("resource attribution retains raw counters and unavailable IO", () => {
  const group = {
    cpu: { usage_usec: 100, nr_throttled: 1, throttled_usec: 2 },
    memoryBytes: 1000,
    memory: { anon: 500, file: 500 },
    io: null,
    cpuMax: "300000 100000",
    memoryMax: "3221225472",
  };
  const sample = {
    owner: "owned-sandbox",
    timestamp: "2026-11-08T10:20:30Z",
    monotonicNS: 1000,
    worker: group,
    sandbox: group,
  };
  expect(readBenchmarkResources(sample)).toEqual(sample);
  expect(() =>
    readBenchmarkResources({
      ...sample,
      worker: { ...group, cpu: { usage_usec: Number.MAX_SAFE_INTEGER + 1 } },
    }),
  ).toThrow();
});
