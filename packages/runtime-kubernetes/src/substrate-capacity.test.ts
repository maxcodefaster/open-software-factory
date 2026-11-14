import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCapacityFixture } from "../../../test/fixtures/substrate-capacity";
import {
  nativeCapacityCandidates,
  nativeCapacityNodeReady,
  nativeCapacityOriginalNode,
  nativeCapacityReservedPoolResources,
  renderNativeCapacityPool,
  requireNativeCapacityBase,
  requireNativeCapacityPool,
  requireNativeCapacitySandbox,
  runNativeCapacityKubernetes,
} from "./substrate-capacity";

test.each(["amd64", "arm64"] as const)(
  "the commissioned %s pool needs its own Ready node and a fully reserved budget",
  (architecture) => {
    const f = nativeCapacityFixture(architecture);
    f.base.spec.template.resources = {
      requests: { cpu: "6", memory: "12Gi" },
      limits: { cpu: "6", memory: "12Gi" },
    };
    const pool = requireNativeCapacityBase({ items: [f.base] }, f.selector, architecture);
    const node = f.node("native-a");
    const nodes = { items: [node] };
    const original = nativeCapacityOriginalNode(nodes, pool, architecture);
    expect(original).toMatchObject({
      uid: node.metadata.uid,
      bootID: node.status.nodeInfo.bootID,
      architecture,
      resources: { cpuMilli: 6000, memoryMiB: 12288 },
    });
    const pendingNode = f.node("joining-node");
    const pending = {
      ...pendingNode,
      status: {
        ...pendingNode.status,
        nodeInfo: { ...pendingNode.status.nodeInfo, bootID: "" },
      },
    };
    expect(nativeCapacityOriginalNode({ items: [node, pending] }, pool, architecture)).toEqual(
      original,
    );
    expect(nativeCapacityOriginalNode({ items: [] }, pool, architecture)).toBeNull();
    delete pool.spec.template.nodeSelector["kubernetes.io/hostname"];
    expect(nativeCapacityOriginalNode(nodes, pool, architecture)).toBeNull();
    pool.spec.template.nodeSelector["kubernetes.io/hostname"] = "native-a";
    pool.spec.template.resources.requests["cpu"] = "250m";
    expect(nativeCapacityOriginalNode(nodes, pool, architecture)).toBeNull();
    node.spec = { unschedulable: true };
    pool.spec.template.resources.requests["cpu"] = "6";
    expect(nativeCapacityOriginalNode(nodes, pool, architecture)).toBeNull();
    node.spec = {};
    node.status.nodeInfo.architecture = architecture === "arm64" ? "amd64" : "arm64";
    expect(nativeCapacityOriginalNode(nodes, pool, architecture)).toBeNull();
  },
);

test("original native capacity counts only equal finite CPU and memory reservations", () => {
  const f = nativeCapacityFixture();
  const pool = requireNativeCapacityBase({ items: [f.base] }, f.selector, "amd64");
  pool.spec.template.resources = {
    requests: { cpu: "4", memory: "8Gi" },
    limits: { cpu: "4000m", memory: "8192Mi" },
  };
  expect(nativeCapacityReservedPoolResources(pool)).toEqual({ cpuMilli: 4000, memoryMiB: 8192 });
  pool.spec.template.resources.requests["cpu"] = "250m";
  expect(nativeCapacityReservedPoolResources(pool)).toBeNull();
  pool.spec.template.resources.requests["cpu"] = "4";
  pool.spec.template.resources.requests["memory"] = "4Gi";
  expect(nativeCapacityReservedPoolResources(pool)).toBeNull();
  pool.spec.template.resources.requests["memory"] = "8Gi";
  delete pool.spec.template.resources.limits["cpu"];
  expect(nativeCapacityReservedPoolResources(pool)).toBeNull();
  pool.spec.template.resources.limits["cpu"] = "4";
  pool.spec.template.resources.requests["memory"] = "invalid";
  expect(() => nativeCapacityReservedPoolResources(pool)).toThrow("Invalid Kubernetes memory");
});

