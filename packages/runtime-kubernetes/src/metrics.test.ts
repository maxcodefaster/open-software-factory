import { expect, test } from "bun:test";
import { createCurrentMetrics, parsePodMetrics, readCurrentPodMetrics } from "./metrics";
const timestamp = "2026-10-11T12:00:00.000Z";
const fixture = {
  metadata: { name: "runtime-1", namespace: "owned" },
  timestamp,
  window: "15s",
  containers: [{ name: "worker", usage: { cpu: "150000000n", memory: "128Mi" } }],
};
test("current Factorybox worker metrics parse units, stale and wrong identity without fabricating zero", () => {
  expect(parsePodMetrics(fixture, "owned", "runtime-1", Date.parse(timestamp))).toEqual({
    status: "available",
    timestamp,
    cpuMilli: 150,
    memoryMiB: 128,
  });
  expect(parsePodMetrics(fixture, "owned", "runtime-1", Date.parse(timestamp) + 61000).status).toBe(
    "stale",
  );
  expect(parsePodMetrics(fixture, "other", "runtime-1").cpuMilli).toBeNull();
  expect(
    parsePodMetrics(
      { ...fixture, containers: [{ name: "worker", usage: { cpu: "0.5", memory: "1Gi" } }] },
      "owned",
      "runtime-1",
      Date.parse(timestamp),
    ).cpuMilli,
  ).toBe(500);
});
test("metrics require one exact worker and do not count init containers or old runtimes", () => {
  for (const containers of [
    [],
    [{ name: "envbox", usage: { cpu: "1", memory: "1Gi" } }],
    [fixture.containers[0]!, fixture.containers[0]!],
  ])
    expect(
      parsePodMetrics({ ...fixture, containers }, "owned", "runtime-1", Date.parse(timestamp))
        .status,
    ).toBe("unavailable");
  expect(
    parsePodMetrics(
      {
        ...fixture,
        containers: [
          { name: "runtime-image", usage: { cpu: "1", memory: "1Gi" } },
          ...fixture.containers,
        ],
      },
      "owned",
      "runtime-1",
      Date.parse(timestamp),
    ).memoryMiB,
  ).toBe(128);
});
test("pod replacement during observations cannot return old-identity metrics", async () => {
  let calls = 0;
  const raw = async (path: string) => {
    calls++;
    return {
      status: 200,
      body: path.includes("metrics.k8s.io")
        ? fixture
        : { metadata: { uid: calls === 1 ? "original" : "replacement" } },
    };
  };
  expect((await readCurrentPodMetrics("owned", "runtime-1", "original", raw)).status).toBe(503);
  expect(calls).toBe(3);
  calls = 0;
  expect((await readCurrentPodMetrics("owned", "runtime-1", "different", raw)).status).toBe(503);
  expect(calls).toBe(1);
});
test("metrics admission bounds concurrent CLI reads and reuses exact identity", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const read = createCurrentMetrics(
    async () => {
      calls++;
      await gate;
      return { status: 200, body: fixture };
    },
    () => Date.parse(timestamp),
  );
  const active = Array.from({ length: 4 }, (_, index) =>
    read("owned", "runtime-1", `uid-${index}`),
  );
  expect((await read("owned", "runtime-1", "fifth")).status).toBe("unavailable");
  const replay = read("owned", "runtime-1", "uid-0");
  expect(calls).toBe(4);
  release();
  await Promise.all([...active, replay]);
  expect((await read("owned", "runtime-1", "fifth")).status).toBe("available");
  expect(calls).toBe(5);
});
test("metrics cache is concurrent, bounded by time and preserves forbidden/unavailable", async () => {
  let calls = 0,
    time = Date.parse(timestamp),
    status = 200;
  const read = createCurrentMetrics(
    async () => {
      calls++;
      return { status, body: fixture };
    },
    () => time,
  );
  await Promise.all(Array.from({ length: 8 }, () => read("owned", "runtime-1", "uid")));
  expect(calls).toBe(1);
  time += 5001;
  status = 403;
  expect((await read("owned", "runtime-1", "uid")).status).toBe("forbidden");
  time += 5001;
  status = 503;
  expect((await read("owned", "runtime-1", "uid")).cpuMilli).toBeNull();
});
