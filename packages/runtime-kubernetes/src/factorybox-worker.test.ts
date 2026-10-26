import { expect, test } from "bun:test";
import type { runCommand } from "./command";
import {
  executeFactoryboxOperation,
  type FactoryboxWorkerRequest,
  factoryboxOperation,
  factoryboxWorkerRequest,
  inspectFactoryboxWorker,
  renderFactoryboxWorker,
} from "./factorybox-worker";

const request: FactoryboxWorkerRequest = {
  version: 1,
  namespace: "factorybox-owned-test",
  podName: "worker",
  storeID: "a".repeat(32),
  trustDomainID: "b".repeat(32),
  image: `registry.invalid/factorybox@sha256:${"c".repeat(64)}`,
  executableSHA256: "d".repeat(64),
  architecture: "amd64",
  nodeName: "owned-linux-node",
  kernel: "7.2.8-9-omarchy",
  boundedBytes: 4 * 1024 ** 3,
  claimGiB: 32,
};
const epoch = "e".repeat(32);
const root = `/var/lib/sysbox/fixed-store/data/store/epochs/${epoch}/controller`;
function fixture(input: FactoryboxWorkerRequest = request) {
  const resources = renderFactoryboxWorker(input);
  const namespace = {
    ...resources[0],
    metadata: { ...resources[0].metadata, uid: "namespace-uid" },
  };
  const claim = {
    ...resources[1],
    metadata: { ...resources[1].metadata, uid: "claim-uid" },
    status: { phase: "Bound" },
  };
  const pod = {
    ...resources[2],
    metadata: { ...resources[2].metadata, uid: "pod-uid" },
    spec: { ...resources[2].spec, nodeName: input.nodeName },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "worker", restartCount: 0, ready: true }],
    },
  };
  const node = {
    metadata: { name: input.nodeName },
    status: {
      nodeInfo: {
        operatingSystem: "linux",
        architecture: input.architecture,
        kernelVersion: input.kernel,
        bootID: "boot-id",
      },
    },
  };
  const status = {
    schema: 1,
    store_id: input.storeID,
    store: "/var/lib/sysbox/fixed-store/data/store",
    epoch,
    boot_id: "boot-id",
    supervisor_sha256: input.executableSHA256,
    supervisor: { pid: 1 },
    ready_at: "2026-10-25T10:00:00Z",
    lifecycle: {
      root,
      manager_root: "/var/lib/sysbox/fixed-store/data/store/manager",
      bounded_store: {
        target: "/var/lib/sysbox/fixed-store/data",
        direct_io: true,
        image: { owner: input.storeID, bytes: input.boundedBytes },
      },
    },
  };
  const calls: Array<readonly string[]> = [];
  let operation = { exitCode: 0, stdout: JSON.stringify({ root }), stderr: "" };
  const run: typeof runCommand = async (args) => {
    calls.push(args);
    const value =
      args[0] === "get"
        ? ({ namespace, pvc: claim, pod, node } as Record<string, unknown>)[args[1] ?? ""]
        : args.at(-1) === "worker-status"
          ? status
          : null;
    return value ? { exitCode: 0, stdout: JSON.stringify(value), stderr: "" } : operation;
  };
  return {
    namespace,
    claim,
    pod,
    node,
    status,
    calls,
    run,
    result(value: typeof operation) {
      operation = value;
    },
  };
}

test("worker admission preserves the complete private store and finite worker ceilings", () => {
  const resources = renderFactoryboxWorker(request);
  const pod = resources[2];
  expect(pod.spec.containers[0].resources).toEqual({
    requests: { cpu: "3", memory: "3Gi" },
    limits: { cpu: "3", memory: "3Gi" },
  });
  expect(pod.spec.restartPolicy).toBe("Never");
  expect(pod.spec.containers[0].startupProbe.httpGet).toEqual({ path: "/readyz", port: "health" });
  expect(pod.spec.volumes[0]).toEqual({
    name: "store",
    persistentVolumeClaim: { claimName: `store-${request.storeID}` },
  });
  expect(JSON.stringify(resources)).not.toMatch(
    /docker.sock|runtime-data|home\/coder|ServiceAccountToken":true|execProbe|livenessProbe/,
  );
  expect(() => factoryboxWorkerRequest.parse({ ...request, claimGiB: 20 })).toThrow();
  expect(() => factoryboxWorkerRequest.parse({ ...request, image: "factorybox:latest" })).toThrow();
  expect(() =>
    factoryboxWorkerRequest.parse({ ...request, canonicalSource: "/project" }),
  ).toThrow();
  expect(() =>
    factoryboxOperation.parse({
      action: "start",
      sandboxID: "owned",
      bundle: "/home/coder/project",
    }),
  ).toThrow();
});

