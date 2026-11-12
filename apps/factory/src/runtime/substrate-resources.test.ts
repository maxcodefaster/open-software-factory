import { expect, test } from "bun:test";
import { substrateResourceReservation } from "./substrate-resources";
import { renderSubstrateTemplate } from "./substrate-template";

test("native templates keep legacy limits or freeze explicit positive finite resource selections", () => {
  const config = {
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    workerSelector: { "factory.dev/deployment": "owned" },
  };
  expect(substrateResourceReservation({})).toEqual({ cpuMilli: 1500, memoryMiB: 1024 });
  expect(renderSubstrateTemplate("owned", config, {}).resources.limits).toEqual({
    cpuMillicores: "1500",
    memoryBytes: "1073741824",
  });
  const selected = { ...config, resources: { cpuMilli: 2000, memoryMiB: 4096 } };
  expect(renderSubstrateTemplate("owned", selected, {}).resources.limits).toEqual({
    cpuMillicores: "2000",
    memoryBytes: "4294967296",
  });
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    expect(() =>
      substrateResourceReservation({ resources: { cpuMilli: value, memoryMiB: 4096 } }),
    ).toThrow();
    expect(() =>
      substrateResourceReservation({ resources: { cpuMilli: 2000, memoryMiB: value } }),
    ).toThrow();
  }
});