test("ARM admission selects only the installation architecture and preserves it through readiness and pool creation", () => {
  const f = nativeCapacityFixture("arm64");
  const arm = f.node("arm-worker");
  const x86 = nativeCapacityFixture().node("x86-worker");
  const nodes = { items: [arm, x86] };
  const result = nativeCapacityCandidates(nodes, { items: [] }, "arm64");
  expect(result.candidates).toHaveLength(1);
  const candidate = result.candidates[0];
  if (!candidate) throw Error("No ARM candidate");
  expect(candidate.architecture).toBe("arm64");
  const pool = renderNativeCapacityPool(
    requireNativeCapacityBase({ items: [f.base] }, f.selector, "arm64"),
    candidate,
    f.selector,
    crypto.randomUUID(),
  );
  expect(pool.spec.template.nodeSelector["kubernetes.io/arch"]).toBe("arm64");
  expect(nativeCapacityNodeReady(nodes, candidate)).toBe(true);
  const changed = structuredClone(arm);
  changed.status.nodeInfo.architecture = "amd64";
  expect(nativeCapacityNodeReady({ items: [changed] }, candidate)).toBe(false);
  expect(result.refused.map((node) => node.nodeName)).toEqual(["x86-worker"]);
  expect(() => requireNativeCapacityBase({ items: [f.base] }, f.selector, "amd64")).toThrow(
    "installation architecture",
  );
  expect(() =>
    renderNativeCapacityPool(
      requireNativeCapacityBase({ items: [nativeCapacityFixture().base] }, f.selector, "amd64"),
      candidate,
      f.selector,
      crypto.randomUUID(),
    ),
  ).toThrow("another runtime architecture");
});

