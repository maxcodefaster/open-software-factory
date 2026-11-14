import { expect, test } from "bun:test";
import {
  kubernetesPodRequestedResources,
  kubernetesResourceQuantity,
  selectWorkerNodeResources,
} from "./worker-resource-admission";

const policy = {
  nodeName: "owned-node",
  architecture: "amd64" as const,
  memoryHeadroomMiB: 2048,
  cpuRequestMilli: 100,
};
const node = () => ({
  metadata: { name: policy.nodeName, uid: "original-node" },
  status: {
    allocatable: { cpu: "8", memory: "20Gi" },
    nodeInfo: { architecture: "amd64", operatingSystem: "linux" },
    conditions: [
      { type: "Ready", status: "True" },
      { type: "MemoryPressure", status: "False" },
    ],
  },
});
const memory = (name: string, value: string) => ({
  name,
  resources: { requests: { memory: value } },
});
const pod = (value: string) => ({
  spec: { nodeName: policy.nodeName, containers: [memory("app", value)] },
  status: { phase: "Running" },
});

test("shared Pod reservation accounting reports scheduler quantities, not samples or liveness", () => {
  const input = {
    ...pod("1Gi"),
    spec: {
      ...pod("1Gi").spec,
      containers: [
        {
          name: "app",
          resources: { requests: { memory: "1Gi", cpu: "500m" } },
        },
      ],
      resources: { requests: { memory: "2Gi", cpu: "1" } },
      overhead: { memory: "128Mi", cpu: "50m" },
    },
  };
  expect(kubernetesPodRequestedResources(input)).toEqual({
    cpuMilli: 1050,
    memoryBytes: 2176 * 1024 ** 2,
  });
  expect(kubernetesPodRequestedResources({ ...input, status: { phase: "Failed" } })).toEqual({
    cpuMilli: 0,
    memoryBytes: 0,
  });
  expect(() => kubernetesPodRequestedResources({})).toThrow();
  expect(() => kubernetesPodRequestedResources(pod("unknown"))).toThrow();
  expect(kubernetesPodRequestedResources(pod("0.001"))).toEqual({
    cpuMilli: 0,
    memoryBytes: 1,
  });
});

test("native node budgets charge init peaks, sidecars, overhead and ignore only terminal Pods", () => {
  expect(
    selectWorkerNodeResources(policy, node(), {
      items: [
        pod("2Gi"),
        {
          ...pod("512Mi"),
          spec: {
            ...pod("512Mi").spec,
            initContainers: [
              { ...memory("sidecar", "256Mi"), restartPolicy: "Always" },
              memory("init", "1Gi"),
            ],
            overhead: { memory: "128Mi" },
          },
        },
        { ...pod("4Gi"), status: { phase: "Succeeded" } },
        { ...pod("4Gi"), status: { phase: "Failed" } },
      ],
    }),
  ).toEqual({ cpuMilli: 8000, memoryMiB: 14976 });
});
test.each(["1Gi", "1024Mi", "1073741824", "1.073741824e9"])(
  "native admission treats equivalent memory quantity %s exactly",
  (value) => {
    expect(selectWorkerNodeResources(policy, node(), { items: [pod(value)] }).memoryMiB).toBe(
      17408,
    );
  },
);
test("terminating Pods, resize and Pod-level reservations remain charged", () => {
  expect(
    selectWorkerNodeResources(policy, node(), {
      items: [
        {
          ...pod("512Mi"),
          metadata: { deletionTimestamp: "2026-11-13T00:00:00Z" },
          spec: {
            ...pod("512Mi").spec,
            initContainers: [
              memory("before", "2Gi"),
              { ...memory("sidecar", "256Mi"), restartPolicy: "Always" },
              memory("after", "1Gi"),
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
    }).memoryMiB,
  ).toBe(11264);
});
test("large decimal requests round upward rather than losing a scheduler reservation", () => {
  expect(
    selectWorkerNodeResources(
      policy,
      { ...node(), status: { ...node().status, allocatable: { cpu: "8", memory: "32Ti" } } },
      { items: [pod("17592186044416.001")] },
    ).memoryMiB,
  ).toBe(16 * 1024 ** 2 - 2048 - 1);
  expect(kubernetesResourceQuantity("0.000001", "cpu")).toBe(1);
  expect(kubernetesResourceQuantity("1.001", "memory")).toBe(2);
});
test("CPU admission includes init peaks, sidecars, allocated resize, overhead and terminating Pods", () => {
  const cpu = (name: string, value: string) => ({ name, resources: { requests: { cpu: value } } });
  expect(
    selectWorkerNodeResources(policy, node(), {
      items: [
        {
          metadata: { deletionTimestamp: "2026-11-13T00:00:00Z" },
          spec: {
            nodeName: policy.nodeName,
            containers: [cpu("app", "500m")],
            initContainers: [
              cpu("first", "2"),
              { ...cpu("sidecar", "250m"), restartPolicy: "Always" },
              cpu("last", "1"),
            ],
            overhead: { cpu: "100m" },
          },
          status: { phase: "Running" },
        },
        {
          spec: { nodeName: policy.nodeName, containers: [cpu("app", "500m")] },
          status: {
            phase: "Running",
            containerStatuses: [{ name: "app", allocatedResources: { cpu: "1" } }],
          },
        },
        {
          spec: {
            nodeName: policy.nodeName,
            containers: [cpu("app", "500m")],
            resources: { requests: { cpu: "1" } },
          },
          status: { phase: "Running", allocatedResources: { cpu: "1500m" } },
        },
        {
          spec: { nodeName: policy.nodeName, containers: [cpu("done", "8")] },
          status: { phase: "Succeeded" },
        },
      ],
    }).cpuMilli,
  ).toBe(3400);
});
test.each(["NoSchedule", "NoExecute", "PreferNoSchedule"])(
  "native admission never bypasses taint %s",
  (effect) => {
    expect(() =>
      selectWorkerNodeResources(
        policy,
        { ...node(), spec: { taints: [{ key: "reserved", effect }] } },
        { items: [] },
      ),
    ).toThrow(`reserved (${effect})`);
  },
);
test("unknown, replaced, deleting, unschedulable or exhausted nodes never become capacity", () => {
  for (const changed of [
    { ...node(), spec: { unschedulable: true } },
    { ...node(), metadata: { name: "other", uid: "other" } },
    { ...node(), metadata: { ...node().metadata, deletionTimestamp: "2026-11-13T00:00:00Z" } },
    { ...node(), status: { ...node().status, conditions: [] } },
    {
      ...node(),
      status: { ...node().status, conditions: [{ type: "MemoryPressure", status: "True" }] },
    },
    { ...node(), status: { ...node().status, allocatable: { cpu: "8", memory: "max" } } },
    { ...node(), status: { ...node().status, allocatable: { cpu: "0", memory: "20Gi" } } },
  ])
    expect(() => selectWorkerNodeResources(policy, changed, { items: [] })).toThrow();
  expect(() => selectWorkerNodeResources(policy, node(), { items: [pod("19Gi")] })).toThrow(
    "No schedulable worker budget",
  );
  expect(() =>
    selectWorkerNodeResources(policy, node(), {
      items: [{ ...pod("1Gi"), spec: { ...pod("1Gi").spec, nodeName: "other" } }],
    }),
  ).toThrow("another node");
});
