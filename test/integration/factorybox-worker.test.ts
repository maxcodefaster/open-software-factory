import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createFactoryboxWorker,
  factoryboxAllocation,
  rememberFactoryboxIdentity,
  rememberFactoryboxSource,
  retainedFactoryboxProfile,
} from "../../apps/factory/src/runtime/worker";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import {
  factoryboxAssignmentSecret,
  type factoryboxLocation,
  factoryboxSharedLabels,
} from "../../packages/runtime-kubernetes/src/factorybox-location";
import {
  type FactoryboxRuntimeProfile,
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
  const fault = { losePodCreate: false, unavailableRead: false };
  const kubernetes = createKubernetesClient(async (args, body) => {
    if (args[0] === "get") {
      if (fault.unavailableRead)
        return { stdout: "", stderr: "Owned fixture API unavailable", exitCode: 1 };
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

function resources(
  location: ReturnType<typeof factoryboxLocation>,
  image = runtimeImage,
  selected: FactoryboxRuntimeProfile = profile,
) {
  const attemptID = crypto.randomUUID();
  const shared = renderFactoryboxRuntime({
    ...location,
    attemptID,
    sandboxID: factoryboxSandboxID(attemptID),
    runtimeOwnerID: attemptID,
    labels: { "factory.dev/runtime-attempt": attemptID },
    runtimeHostImage: image,
    sharedSource: false,
    profile: selected,
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

async function failedBootstrap() {
  const host = await factoryProcess();
  const database = host.connect();
  const kube = infrastructure();
  const worker = createFactoryboxWorker(database, kube.kubernetes);
  const actorID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${actorID},'Owned bootstrap recovery',${`${actorID}@recovery.test`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,
      devcontainer_path,created_by,desktop_background_key)
      VALUES(${projectID},${`recovery-${projectID}`},'Owned recovery',
        'https://example.invalid/recovery.git','main','.devcontainer/devcontainer.json',
        ${actorID},'river-landscape')`;
    const location = await worker.location();
    await worker.provision(resources(location), profile, runtimeImage);
    const original = await factoryboxAllocation(database.client);
    const pod = kube.objects.get("pod/worker");
    if (!pod) throw new Error("Missing failed bootstrap fixture");
    Reflect.set(pod, "status", { phase: "Failed" });
    return {
      database,
      kube,
      worker,
      actorID,
      projectID,
      location,
      original,
      pod,
      async attempt(state: "create-intended" | "failed") {
        const id = crypto.randomUUID();
        await database.client`INSERT INTO factory.runtime_attempt(
          id,project_id,isolated_kind,generation,revision,state,
          parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          VALUES(${id},${projectID},'staging',1,${"a".repeat(40)},${state},
            ${"b".repeat(64)},${"c".repeat(64)},now(),${actorID})`;
        return id;
      },
      async dispose() {
        await database.client.end({ timeout: 2 });
        await host.dispose();
      },
    };
  } catch (cause) {
    await database.client.end({ timeout: 2 });
    await host.dispose();
    throw cause;
  }
}

test.each([
  "active execution",
  "unavailable observation",
  "changed Pod UID",
  "changed Namespace UID",
  "disabled actor",
  "native identity",
  "missing original Pod",
] as const)(
  "bootstrap recovery refuses %s without creating or changing an admission",
  async (scenario) => {
    const f = await failedBootstrap();
    try {
      if (scenario === "active execution") await f.attempt("create-intended");
      if (scenario === "unavailable observation") f.kube.fault.unavailableRead = true;
      if (scenario === "changed Pod UID") f.pod.metadata.uid = crypto.randomUUID();
      if (scenario === "changed Namespace UID") {
        const namespace = f.kube.objects.get(key("Namespace", f.location.namespace));
        if (!namespace) throw new Error("Missing original Namespace");
        namespace.metadata.uid = crypto.randomUUID();
      }
      if (scenario === "disabled actor")
        await f.database
          .client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${f.actorID}`;
      if (scenario === "native identity") {
        if (!f.original.namespaceUID || !f.original.podUID || !f.original.claimUID)
          throw new Error("Missing original worker identities");
        await rememberFactoryboxIdentity(f.database.client, f.original.id, {
          version: 1,
          namespaceUID: f.original.namespaceUID,
          podUID: f.original.podUID,
          claimUID: f.original.claimUID,
          storeID: f.original.admissionID.replaceAll("-", ""),
          epoch: "e".repeat(32),
          bootID: "original-boot",
          nodeBootID: "original-node-boot",
          executableSHA256: profile.executableSHA256,
          controllerRoot: "/factorybox",
        });
      }
      if (scenario === "missing original Pod") f.kube.objects.delete("pod/worker");
      const before = [
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
      ];
      const writes = f.kube.writes.length;
      const recover = () =>
        f.worker.location(f.database.client, {
          actorID: f.actorID,
          requestID: crypto.randomUUID(),
        });
      if (scenario === "native identity") {
        expect(await recover()).toEqual(f.location);
        await expect(
          f.worker.provision(resources(f.location), profile, runtimeImage),
        ).rejects.toThrow("Original Factorybox worker terminated");
      } else await expect(recover()).rejects.toThrow();
      expect([
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
      ]).toEqual(before);
      expect(f.kube.writes).toHaveLength(writes);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test("concurrent commissions recover once and retain old execution and admission history", async () => {
  const f = await failedBootstrap();
  try {
    const oldAttempt = await f.attempt("failed");
    const locations = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.worker.location(f.database.client, {
          actorID: f.actorID,
          requestID: crypto.randomUUID(),
        }),
      ),
    );
    expect(locations.every((location) => location.podName === locations[0]?.podName)).toBe(true);
    expect(locations[0]?.podName).not.toBe(f.location.podName);
    const [active] = await f.database.client<{ id: string }[]>`
      SELECT id FROM factory.factorybox_worker_admission WHERE retired_at IS NULL`;
    if (!active) throw new Error("Missing successor admission");
    const [old] = await f.database.client`
      SELECT factorybox_admission_id,kubernetes_pod_name FROM factory.runtime_attempt WHERE id=${oldAttempt}`;
    expect(old).toMatchObject({
      factorybox_admission_id: f.original.admissionID,
      kubernetes_pod_name: "worker",
    });
    const nextAttempt = crypto.randomUUID();
    await f.database.client`INSERT INTO factory.runtime_attempt(
      id,project_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${nextAttempt},${f.projectID},'staging',2,${"a".repeat(40)},'create-intended',
        ${"d".repeat(64)},${"f".repeat(64)},now(),${f.actorID})`;
    const [next] = await f.database.client`
      SELECT factorybox_admission_id,kubernetes_pod_name FROM factory.runtime_attempt WHERE id=${nextAttempt}`;
    expect(next).toMatchObject({
      factorybox_admission_id: active.id,
      kubernetes_pod_name: locations[0]?.podName,
    });
    await expect(
      (async () => {
        await f.database
          .client`UPDATE factory.runtime_attempt SET factorybox_admission_id=${active.id}
        WHERE id=${oldAttempt}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      (async () => {
        await f.database
          .client`UPDATE factory.factorybox_worker_admission SET retired_at=NULL,retirement_observation=NULL
        WHERE id=${f.original.admissionID}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      (async () => {
        await f.database
          .client`DELETE FROM factory.factorybox_worker_admission WHERE id=${f.original.admissionID}`;
      })(),
    ).rejects.toThrow("cannot be deleted");
    expect(
      await f.database.client`SELECT id FROM factory.factorybox_worker_admission`,
    ).toHaveLength(2);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("bootstrap recovery commissions the new pinned adaptive profile without changing the original allocation", async () => {
  const f = await failedBootstrap();
  try {
    const [originalRoot] = await f.database.client`SELECT * FROM factory.factorybox_worker`;
    if (!originalRoot) throw new Error("Missing original allocation");
    const adaptive = {
      ...profile,
      image: `registry.invalid/next-worker@sha256:${"6".repeat(64)}`,
      executableSHA256: "7".repeat(64),
      boundedBytes: 32 * 1024 ** 3,
      minimumBoundedBytes: 8 * 1024 ** 3,
      claimGiB: 64,
    };
    const worker = createFactoryboxWorker(f.database, f.kube.kubernetes, () => adaptive);
    const recovered = await worker.location(f.database.client, {
      actorID: f.actorID,
      requestID: crypto.randomUUID(),
    });
    const selected = await retainedFactoryboxProfile(f.database.client);
    expect(selected).toEqual({ ...adaptive, storageAdmission: 1 });
    await worker.provision(resources(recovered, runtimeImage, selected), selected, runtimeImage);
    const allocation = await factoryboxAllocation(f.database.client);
    if (!allocation.podUID || !allocation.claimUID || !allocation.namespaceUID)
      throw new Error("Missing adaptive worker identities");
    const identity = {
      version: 1 as const,
      namespaceUID: allocation.namespaceUID,
      podUID: allocation.podUID,
      claimUID: allocation.claimUID,
      storeID: allocation.admissionID.replaceAll("-", ""),
      epoch: "e".repeat(32),
      bootID: "original-boot",
      nodeBootID: "original-node-boot",
      executableSHA256: adaptive.executableSHA256,
      controllerRoot: "/factorybox",
      boundedBytes: 17 * 1024 ** 3,
    };
    await expect(
      rememberFactoryboxIdentity(f.database.client, allocation.id, {
        ...identity,
        boundedBytes: 7 * 1024 ** 3,
      }),
    ).rejects.toThrow("differs");
    await rememberFactoryboxIdentity(f.database.client, allocation.id, identity);
    expect((await factoryboxAllocation(f.database.client)).identity).toEqual(identity);
    expect([...(await f.database.client`SELECT * FROM factory.factorybox_worker`)]).toEqual([
      originalRoot,
    ]);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("an explicit fresh execution recovers failed bootstrap with new admission identities and the same canonical Source", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const kube = infrastructure();
  const worker = createFactoryboxWorker(database, kube.kubernetes);
  const actorID = crypto.randomUUID();
  const requestID = crypto.randomUUID();
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${actorID},'Owned bootstrap recovery',${`${actorID}@recovery.test`})`;
    const originalLocation = await worker.location();
    await worker.provision(resources(originalLocation), profile, runtimeImage);
    const [originalRoot] = await database.client`SELECT * FROM factory.factorybox_worker`;
    if (!originalRoot) throw new Error("Missing retained original worker");
    const original = await factoryboxAllocation(database.client);
    const originalPod = kube.objects.get("pod/worker");
    if (!originalPod) throw new Error("Missing failed bootstrap fixture");
    Reflect.set(originalPod, "status", { phase: "Failed" });
    const recovered = await worker.location(database.client, { actorID, requestID });
    expect(recovered.namespace).toBe(originalLocation.namespace);
    expect(recovered.workerID).toBe(originalLocation.workerID);
    expect(recovered.podName).not.toBe(originalLocation.podName);
    const selected = await retainedFactoryboxProfile(database.client);
    expect(selected).toMatchObject({ ...profile, storageAdmission: 1 });
    const next = await worker.provision(
      resources(recovered, runtimeImage, selected),
      selected,
      runtimeImage,
    );
    expect(next.podUID).not.toBe(original.podUID);
    expect(kube.objects.get("pod/worker")).toBe(originalPod);
    expect([...kube.objects.values()].filter((item) => item.kind === "Pod")).toHaveLength(2);
    const allocation = await factoryboxAllocation(database.client);
    expect(allocation.sourceClaimUID).toBe(original.sourceClaimUID);
    expect(allocation.claimUID).not.toBe(original.claimUID);
    expect([...(await database.client`SELECT * FROM factory.factorybox_worker`)]).toEqual([
      originalRoot,
    ]);
    expect(await worker.location(database.client, { actorID, requestID })).toEqual(recovered);
    expect(await database.client`SELECT id FROM factory.factorybox_worker_admission`).toHaveLength(
      2,
    );
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

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

test.each(["Failed", "Succeeded"])(
  "a %s original worker refuses new execution before private writes and retains all worker identities",
  async (phase) => {
    const host = await factoryProcess();
    const database = host.connect();
    const kube = infrastructure();
    const worker = createFactoryboxWorker(database, kube.kubernetes);
    try {
      const location = await worker.location();
      await worker.provision(resources(location), profile, runtimeImage);
      const retained = await factoryboxAllocation(database.client);
      const pod = kube.objects.get("pod/worker");
      if (!pod) throw new Error("Missing original owned worker");
      Reflect.set(pod, "status", { phase });
      const before = kube.writes.length;

      await expect(worker.provision(resources(location), profile, runtimeImage)).rejects.toThrow(
        "Original Factorybox worker terminated",
      );
      expect(kube.writes).toHaveLength(before);
      expect(await factoryboxAllocation(database.client)).toEqual(retained);
      expect(kube.objects.get("pod/worker")).toBe(pod);
      expect(kube.writes.filter((write) => write.kind === "Pod")).toHaveLength(1);
      expect(kube.writes.filter((write) => write.kind === "PersistentVolumeClaim")).toHaveLength(2);
    } finally {
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  30_000,
);

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
    await expect(
      worker.provision(resources(location), { ...profile, cpuRequestMilli: 200 }, runtimeImage),
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
    const actorID = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${actorID},'Owned uncertain create',${`${actorID}@recovery.test`})`;
    expect(
      await worker.location(database.client, { actorID, requestID: crypto.randomUUID() }),
    ).toEqual(location);
    expect(await database.client`SELECT id FROM factory.factorybox_worker_admission`).toHaveLength(
      1,
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