test("native Kubernetes creation passes its manifest on stdin without application credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-capacity-client-"));
  const previous = {
    PATH: process.env["PATH"],
    context: process.env["FACTORY_KUBERNETES_CONTEXT"],
    secret: process.env["FACTORY_CAPACITY_PRIVATE_TEST"],
  };
  try {
    await writeFile(
      join(directory, "kubectl"),
      `#!/bin/sh\nprintf '%s\\n' "\${FACTORY_CAPACITY_PRIVATE_TEST-unset}" "$*"\ncat\n`,
      { mode: 0o700 },
    );
    process.env["PATH"] = `${directory}:${previous.PATH ?? "/usr/bin:/bin"}`;
    process.env["FACTORY_KUBERNETES_CONTEXT"] = "owned-native-capacity";
    process.env["FACTORY_CAPACITY_PRIVATE_TEST"] = "must-not-be-projected";
    const manifest = JSON.stringify({
      kind: "WorkerPool",
      metadata: { name: "owned-stdin-proof" },
    });
    const result = await runNativeCapacityKubernetes(["create", "-f", "-"], manifest);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `unset\n--context owned-native-capacity --request-timeout=10s create -f -\n${manifest}`,
    );
  } finally {
    for (const [key, value] of Object.entries({
      PATH: previous.PATH,
      FACTORY_KUBERNETES_CONTEXT: previous.context,
      FACTORY_CAPACITY_PRIVATE_TEST: previous.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("native joined-node admission shares scheduler accounting without opt-in labels or changing the original pool", () => {
  const f = nativeCapacityFixture();
  const original = structuredClone(f.base);
  const node = f.node("native-a");
  const pods = {
    items: [
      {
        metadata: { uid: crypto.randomUUID() },
        spec: {
          nodeName: "native-a",
          containers: [
            { name: "unrelated", resources: { requests: { cpu: "500m", memory: "2Gi" } } },
          ],
        },
        status: { phase: "Running" },
      },
    ],
  };
  const admitted = nativeCapacityCandidates({ items: [node] }, pods, "amd64");
  expect(admitted.refused).toHaveLength(0);
  expect(admitted.candidates[0]?.resources).toEqual({ cpuMilli: 7250, memoryMiB: 12288 });
  const candidate = admitted.candidates[0];
  if (!candidate) throw Error("No native node candidate");
  const pool = renderNativeCapacityPool(
    requireNativeCapacityBase({ items: [f.base] }, f.selector, "amd64"),
    candidate,
    f.selector,
    crypto.randomUUID(),
  );
  expect(pool.spec.template.resources).toEqual({
    requests: { cpu: "7250m", memory: "12Gi" },
    limits: { cpu: "7250m", memory: "12Gi" },
  });
  expect(pool.spec.workerImage).toBe(f.image);
  expect(pool.metadata.name).not.toBe(f.base.metadata.name);
  expect(f.base).toEqual(original);
  expect(nativeCapacityNodeReady({ items: [node] }, candidate)).toBe(true);
  expect(nativeCapacityNodeReady({ items: [] }, candidate)).toBe(false);
  const reboot = structuredClone(node);
  reboot.status.nodeInfo.bootID = crypto.randomUUID();
  expect(nativeCapacityNodeReady({ items: [reboot] }, candidate)).toBe(false);
  expect(requireNativeCapacitySandbox(f.sandbox)).toBe(f.sandbox.metadata.uid);
  const changed = structuredClone(f.sandbox);
  const version = changed.spec.versions[0];
  if (!version) throw new Error("Pinned SandboxConfig version is missing");
  version.assets.amd64.gvisor.sha256 = "a".repeat(64);
  expect(() => requireNativeCapacitySandbox(changed)).toThrow("pinned profile");
});

test("fresh native pools retain CPU for an independent editor and refuse budgets below the worker minimum", () => {
  const f = nativeCapacityFixture();
  const node = f.node("native-a");
  const fresh = nativeCapacityCandidates({ items: [node] }, { items: [] }, "amd64").candidates[0];
  expect(fresh?.resources.cpuMilli).toBe(7750);
  expect(8000 - (fresh?.resources.cpuMilli ?? 8000)).toBeGreaterThanOrEqual(50);
  const constrained = structuredClone(node);
  constrained.status.allocatable.cpu = "400m";
  const refused = nativeCapacityCandidates({ items: [constrained] }, { items: [] }, "amd64");
  expect(refused.candidates).toHaveLength(0);
  expect(refused.refused[0]?.reason).toContain("access-service headroom");
  constrained.status.allocatable.cpu = "500m";
  expect(
    nativeCapacityCandidates({ items: [constrained] }, { items: [] }, "amd64").candidates[0]
      ?.resources.cpuMilli,
  ).toBe(250);
});

test.each(["taint", "pressure", "unschedulable", "architecture", "operating-system", "deleting"])(
  "native capacity refuses unsuitable %s nodes",
  (scenario) => {
    const f = nativeCapacityFixture();
    const node = structuredClone(f.node("native-a")) as ReturnType<typeof f.node> & {
      spec: { taints?: { key: string; effect: string }[]; unschedulable?: boolean };
      metadata: { deletionTimestamp?: string };
    };
    if (scenario === "taint") node.spec.taints = [{ key: "reserved", effect: "PreferNoSchedule" }];
    if (scenario === "pressure")
      node.status.conditions.push({ type: "MemoryPressure", status: "True" });
    if (scenario === "unschedulable") node.spec.unschedulable = true;
    if (scenario === "architecture") node.status.nodeInfo.architecture = "arm64";
    if (scenario === "operating-system") node.status.nodeInfo.operatingSystem = "windows";
    if (scenario === "deleting") node.metadata.deletionTimestamp = new Date().toISOString();
    expect(
      nativeCapacityCandidates({ items: [node] }, { items: [] }, "amd64").candidates,
    ).toHaveLength(0);
  },
);

test("native pool observations require exact create time, UID, labels, pin and resource budget", () => {
  const f = nativeCapacityFixture();
  const node = nativeCapacityCandidates({ items: [f.node("native-a")] }, { items: [] }, "amd64")
    .candidates[0];
  if (!node) throw Error("No candidate");
  const intended = renderNativeCapacityPool(
    requireNativeCapacityBase({ items: [f.base] }, f.selector, "amd64"),
    node,
    f.selector,
    crypto.randomUUID(),
  );
  const at = new Date().toISOString();
  const uid = crypto.randomUUID();
  const actual = {
    ...intended,
    metadata: {
      ...intended.metadata,
      uid,
      creationTimestamp: new Date(Math.floor(Date.parse(at) / 1000) * 1000).toISOString(),
    },
  };
  expect(requireNativeCapacityPool(actual, intended, at, uid).metadata.uid).toBe(uid);
  for (const kind of ["uid", "time", "budget", "image", "label", "creation-intent"]) {
    const changed = structuredClone(actual);
    if (kind === "uid") changed.metadata.uid = crypto.randomUUID();
    if (kind === "time") changed.metadata.creationTimestamp = "2020-01-01T00:00:00.000Z";
    if (kind === "budget") changed.spec.template.resources.limits.memory = "1Gi";
    if (kind === "image")
      changed.spec.workerImage = `registry.test/foreign@sha256:${"a".repeat(64)}`;
    if (kind === "label") changed.metadata.labels["factory.dev/native-capacity"] = "foreign";
    if (kind === "creation-intent")
      changed.metadata.annotations["factory.dev/creation-intent"] = crypto.randomUUID();
    expect(() => requireNativeCapacityPool(changed, intended, at, uid)).toThrow("creation intent");
  }
});
