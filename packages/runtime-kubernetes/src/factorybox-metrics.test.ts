import { expect, test } from "bun:test";
import { factoryboxLocation } from "./factorybox-location";
import { createFactoryboxMetrics } from "./factorybox-metrics";
import type { FactoryboxRuntimeInput } from "./factorybox-runtime";
import type { FactoryboxWorkerIdentity } from "./factorybox-worker";

const workerID = "11111111-1111-4111-8111-111111111111";
const attemptID = "22222222-2222-4222-8222-222222222222";
const input: FactoryboxRuntimeInput = {
  ...factoryboxLocation(workerID),
  attemptID,
  sandboxID: `runtime-${attemptID.replaceAll("-", "")}`,
  runtimeOwnerID: attemptID,
  labels: {},
  runtimeHostImage: `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
  sharedSource: true,
  profile: {
    image: `registry.invalid/worker@sha256:${"b".repeat(64)}`,
    executableSHA256: "c".repeat(64),
    architecture: "arm64",
    nodeName: "owned-node",
    kernel: "owned-kernel",
    boundedBytes: 8589934592,
    claimGiB: 32,
  },
};
const identity: FactoryboxWorkerIdentity = {
  version: 1,
  namespaceUID: "namespace",
  podUID: "pod",
  claimUID: "claim",
  storeID: workerID.replaceAll("-", ""),
  epoch: "d".repeat(32),
  bootID: "boot",
  nodeBootID: "node-boot",
  executableSHA256: "c".repeat(64),
  controllerRoot: `/store/epochs/${"d".repeat(32)}/controller`,
};
const target = { input, identity };
const now = Date.parse("2026-10-26T12:00:00Z");
const observation = (time = now, cpuUsec = 1000, memory = 32) => ({
  status: 200,
  body: {
    owner: "e".repeat(32),
    timestamp: new Date(time).toISOString(),
    monotonicNS: Math.max(1, time - now + 1) * 1_000_000,
    cpuUsec,
    memoryBytes: memory * 1024 ** 2,
  },
});

test("shared worker Sandboxes use independent counters rather than repeating Pod totals", async () => {
  let time = now;
  const secondID = "33333333-3333-4333-8333-333333333333";
  const other = {
    input: { ...input, attemptID: secondID, sandboxID: `runtime-${secondID.replaceAll("-", "")}` },
    identity,
  };
  const calls: string[] = [];
  const read = createFactoryboxMetrics(
    async ({ input }) => {
      calls.push(input.sandboxID);
      const first = input.attemptID === attemptID;
      return observation(
        time,
        first ? (time === now ? 1000 : 501100) : time === now ? 3000 : 1503300,
        first ? 32 : 96,
      );
    },
    () => time,
  );
  expect(await read(target)).toMatchObject({ status: "available", cpuMilli: null, memoryMiB: 32 });
  expect(await read(other)).toMatchObject({ status: "available", cpuMilli: null, memoryMiB: 96 });
  expect((await read(target)).cpuMilli).toBeNull();
  expect(calls).toHaveLength(2);
  time += 5001;
  expect((await read(target)).cpuMilli).toBeCloseTo(100, 4);
  expect((await read(other)).cpuMilli).toBeCloseTo(300, 4);
  expect(calls).toEqual([
    input.sandboxID,
    other.input.sandboxID,
    input.sandboxID,
    other.input.sandboxID,
  ]);
});

test("changed owner, worker epoch or reset counters never inherit another CPU delta", async () => {
  let time = now,
    body = observation();
  const read = createFactoryboxMetrics(
    async () => body,
    () => time,
  );
  await read(target);
  time += 5001;
  body = observation(time, 2000000);
  body.body.owner = "f".repeat(32);
  expect((await read(target)).cpuMilli).toBeNull();
  time += 5001;
  body = observation(time, 1);
  body.body.owner = "f".repeat(32);
  expect((await read(target)).cpuMilli).toBeNull();
  expect(
    (await read({ ...target, identity: { ...identity, epoch: "a".repeat(32) } })).cpuMilli,
  ).toBeNull();
});

test("missing, forbidden, invalid and stale samples do not fabricate zero consumption", async () => {
  for (const [result, status] of [
    [{ status: 503, body: null }, "unavailable"],
    [{ status: 403, body: null }, "forbidden"],
    [{ status: 200, body: {} }, "unavailable"],
    [observation(now + 6000), "unavailable"],
  ] as const) {
    const read = createFactoryboxMetrics(
      async () => result,
      () => now,
    );
    expect(await read(target)).toEqual({
      status,
      timestamp: null,
      cpuMilli: null,
      memoryMiB: null,
    });
  }
  const read = createFactoryboxMetrics(
    async () => observation(now - 61000),
    () => now,
  );
  expect((await read(target)).status).toBe("stale");
  const forbidden = createFactoryboxMetrics(
    async () => {
      throw new Error("Kubernetes observation failed: Forbidden");
    },
    () => now,
  );
  expect((await forbidden(target)).status).toBe("forbidden");
});

test("sampling is coalesced by exact Sandbox and bounded to four concurrent observations", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const read = createFactoryboxMetrics(
    async () => {
      calls++;
      await gate.promise;
      return observation();
    },
    () => now,
  );
  const first = read(target),
    replay = read(target);
  const peers = Array.from({ length: 3 }, (_, index) => {
    const id = `00000000-0000-4000-8000-00000000000${index}`;
    return read({
      input: { ...input, attemptID: id, sandboxID: `runtime-${id.replaceAll("-", "")}` },
      identity,
    });
  });
  const extra = "00000000-0000-4000-8000-000000000009";
  expect(
    (
      await read({
        input: { ...input, attemptID: extra, sandboxID: `runtime-${extra.replaceAll("-", "")}` },
        identity,
      })
    ).status,
  ).toBe("unavailable");
  expect(calls).toBe(4);
  gate.resolve();
  await Promise.all([first, replay, ...peers]);
});
