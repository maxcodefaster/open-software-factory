import { expect, test } from "bun:test";
import { factoryboxLocation } from "../../packages/runtime-kubernetes/src/factorybox-location";
import { renderFactoryboxRuntime } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import type { runFactoryboxKubernetes } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import {
  factoryboxFixtureCommand,
  factoryboxFixtureTarget,
  requireFixtureWorkerPod,
} from "../fixtures/factorybox-runtime";
import { ownedFactoryboxProfile } from "../fixtures/runtime-configuration";

function fixture() {
  const id = "9188282b-8879-4cec-a7eb-e344b0e19f5b";
  const workspaceID = "d0955952-65c2-48c6-819b-16dc714ef39d";
  const projectID = "ddfba743-fe28-4639-a01f-6098e3ddbaee";
  const location = factoryboxLocation("68f16b47-92d3-493d-8145-f92742951764");
  const epoch = "a".repeat(32);
  const identity = {
    version: 1 as const,
    namespaceUID: "namespace-uid",
    claimUID: "store-uid",
    podUID: "worker-uid",
    storeID: location.workerID.replaceAll("-", ""),
    epoch,
    bootID: "worker-boot",
    nodeBootID: "node-boot",
    executableSHA256: ownedFactoryboxProfile.executableSHA256,
    controllerRoot: `/var/lib/sysbox/fixed-store/data/store/epochs/${epoch}/controller`,
  };
  const row = {
    ...location,
    id,
    projectID,
    workspaceID,
    generation: "1",
    slotID: null,
    namespaceUID: identity.namespaceUID,
    podUID: identity.podUID,
    profile: ownedFactoryboxProfile,
    runtimeHostImage: `registry.invalid/runtime@sha256:${"b".repeat(64)}`,
    identity,
    released: false as const,
    request: {
      ...location,
      attemptID: id,
      sandboxID: `runtime-${id.replaceAll("-", "")}`,
      runtimeOwnerID: workspaceID,
      sharedSource: true,
      runtimeHostImage: `registry.invalid/runtime@sha256:${"b".repeat(64)}`,
      profile: ownedFactoryboxProfile,
      labels: {
        "app.kubernetes.io/managed-by": "open-software-factory",
        "factory.dev/runtime-attempt": id,
        "factory.dev/runtime-owner": workspaceID,
        "factory.dev/runtime-generation": "1",
        "factory.dev/project": projectID,
      },
    },
  };
  const target = factoryboxFixtureTarget(row);
  const resources = renderFactoryboxRuntime(target.input);
  const pod = {
    ...resources.pod,
    metadata: {
      ...resources.pod.metadata,
      uid: identity.podUID,
      creationTimestamp: "2026-10-27T09:00:00Z",
    },
    spec: { ...resources.pod.spec, nodeName: ownedFactoryboxProfile.nodeName },
    status: {
      phase: "Running",
      startTime: "2026-10-27T09:00:00Z",
      conditions: [{ type: "Ready", status: "True", lastTransitionTime: "2026-10-27T09:00:00Z" }],
      containerStatuses: [
        {
          name: "worker",
          restartCount: 0,
          ready: true,
          imageID: `containerd://${ownedFactoryboxProfile.image}`,
          state: { running: { startedAt: "2026-10-27T09:00:00Z" } },
        },
      ],
    },
  };
  const owner = "c".repeat(32);
  const view = {
    record: {
      version: 1,
      id: target.input.sandboxID,
      owner,
      runtime_id: `fbx-${owner}`,
      phase: "running",
    },
    runtime: { status: "running" },
  };
  const calls: Array<readonly string[]> = [];
  const run: typeof runFactoryboxKubernetes = async (args) => {
    calls.push(args);
    const value =
      args[0] === "get"
        ? {
            namespace: {
              ...resources.namespace,
              metadata: { ...resources.namespace.metadata, uid: identity.namespaceUID },
            },
            pvc: {
              ...resources.claim,
              spec: { ...resources.claim.spec, volumeMode: "Filesystem" },
              metadata: { ...resources.claim.metadata, uid: identity.claimUID },
              status: { phase: "Bound" },
            },
            pod,
            node: {
              metadata: { name: ownedFactoryboxProfile.nodeName },
              status: {
                nodeInfo: {
                  operatingSystem: "linux",
                  architecture: ownedFactoryboxProfile.architecture,
                  kernelVersion: ownedFactoryboxProfile.kernel,
                  bootID: identity.nodeBootID,
                },
              },
            },
          }[args[1] as "namespace" | "pvc" | "pod" | "node"]
        : args.at(-1) === "worker-status"
          ? {
              schema: 1,
              store_id: identity.storeID,
              store: "/var/lib/sysbox/fixed-store/data/store",
              epoch,
              boot_id: identity.bootID,
              supervisor_sha256: identity.executableSHA256,
              supervisor: { pid: 1 },
              ready_at: "2026-10-27T09:00:00Z",
              lifecycle: {
                root: identity.controllerRoot,
                manager_root: "/var/lib/sysbox/fixed-store/data/store/manager",
                bounded_store: {
                  target: "/var/lib/sysbox/fixed-store/data",
                  direct_io: true,
                  image: { owner: identity.storeID, bytes: ownedFactoryboxProfile.boundedBytes },
                },
              },
            }
          : args.includes("state")
            ? view
            : null;
    return { exitCode: 0, stdout: value ? JSON.stringify(value) : "owned-output", stderr: "" };
  };
  return { row, target, resources, pod, view, run, calls };
}