test("no exec is admitted until exact Kubernetes resources and HTTP readiness agree", async () => {
  const f = fixture();
  f.pod.status.conditions = [{ type: "Ready", status: "False" }];
  await expect(inspectFactoryboxWorker(request, undefined, f.run)).rejects.toThrow("not ready");
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
});

test("checkpoint retirement pins the original worker, Sandbox, owner and complete checkpoint hash", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const checkpoint = {
    source_id: "owned",
    snapshot_id: "a".repeat(32),
    source_owner: "b".repeat(32),
    checkpoint_sha256: "c".repeat(64),
  };
  const operation = {
    action: "retire-checkpoint" as const,
    sandboxID: checkpoint.source_id,
    snapshotID: checkpoint.snapshot_id,
    sourceOwner: checkpoint.source_owner,
    checkpointSHA256: checkpoint.checkpoint_sha256,
  };
  const receipt = {
    version: 1,
    request: checkpoint,
    intent_sha256: "d".repeat(64),
    completed_at: "2026-10-26T12:00:00Z",
    before: { root, filesystem_available_bytes: 1024 },
    after: { root, filesystem_available_bytes: 2048 },
  };
  f.result({ exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) });
  const result = await executeFactoryboxOperation(request, identity, operation, f.run);
  expect(result.confirmed).toBe(true);
  expect(f.calls.at(-1)?.slice(-10)).toEqual([
    "--worker-epoch",
    epoch,
    "retire-checkpoint",
    "--snapshot-id",
    checkpoint.snapshot_id,
    "--source-owner",
    checkpoint.source_owner,
    "--checkpoint-sha256",
    checkpoint.checkpoint_sha256,
    checkpoint.source_id,
  ]);
  for (const invalid of [
    { ...receipt, request: { ...checkpoint, source_owner: "e".repeat(32) } },
    { ...receipt, request: { ...checkpoint, snapshot_id: "e".repeat(32) } },
    { ...receipt, request: { ...checkpoint, checkpoint_sha256: "e".repeat(64) } },
    { ...receipt, completed_at: "" },
    { ...receipt, after: { ...receipt.after, root: "/another-controller" } },
    { ...receipt, before: { ...receipt.before, filesystem_available_bytes: -1 } },
  ]) {
    f.result({ exitCode: 0, stderr: "", stdout: JSON.stringify(invalid) });
    await expect(executeFactoryboxOperation(request, identity, operation, f.run)).rejects.toThrow();
  }
  const previousCalls = f.calls.length;
  f.result({
    exitCode: 1,
    stderr: "retirement output was lost",
    stdout: JSON.stringify(receipt),
  });
  expect((await executeFactoryboxOperation(request, identity, operation, f.run)).confirmed).toBe(
    false,
  );
  expect(
    f.calls.slice(previousCalls).filter((args) => args.includes("retire-checkpoint")),
  ).toHaveLength(1);
});

test.each(["arm64", "amd64"] as const)(
  "%s admission pins the requested architecture and refuses a different node before exec",
  async (architecture) => {
    const input = { ...request, architecture };
    const f = fixture(input);
    expect(f.pod.spec.nodeSelector["kubernetes.io/arch"]).toBe(architecture);
    await inspectFactoryboxWorker(input, undefined, f.run);
    f.calls.length = 0;
    f.node.status.nodeInfo.architecture = architecture === "arm64" ? "amd64" : "arm64";
    await expect(inspectFactoryboxWorker(input, undefined, f.run)).rejects.toThrow();
    expect(f.calls.every((args) => args[0] === "get")).toBe(true);
  },
);

