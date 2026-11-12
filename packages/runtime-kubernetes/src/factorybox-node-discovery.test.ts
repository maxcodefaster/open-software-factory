import { expect, test } from "bun:test";
import { ownedFactoryboxProfile } from "../../../test/fixtures/runtime-configuration";
import {
  discoverFactoryboxNodes,
  requireOriginalFactoryboxNode,
} from "./factorybox-node-discovery";

function node(name = "joined-node") {
  return {
    metadata: { name, uid: `uid-${name}`, labels: {} },
    spec: {},
    status: {
      allocatable: { cpu: "8", memory: "8Gi" },
      nodeInfo: {
        architecture: "amd64",
        operatingSystem: "linux",
        bootID: "owned-boot",
        kernelVersion: "6.12.0",
        kubeletVersion: "owned",
      },
      conditions: [
        { type: "Ready", status: "True" },
        ...["MemoryPressure", "DiskPressure", "PIDPressure"].map((type) => ({
          type,
          status: "False",
        })),
      ],
    },
  };
}

test("discovers suitable joined nodes using actual architecture and reservations without an opt-in label", () => {
  const selected = discoverFactoryboxNodes(
    ownedFactoryboxProfile,
    { items: [node("node-b"), node("node-a")] },
    { items: [] },
  );
  expect(selected.refused).toEqual([]);
  expect(selected.candidates.map((c) => c.nodeName)).toEqual(["node-a", "node-b"]);
  expect(selected.candidates[0]?.identity).toEqual({
    uid: "uid-node-a",
    bootID: "owned-boot",
    architecture: "amd64",
    operatingSystem: "linux",
  });
  expect(selected.candidates[0]?.profile.resources).toEqual({ cpuMilli: 8000, memoryMiB: 6144 });
});

test.each([
  "unready",
  "pressured",
  "tainted",
  "maintenance",
  "architecture",
  "kernel",
  "exhausted",
] as const)("refuses %s nodes instead of bypassing admission", (condition) => {
  const input = node();
  let pods: unknown[] = [];
  if (condition === "unready") input.status.conditions = [{ type: "Ready", status: "False" }];
  if (condition === "pressured")
    input.status.conditions.push({ type: "MemoryPressure", status: "True" });
  if (condition === "tainted")
    Object.assign(input.spec, { taints: [{ key: "maintenance", effect: "PreferNoSchedule" }] });
  if (condition === "maintenance") Object.assign(input.spec, { unschedulable: true });
  if (condition === "architecture") input.status.nodeInfo.architecture = "arm64";
  if (condition === "kernel") input.status.nodeInfo.kernelVersion = "unsupported";
  if (condition === "exhausted")
    pods = [
      {
        spec: {
          nodeName: "joined-node",
          containers: [{ name: "busy", resources: { requests: { cpu: "8", memory: "8Gi" } } }],
        },
        status: { phase: "Running" },
      },
    ];
  const selected = discoverFactoryboxNodes(
    ownedFactoryboxProfile,
    { items: [input] },
    { items: pods },
  );
  expect(selected.candidates).toEqual([]);
  expect(selected.refused).toHaveLength(1);
  expect(selected.refused[0]?.reason.length).toBeGreaterThan(0);
});

test("excludes only exact owned worker Pod reservations, never another installation's worker", () => {
  const pods = {
    items: ["own", "foreign"].map((uid) => ({
      metadata: { uid },
      spec: {
        nodeName: "joined-node",
        containers: [{ name: "worker", resources: { requests: { memory: "3Gi" } } }],
      },
    })),
  };
  expect(
    discoverFactoryboxNodes(ownedFactoryboxProfile, { items: [node()] }, pods, ["own"])
      .candidates[0]?.profile.resources?.memoryMiB,
  ).toBe(3072);
});

test.each(["uid", "boot", "unready", "pressure", "taint", "gone"] as const)(
  "retained destination %s changes fail closed",
  async (condition) => {
    const input = node();
    const identity = {
      uid: input.metadata.uid,
      bootID: "owned-boot",
      architecture: "amd64",
      operatingSystem: "linux",
    };
    if (condition === "uid") input.metadata.uid = "replacement";
    if (condition === "boot") input.status.nodeInfo.bootID = "replacement";
    if (condition === "unready") input.status.conditions = [{ type: "Ready", status: "False" }];
    if (condition === "pressure")
      input.status.conditions.push({ type: "MemoryPressure", status: "True" });
    if (condition === "taint") Object.assign(input.spec, { taints: [{ key: "maintenance" }] });
    let reads = 0;
    await expect(
      requireOriginalFactoryboxNode("joined-node", identity, async (args) => {
        reads++;
        expect(args).toEqual(["get", "node", "joined-node", "-o", "json"]);
        return {
          stdout: JSON.stringify(input),
          stderr: "owned",
          exitCode: condition === "gone" ? 1 : 0,
        };
      }),
    ).rejects.toThrow();
    expect(reads).toBe(1);
  },
);
