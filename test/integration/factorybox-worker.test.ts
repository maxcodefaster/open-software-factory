import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createFactoryboxWorker,
  factoryboxAllocation,
  rememberFactoryboxSource,
} from "../../apps/factory/src/runtime/worker";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import {
  factoryboxAssignmentSecret,
  type factoryboxLocation,
  factoryboxSharedLabels,
} from "../../packages/runtime-kubernetes/src/factorybox-location";
import {
  factoryboxSandboxID,
  renderFactoryboxRuntime,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { factoryProcess } from "../fixtures/factory-process";
import { ownedFactoryboxProfile as profile } from "../fixtures/runtime-configuration";

const manifest = z
  .object({
    kind: z.string(),
    metadata: z
      .object({
        name: z.string(),
        namespace: z.string().optional(),
        uid: z.string().optional(),
        labels: z.record(z.string(), z.string()),
      })
      .passthrough(),
  })
  .passthrough();
const runtimeImage = `registry.invalid/runtime@sha256:${"a".repeat(64)}`;
const key = (kind: string, name: string) => `${kind.toLowerCase()}/${name}`;

function infrastructure() {
  const objects = new Map<string, z.infer<typeof manifest>>();
  const writes: Array<{ action: string; kind: string; name: string }> = [];
  const fault = { losePodCreate: false };
  const kubernetes = createKubernetesClient(async (args, body) => {
    if (args[0] === "get") {
      const item = objects.get(key(args[1] ?? "", args[2] ?? ""));
      return item
        ? { stdout: JSON.stringify(item), stderr: "", exitCode: 0 }
        : {
            stdout: "",
            stderr: "Error from server (NotFound): owned fixture missing",
            exitCode: 1,
          };
    }
    if (args[0] === "create") {
      const item = manifest.parse(JSON.parse(body ?? ""));
      const identity = key(item.kind, item.metadata.name);
      if (objects.has(identity)) throw new Error("Duplicate external create");
      item.metadata.uid = crypto.randomUUID();
      if (item.kind === "Secret") {
        const files = z.record(z.string(), z.string()).parse(Reflect.get(item, "stringData"));
        Reflect.set(
          item,
          "data",
          Object.fromEntries(
            Object.entries(files).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          ),
        );
        Reflect.deleteProperty(item, "stringData");
      }
      if (item.kind === "Pod") Reflect.set(item, "status", { phase: "Running" });
      objects.set(identity, item);
      writes.push({ action: "create", kind: item.kind, name: item.metadata.name });
      if (item.kind === "Pod" && fault.losePodCreate) {
        fault.losePodCreate = false;
        throw new Error("Lost Pod create response");
      }
      return { stdout: JSON.stringify(item), stderr: "", exitCode: 0 };
    }
    if (args[0] === "apply") {
      const batch = z.object({ items: z.array(manifest) }).parse(JSON.parse(body ?? ""));
      for (const item of batch.items) {
        if (item.metadata.labels["factory.dev/shared-resource"] === "true")
          throw new Error("Shared Factory resources must never be reapplied");
        item.metadata.uid =
          objects.get(key(item.kind, item.metadata.name))?.metadata.uid ?? crypto.randomUUID();
        objects.set(key(item.kind, item.metadata.name), item);
        writes.push({ action: "apply", kind: item.kind, name: item.metadata.name });
      }
      return { stdout: "{}", stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected infrastructure mutation: ${args[0]}`);
  });
  return { kubernetes, objects, writes, fault };
}

function resources(location: ReturnType<typeof factoryboxLocation>, image = runtimeImage) {
  const attemptID = crypto.randomUUID();
  const shared = renderFactoryboxRuntime({
    ...location,
    attemptID,
    sandboxID: factoryboxSandboxID(attemptID),
    runtimeOwnerID: attemptID,
    labels: { "factory.dev/runtime-attempt": attemptID },
    runtimeHostImage: image,
    sharedSource: false,
    profile,
  });
  return [
    shared.namespace,
    shared.sourceClaim,
    shared.claim,
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "registry-ca",
        namespace: location.namespace,
        labels: factoryboxSharedLabels(location.workerID),
      },
      stringData: { "ca.crt": "owned-test-certificate" },
    },
    shared.pod,
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: factoryboxAssignmentSecret(attemptID),
        namespace: location.namespace,
        labels: {
          "app.kubernetes.io/managed-by": "open-software-factory",
          "factory.dev/runtime-owner": attemptID,
          "factory.dev/runtime-attempt": attemptID,
        },
      },
      stringData: { "assignment.json": JSON.stringify({ attemptID }) },
    },
  ];
}

test("a new consumer image admits a new Sandbox without replacing the worker or its bootstrap image", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const kube = infrastructure();
  const worker = createFactoryboxWorker(database, kube.kubernetes);
  try {
    const location = await worker.location();
    const original = await worker.provision(resources(location), profile, runtimeImage);
    const originalPod = structuredClone(kube.objects.get("pod/worker"));
    const originalWorker = await factoryboxAllocation(database.client);
    const nextImage = `registry.invalid/runtime@sha256:${"b".repeat(64)}`;
    const next = await worker.provision(resources(location, nextImage), profile, nextImage);
    expect(next).toMatchObject(original);
    expect(kube.objects.get("pod/worker")).toEqual(originalPod);
    expect(await factoryboxAllocation(database.client)).toEqual(originalWorker);
    expect(kube.writes.filter((write) => write.kind === "Pod")).toHaveLength(1);
    expect(kube.writes.filter((write) => write.kind === "PersistentVolumeClaim")).toHaveLength(2);
    expect(kube.writes.filter((write) => write.action === "apply")).toHaveLength(2);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

test("Factory allocation is lazy, concurrent, isolated per installation and starts no compute", async () => {
  const hosts = await Promise.all([factoryProcess(), factoryProcess()]);
  const databases = hosts.map((host) => host.connect());
  try {
    for (const database of databases)
      expect(await database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    const [first, second] = databases;
    if (!first || !second) throw new Error("Expected two independent fixture databases");
    const workers = await Promise.all(
      Array.from({ length: 8 }, () => factoryboxAllocation(first.client)),
    );
    expect(new Set(workers.map((worker) => worker.id)).size).toBe(1);
    expect(
      workers.every(
        (worker) => !worker.attempted && worker.podUID === null && worker.profile === null,
      ),
    ).toBe(true);
    const other = await factoryboxAllocation(second.client);
    const worker = workers[0];
    if (!worker) throw new Error("Expected concurrent Factory allocation");
    expect(other.id).not.toBe(worker.id);
    await rememberFactoryboxSource(first.client, worker.id, {
      namespaceUID: "source-namespace",
      claimUID: "source-claim",
      storageNode: profile.nodeName,
    });
    const sourceOnly = await factoryboxAllocation(first.client);
    expect(sourceOnly).toMatchObject({
      namespaceUID: "source-namespace",
      sourceClaimUID: "source-claim",
      nodeName: profile.nodeName,
      attempted: false,
      podUID: null,
      profile: null,
    });
    await expect(
      rememberFactoryboxSource(first.client, worker.id, {
        namespaceUID: "source-namespace",
        claimUID: "replacement",
        storageNode: profile.nodeName,
      }),
    ).rejects.toThrow("original Factory identity");
    await expect(factoryboxAllocation(first.client, "other-node")).rejects.toThrow("original node");
    await expect(
      (async () => {
        await first.client`DELETE FROM factory.factorybox_worker`;
      })(),
    ).rejects.toThrow("cannot be deleted");
  } finally {
    for (const database of databases) await database.client.end({ timeout: 2 });
    for (const host of hosts) await host.dispose();
  }
}, 30_000);

test("concurrent Sandboxes share one immutable worker and refuse missing storage or profile/UID drift before private writes", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const kube = infrastructure();
  const worker = createFactoryboxWorker(database, kube.kubernetes);
  try {
    const location = await worker.location();
    const outcomes = await Promise.all([
      worker.provision(resources(location), profile, runtimeImage),
      worker.provision(resources(location), profile, runtimeImage),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(
      kube.writes.filter((write) => write.action === "create" && write.kind === "Pod"),
    ).toHaveLength(1);
    expect(kube.writes.filter((write) => write.kind === "PersistentVolumeClaim")).toHaveLength(2);
    expect(kube.writes.filter((write) => write.action === "apply")).toHaveLength(2);
    const remembered = await factoryboxAllocation(database.client);
    expect(remembered).toMatchObject({
      attempted: true,
      podUID: outcomes[0].podUID,
      namespaceUID: outcomes[0].namespaceUID,
      sourceClaimUID: kube.objects.get("persistentvolumeclaim/runtime-data")?.metadata.uid,
    });
    const before = kube.writes.length;
    await expect(
      worker.provision(resources(location), { ...profile, nodeName: "other" }, runtimeImage),
    ).rejects.toThrow("original node");
    await expect(
      worker.provision(
        resources(location),
        { ...profile, executableSHA256: "1".repeat(64) },
        runtimeImage,
      ),
    ).rejects.toThrow("already pinned");
    await expect(
      worker.provision(
        resources(location),
        { ...profile, boundedBytes: 24 * 1024 ** 3, claimGiB: 48 },
        runtimeImage,
      ),
    ).rejects.toThrow("already pinned");
    const claim = kube.objects.get("persistentvolumeclaim/runtime-data");
    if (!claim) throw new Error("Missing owned Source claim");
    kube.objects.delete("persistentvolumeclaim/runtime-data");
    await expect(worker.provision(resources(location), profile, runtimeImage)).rejects.toThrow(
      "disappeared",
    );
    expect(kube.writes).toHaveLength(before);
    kube.objects.set("persistentvolumeclaim/runtime-data", claim);
    const pod = kube.objects.get("pod/worker");
    if (!pod) throw new Error("Missing owned Pod");
    pod.metadata.uid = crypto.randomUUID();
    await expect(worker.provision(resources(location), profile, runtimeImage)).rejects.toThrow(
      "UID changed",
    );
    expect(kube.writes).toHaveLength(before);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

test("lost worker create output observes only the original worker and cannot recreate it after disappearance", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const kube = infrastructure();
  const worker = createFactoryboxWorker(database, kube.kubernetes);
  try {
    const location = await worker.location();
    const requested = resources(location);
    kube.fault.losePodCreate = true;
    await expect(worker.provision(requested, profile, runtimeImage)).rejects.toThrow(
      "Lost Pod create response",
    );
    expect(kube.writes.filter((write) => write.action === "apply")).toHaveLength(0);
    const observed = await worker.provision(requested, profile, runtimeImage);
    const podUID = kube.objects.get("pod/worker")?.metadata.uid;
    const claimUID = kube.objects.get(
      `persistentvolumeclaim/store-${location.workerID.replaceAll("-", "")}`,
    )?.metadata.uid;
    if (!podUID || !claimUID) throw new Error("Lost create has no original owned outcomes");
    expect(observed.podUID).toBe(podUID);
    const remembered = await factoryboxAllocation(database.client);
    expect(remembered.claimUID).toBe(claimUID);
    expect(kube.writes.filter((write) => write.kind === "Pod")).toHaveLength(1);
    const before = kube.writes.length;
    kube.objects.delete("pod/worker");
    await expect(worker.provision(requested, profile, runtimeImage)).rejects.toThrow("disappeared");
    expect(kube.writes).toHaveLength(before);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);
