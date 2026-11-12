import { expect, test } from "bun:test";
import type { FactoryboxWorkerIdentity } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { combinedBenchmarkPreflight } from "./benchmark-preflight";
import { factoryboxExecutable } from "./benchmark-profile";

const identity: FactoryboxWorkerIdentity = {
  version: 1,
  namespaceUID: "namespace",
  podUID: "pod",
  claimUID: "claim",
  storeID: "a".repeat(32),
  epoch: "b".repeat(32),
  bootID: "original-boot",
  nodeBootID: "original-node-boot",
  executableSHA256: "c".repeat(64),
  controllerRoot: "/owned/controller",
};
const worker = {
  store_id: identity.storeID,
  epoch: identity.epoch,
  boot_id: identity.bootID,
  supervisor_sha256: identity.executableSHA256,
  lifecycle: { root: identity.controllerRoot },
};
const capacity = { root: identity.controllerRoot, new_write_admitted: false };
const result = {
  exitCode: 0,
  stdout: JSON.stringify({ schema: 1, worker, capacity }),
  stderr: "",
};
const args = (action: string) => [
  "kubectl",
  "exec",
  "owned-pod",
  "--",
  factoryboxExecutable,
  ...(action === "capacity"
    ? [
        "--worker-run-root",
        "/run/factorybox",
        "--worker-store-id",
        identity.storeID,
        "--worker-epoch",
        identity.epoch,
      ]
    : []),
  action,
];

test("combined read-only preflight saves one invocation and preserves known refusal", async () => {
  const calls: string[][] = [];
  const run = combinedBenchmarkPreflight(
    true,
    () => "cycle-1:pause",
    () => identity,
    async (command) => {
      calls.push([...command]);
      return result;
    },
  );
  expect(JSON.parse((await run(args("worker-status"))).stdout)).toEqual(worker);
  expect(JSON.parse((await run(args("capacity"))).stdout)).toEqual(capacity);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--include-worker-status");
  expect(calls[0]).not.toContain("pause");
});

test("no preflight cache survives another command or lifecycle phase", async () => {
  let phase = "cycle-1:pause";
  let calls = 0;
  const run = combinedBenchmarkPreflight(
    true,
    () => phase,
    () => identity,
    async () => {
      calls++;
      return result;
    },
  );
  await run(args("worker-status"));
  await run(args("state"));
  await run(args("capacity"));
  expect(calls).toBe(3);
  await run(args("worker-status"));
  phase = "cycle-2:pause";
  await run(args("capacity"));
  expect(calls).toBe(5);
});

test("disabled and resume paths do not change any invocation", async () => {
  for (const [enabled, phase] of [
    [false, "cycle-1:pause"],
    [true, "cycle-1:resume"],
  ] as const) {
    const calls: string[][] = [];
    const run = combinedBenchmarkPreflight(
      enabled,
      () => phase,
      () => {
        throw new Error("identity should not be requested");
      },
      async (command) => {
        calls.push([...command]);
        return result;
      },
    );
    await run(args("worker-status"));
    await run(args("capacity"));
    expect(calls).toEqual([args("worker-status"), args("capacity")]);
  }
});

test("foreign identities and controllers cannot populate the capacity cache", async () => {
  for (const changed of [
    { worker: { ...worker, epoch: "foreign" }, capacity },
    { worker: { ...worker, supervisor_sha256: "foreign" }, capacity },
    { worker, capacity: { ...capacity, root: "/foreign" } },
  ]) {
    const run = combinedBenchmarkPreflight(
      true,
      () => "cycle-1:pause",
      () => identity,
      async () => ({
        ...result,
        stdout: JSON.stringify({ schema: 1, ...changed }),
      }),
    );
    await expect(run(args("worker-status"))).rejects.toThrow("another worker or controller");
  }
});

test("another worker's capacity query cannot consume a cached observation", async () => {
  let calls = 0;
  const run = combinedBenchmarkPreflight(
    true,
    () => "cycle-1:pause",
    () => identity,
    async () => {
      calls++;
      return result;
    },
  );
  await run(args("worker-status"));
  await run(args("capacity").map((value) => (value === "owned-pod" ? "foreign-pod" : value)));
  expect(calls).toBe(2);
});
