import { expect, test } from "bun:test";
import { fixtureValue } from "../../../test/fixtures/value";
import { factoryboxLocation } from "./factorybox-location";
import {
  admitFactoryboxWorkerResources,
  selectFactoryboxWorkerResources,
} from "./factorybox-resource-admission";
import {
  configuredFactoryboxRuntimeProfile,
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
  renderFactoryboxRuntime,
} from "./factorybox-runtime";

const profile: FactoryboxRuntimeProfile = {
  image: `registry.invalid/worker@sha256:${"a".repeat(64)}`,
  executableSHA256: "b".repeat(64),
  architecture: "arm64",
  nodeName: "owned-node",
  kernel: "owned-kernel",
  cpuRequestMilli: 100,
  boundedBytes: 8 * 1024 ** 3,
  claimGiB: 32,
  resourceAdmission: { memoryHeadroomMiB: 2048 },
};
const node = () => ({
  metadata: { name: profile.nodeName, uid: "owned-node-uid" },
  status: {
    allocatable: { cpu: "8", memory: "20Gi" },
    nodeInfo: {
      architecture: profile.architecture,
      kernelVersion: profile.kernel,
      operatingSystem: "linux",
    },
    conditions: [
      { type: "Ready", status: "True" },
      { type: "MemoryPressure", status: "False" },
    ],
  },
});
const container = (name: string, memory: string) => ({
  name,
  resources: { requests: { memory } },
});
const pod = (memory: string) => ({
  spec: { nodeName: profile.nodeName, containers: [container("app", memory)] },
  status: { phase: "Running" },
});

test("configured headroom enables automatic selection but does not invent an already selected budget", () => {
  const environment = {
    FACTORY_FACTORYBOX_WORKER_IMAGE: profile.image,
    FACTORY_FACTORYBOX_EXECUTABLE_SHA256: profile.executableSHA256,
    FACTORY_FACTORYBOX_ARCHITECTURE: profile.architecture,
    FACTORY_FACTORYBOX_NODE: profile.nodeName,
    FACTORY_FACTORYBOX_KERNEL: profile.kernel,
  };
  expect(configuredFactoryboxRuntimeProfile(environment)).not.toHaveProperty("resourceAdmission");
  const fresh = configuredFactoryboxRuntimeProfile({
    ...environment,
    FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB: "2048",
  });
  expect(fresh.resourceAdmission).toEqual({ memoryHeadroomMiB: 2048 });
  expect(fresh).not.toHaveProperty("resources");
  expect(() =>
    configuredFactoryboxRuntimeProfile({
      ...environment,
      FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB: "-1",
    }),
  ).toThrow();
});

test("fresh shared worker selects node allocatable minus other reservations and explicit headroom", () => {
  const pods = {
    items: [
      pod("2Gi"),
      {
        ...pod("512Mi"),
        spec: {
          ...pod("512Mi").spec,
          initContainers: [
            { ...container("sidecar", "256Mi"), restartPolicy: "Always" },
            container("init", "1Gi"),
          ],
          overhead: { memory: "128Mi" },
        },
      },
      { ...pod("4Gi"), status: { phase: "Succeeded" } },
      { ...pod("4Gi"), status: { phase: "Failed" } },
    ],
  };
  expect(selectFactoryboxWorkerResources(profile, node(), pods)).toEqual({
    cpuMilli: 8000,
    memoryMiB: 14976,
  });
});

test("terminating Pods, native sidecars, allocated resize reservations and Pod requests stay charged", () => {
  expect(
    selectFactoryboxWorkerResources(profile, node(), {
      items: [
        {
          ...pod("512Mi"),
          metadata: { deletionTimestamp: "2026-10-31T00:00:00Z" },
          spec: {
            ...pod("512Mi").spec,
            initContainers: [
              container("before-sidecar", "2Gi"),
              { ...container("sidecar", "256Mi"), restartPolicy: "Always" },
              container("after-sidecar", "1Gi"),
            ],
          },
        },
        {
          ...pod("512Mi"),
          status: {
            phase: "Running",
            containerStatuses: [{ name: "app", allocatedResources: { memory: "2Gi" } }],
          },
        },
        {
          ...pod("512Mi"),
          spec: { ...pod("512Mi").spec, resources: { requests: { memory: "3Gi" } } },
        },
      ],
    }),
  ).toEqual({ cpuMilli: 8000, memoryMiB: 11264 });
});