test("fixture targets bind the exact Sandbox and never use a shared Pod's Attempt label", () => {
  const f = fixture();
  expect(f.target.input.sandboxID).toBe(`runtime-${f.row.id.replaceAll("-", "")}`);
  expect(requireFixtureWorkerPod(f.pod, f.target).metadata.uid).toBe(f.target.identity.podUID);
  for (const patch of [
    { id: crypto.randomUUID() },
    { workspaceID: crypto.randomUUID() },
    { projectID: crypto.randomUUID() },
    { workerID: crypto.randomUUID() },
    { namespace: "another-namespace" },
    { namespaceUID: "replacement-namespace" },
    { podUID: "replacement-pod" },
    { generation: "2" },
    { released: true },
    { runtimeHostImage: `registry.invalid/other@sha256:${"b".repeat(64)}` },
    { profile: { ...f.row.profile, architecture: "arm64" } },
    { request: { ...f.row.request, sandboxID: "foreign-sandbox" } },
    { identity: { ...f.row.identity, storeID: "d".repeat(32) } },
  ])
    expect(() => factoryboxFixtureTarget({ ...f.row, ...patch })).toThrow();
});

test("fixture native exec observes the original epoch, uses its native owner and rechecks before exec", async () => {
  const f = fixture();
  expect(await factoryboxFixtureCommand(f.target, ["docker", "ps"], 30_000, f.run)).toBe(
    "owned-output",
  );
  const command = f.calls.at(-1);
  if (!command?.[10]) throw new Error("Missing native fixture exec");
  expect(command.slice(0, 9)).toEqual([
    "exec",
    "-n",
    f.row.namespace,
    "worker",
    "-c",
    "worker",
    "--",
    "python3",
    "-c",
  ]);
  expect(command[9]).toContain("Fixture worker changed before native Sandbox exec");
  expect(JSON.parse(command[10])).toEqual({
    storeID: f.row.identity.storeID,
    epoch: f.row.identity.epoch,
    controllerRoot: f.row.identity.controllerRoot,
    executableSHA256: f.row.identity.executableSHA256,
    runtimeID: f.view.record.runtime_id,
  });
  expect(command.slice(11)).toEqual(["docker", "ps"]);
  expect(command.join(" ")).not.toContain("workspace_cvm");
});

test("fixture native exec refuses paused slots, foreign runtime owners and replaced worker UIDs", async () => {
  for (const change of ["paused", "owner", "pod"] as const) {
    const f = fixture();
    if (change === "paused") f.view.record.phase = "paused";
    if (change === "owner") f.view.record.runtime_id = `fbx-${"e".repeat(32)}`;
    if (change === "pod") f.pod.metadata.uid = "replacement";
    await expect(
      factoryboxFixtureCommand(f.target, ["docker", "ps"], 30_000, f.run),
    ).rejects.toThrow(
      change === "paused"
        ? "running Sandbox"
        : change === "owner"
          ? "exec owner differs"
          : "Kubernetes UID changed",
    );
    expect(f.calls.some((args) => args.includes("python3"))).toBe(false);
  }
});

test("fixture activation sends bounded private input on stdin, never in process arguments", async () => {
  const f = fixture();
  const payload = JSON.stringify({ token: "fresh-private-fixture-capability" });
  let delivered: string | undefined;
  const run: typeof runFactoryboxKubernetes = async (args, body, limits) => {
    if (args.includes("python3")) delivered = body;
    return f.run(args, body, limits);
  };
  await factoryboxFixtureCommand(f.target, ["sh", "-ec", "cat >/private"], 30_000, run, payload);
  expect(delivered).toBe(payload);
  const command = f.calls.at(-1);
  expect(command?.slice(0, 3)).toEqual(["exec", "-i", "-n"]);
  expect(command?.join(" ")).not.toContain("fresh-private-fixture-capability");
  expect(command?.join(" ")).toContain("os.execv");
});

test("fixture rejects oversized private input before touching the worker", async () => {
  const f = fixture();
  await expect(
    factoryboxFixtureCommand(f.target, ["cat"], 30_000, f.run, "x".repeat(1024 ** 2 + 1)),
  ).rejects.toThrow("private input exceeds");
  expect(f.calls).toEqual([]);
});