test("worker architecture is explicit and rejects unsupported or inferred targets", () => {
  expect(() => factoryboxWorkerRequest.parse({ ...request, architecture: undefined })).toThrow();
  expect(() => factoryboxWorkerRequest.parse({ ...request, architecture: "riscv64" })).toThrow();
});

test("real status must bind the supervisor, bounded filesystem, boot and epoch", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.status.store_id = "f".repeat(32);
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.supervisor_sha256 = "f".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.lifecycle.root = "/other/controller";
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.lifecycle.bounded_store.direct_io = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.boot_id = "old-boot";
    },
    (f: ReturnType<typeof fixture>) => {
      f.node.status.nodeInfo.kernelVersion = "unqualified";
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.spec.containers[0], "image", "changed");
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.spec.containers[0].resources.limits, "memory", "8Gi");
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.spec, "initContainers", [{ name: "foreign" }]);
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.metadata, "deletionTimestamp", "now");
    },
    (f: ReturnType<typeof fixture>) => {
      f.namespace.metadata.labels["factory.dev/trust-domain"] = "other";
    },
  ]) {
    const f = fixture();
    change(f);
    await expect(inspectFactoryboxWorker(request, undefined, f.run)).rejects.toThrow();
  }
});

test("UID or epoch replacement refuses a delayed operation without issuing it", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  f.calls.length = 0;
  f.pod.metadata.uid = "replacement";
  await expect(
    executeFactoryboxOperation(request, identity, { action: "capacity" }, f.run),
  ).rejects.toThrow("UID changed");
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
  f.pod.metadata.uid = identity.podUID;
  f.status.epoch = "f".repeat(32);
  f.status.lifecycle.root = root.replace(epoch, f.status.epoch);
  await expect(
    executeFactoryboxOperation(request, identity, { action: "capacity" }, f.run),
  ).rejects.toThrow("live identity changed");
  expect(
    f.calls.filter((args) => args[0] === "exec").every((args) => args.at(-1) === "worker-status"),
  ).toBe(true);
});

test("every mutation pins its store/epoch inside the executed CLI and never retries a partial failure", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const snapshotID = "1".repeat(32);
  f.result({
    exitCode: 1,
    stdout: JSON.stringify({ record: { id: "owned", phase: "pausing" } }),
    stderr: "unconfirmed",
  });
  const result = await executeFactoryboxOperation(
    request,
    identity,
    { action: "pause", sandboxID: "owned", snapshotID },
    f.run,
  );
  expect(result.confirmed).toBe(false);
  const mutation = f.calls.filter((args) => args.includes("--worker-epoch"));
  expect(mutation).toHaveLength(1);
  expect(mutation[0]).toEqual([
    "exec",
    "worker",
    "-n",
    request.namespace,
    "-c",
    "worker",
    "--",
    "/opt/factorybox/factorybox",
    "--worker-run-root",
    "/run/factorybox",
    "--worker-store-id",
    request.storeID,
    "--worker-epoch",
    epoch,
    "pause",
    "--snapshot-id",
    snapshotID,
    "owned",
  ]);
});

test("zero exit alone cannot confirm an unrelated pause or incomplete resume", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const snapshotID = "1".repeat(32);
  f.result({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      record: {
        version: 1,
        id: "owned",
        phase: "paused",
        pause: { snapshot_id: "2".repeat(32), completed_at: "now" },
      },
    }),
  });
  await expect(
    executeFactoryboxOperation(
      request,
      identity,
      { action: "pause", sandboxID: "owned", snapshotID },
      f.run,
    ),
  ).rejects.toThrow("exact pause/resume");
  f.result({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      record: {
        version: 1,
        id: "owned",
        phase: "running",
        pause: { snapshot_id: snapshotID, completed_at: "now", resume: {} },
      },
    }),
  });
  await expect(
    executeFactoryboxOperation(
      request,
      identity,
      { action: "resume", sandboxID: "owned", snapshotID },
      f.run,
    ),
  ).rejects.toThrow("exact pause/resume");
});