test.each(["1Gi", "1024Mi", "1073741824", "1.073741824e9"])(
  "node admission accounts equivalent Kubernetes memory quantity %s",
  (memory) => {
    expect(
      selectFactoryboxWorkerResources(profile, node(), { items: [pod(memory)] }).memoryMiB,
    ).toBe(17408);
  },
);

test("node admission never substitutes unknown or unschedulable capacity", () => {
  for (const changed of [
    { ...node(), spec: { unschedulable: true } },
    { ...node(), metadata: { name: "other-node", uid: "other" } },
    { ...node(), status: { ...node().status, conditions: [] } },
    {
      ...node(),
      status: { ...node().status, conditions: [{ type: "MemoryPressure", status: "True" }] },
    },
    { ...node(), status: { ...node().status, allocatable: { cpu: "8", memory: "max" } } },
    { ...node(), status: { ...node().status, allocatable: { cpu: "0", memory: "20Gi" } } },
  ]) {
    expect(() => selectFactoryboxWorkerResources(profile, changed, { items: [] })).toThrow();
  }
  expect(() => selectFactoryboxWorkerResources(profile, node(), { items: [pod("19Gi")] })).toThrow(
    "No schedulable worker budget",
  );
  expect(() =>
    selectFactoryboxWorkerResources(profile, node(), {
      items: [{ ...pod("1Gi"), spec: { ...pod("1Gi").spec, nodeName: "other-node" } }],
    }),
  ).toThrow("another node");
});

test("large-node decimal requests never lose their fractional scheduler reservation", () => {
  const large = {
    ...node(),
    status: { ...node().status, allocatable: { cpu: "8", memory: "32Ti" } },
  };
  expect(
    selectFactoryboxWorkerResources(profile, large, {
      items: [pod("17592186044416.001")],
    }).memoryMiB,
  ).toBe(16 * 1024 ** 2 - 2048 - 1);
});

test("resource selection observes only the original node and never mutates Kubernetes", async () => {
  const calls: string[][] = [];
  const selected = await admitFactoryboxWorkerResources(profile, async (args) => {
    calls.push([...args]);
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify(args[1] === "node" ? node() : { items: [pod("2Gi")] }),
    };
  });
  expect(selected.resources).toEqual({ cpuMilli: 8000, memoryMiB: 16384 });
  expect(calls).toEqual([
    ["get", "node", profile.nodeName, "-o", "json"],
    [
      "get",
      "pods",
      "--all-namespaces",
      "--field-selector",
      "spec.nodeName=owned-node",
      "-o",
      "json",
    ],
  ]);
  expect(
    await admitFactoryboxWorkerResources(selected, async () => {
      throw new Error("A retained budget must not be reselected");
    }),
  ).toBe(selected);
  await expect(
    admitFactoryboxWorkerResources(profile, async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Unavailable",
    })),
  ).rejects.toThrow("current node and Pod observation");
});

test("automatic policy is resolved before rendering and never leaks into the native worker request", () => {
  const attemptID = "01234567-89ab-5def-8123-456789abcdef";
  const input = {
    ...factoryboxLocation(attemptID),
    attemptID,
    sandboxID: `runtime-${attemptID.replaceAll("-", "")}`,
    runtimeOwnerID: attemptID,
    runtimeHostImage: `registry.invalid/runtime@sha256:${"c".repeat(64)}`,
    labels: {},
    sharedSource: false,
    profile,
  };
  expect(() => renderFactoryboxRuntime(input)).toThrow("selected and retained");
  const admitted = {
    ...input,
    profile: { ...profile, resources: { cpuMilli: 8000, memoryMiB: 12288 } },
  };
  expect(factoryboxRuntimeRequest(admitted)).not.toHaveProperty("resourceAdmission");
  expect(
    fixtureValue(renderFactoryboxRuntime(admitted).pod.spec.containers[0], "worker").resources,
  ).toEqual({
    requests: { cpu: "100m", memory: "12Gi" },
    limits: { cpu: "8", memory: "12Gi" },
  });
});
