import { expect, test } from "bun:test";
import {
  beginInstallationMaintenance,
  finishInstallationMaintenance,
} from "../../apps/factory/src/installation/maintenance";
import { createSubstrateCapacity } from "../../apps/factory/src/runtime/substrate-capacity";
import type { SubstrateWorkspaceConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import type { runNativeCapacityKubernetes } from "../../packages/runtime-kubernetes/src/substrate-capacity";
import { substrateFixture } from "../fixtures/substrate";
import { nativeCapacityFixture } from "../fixtures/substrate-capacity";

test("native capacity admits joined nodes through one persisted create, recovers a lost reply and preserves original pools", async () => {
  const f = await substrateFixture();
  const fixture = nativeCapacityFixture();
  const original = structuredClone(fixture.base);
  const nodes = [fixture.node("native-a")];
  const pools = new Map<string, Record<string, unknown>>();
  const pods: Record<string, unknown>[] = [];
  const calls: string[][] = [];
  let creates = 0;
  let lose = true;
  let reject = false;
  const resources = { cpuMilli: 2000, memoryMiB: 4096 };
  const config: SubstrateWorkspaceConfiguration = {
    deployment: "fresh-workspaces",
    database: f.config.database,
    projectID: f.projectID,
    connection: f.config.connection,
    provisioner: f.config.connection,
    editorPrincipal: "user:system:serviceaccount:owned:control",
    connectorURL: f.config.connectorURL,
    factoryCAFile: "/unused/ca",
    workloadImage: fixture.image,
    profile: f.config.profile,
    runtime: f.config.runtime,
    workerSelector: fixture.selector,
    egressHosts: [],
    resources,
  };
  const run: typeof runNativeCapacityKubernetes = async (args, input) => {
    calls.push([...args]);
    let value: unknown;
    if (args[0] === "create") {
      const intended = JSON.parse(input ?? "null");
      const node = nodes.find(
        (n) =>
          n.metadata.labels["kubernetes.io/hostname"] ===
          intended.spec.template.nodeSelector["kubernetes.io/hostname"],
      );
      if (!node) throw new Error("Native capacity create selected an unknown fixture node");
      const [saved] = await f.database
        .client`SELECT attempted_at,intent FROM factory.substrate_worker_capacity WHERE node_uid=${node.metadata.uid}`;
      expect(saved?.["attempted_at"]).not.toBeNull();
      expect(saved?.["intent"].pool).toEqual(intended);
      creates++;
      if (reject) return { exitCode: 1, stdout: "", stderr: "AlreadyExists: foreign resource" };
      const created = {
        ...intended,
        metadata: {
          ...intended.metadata,
          uid: crypto.randomUUID(),
          creationTimestamp: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
        },
        status: { readyReplicas: 0 },
      };
      pools.set(intended.metadata.name, created);
      if (lose) {
        lose = false;
        throw Error("owned lost pool reply");
      }
      value = created;
    } else if (args[1] === "workerpools") value = { items: [fixture.base, ...pools.values()] };
    else if (args[1] === "nodes") value = { items: nodes };
    else if (args[1] === "pods") value = { items: pods };
    else if (args[1] === "sandboxconfig") value = fixture.sandbox;
    else if (args[1] === "workerpool") value = pools.get(args[2] ?? "");
    else throw Error(`Unexpected native capacity command ${args.join(" ")}`);
    return { exitCode: 0, stdout: value === undefined ? "" : JSON.stringify(value), stderr: "" };
  };
  const capacity = createSubstrateCapacity(f.database, config, run);
  try {
    await beginInstallationMaintenance(f.database);
    expect((await capacity.ensure()).ready).toHaveLength(0);
    expect(calls).toHaveLength(0);
    await finishInstallationMaintenance(f.database);
    await expect(capacity.ensure()).rejects.toThrow("owned lost pool reply");
    expect(creates).toBe(1);
    const first = pools.entries().next().value;
    if (!first) throw Error("No original pool create");
    pools.delete(first[0]);
    await expect(capacity.ensure()).rejects.toThrow("missing");
    expect(creates).toBe(1);
    pools.set(first[0], first[1]);
    expect((await capacity.ensure()).ready).toHaveLength(0);
    expect(creates).toBe(1);
    await expect(capacity.requireReady(resources)).rejects.toMatchObject({
      code: "unavailable",
    });
    for (const pool of pools.values()) pool["status"] = { readyReplicas: 1 };
    expect((await capacity.ensure()).ready).toHaveLength(1);
    await capacity.requireReady(resources);
    const retainedSpec = structuredClone(first[1]["spec"]);
    pods.push({
      metadata: { uid: crypto.randomUUID() },
      spec: {
        nodeName: "native-a",
        containers: [{ name: "editor", resources: { requests: { cpu: "50m", memory: "256Mi" } } }],
      },
      status: { phase: "Running" },
    });
    expect((await capacity.ensure()).ready).toHaveLength(1);
    expect(creates).toBe(1);
    expect(first[1]["spec"]).toEqual(retainedSpec);
    nodes.push(fixture.node("native-b"));
    await capacity.ensure();
    expect(creates).toBe(2);
    for (const pool of pools.values()) pool["status"] = { readyReplicas: 1 };
    expect((await capacity.ensure()).ready).toHaveLength(2);
    nodes.shift();
    expect((await capacity.ensure()).ready).toHaveLength(1);
    expect(creates).toBe(2);
    expect(fixture.base).toEqual(original);
    expect(calls.every((args) => args[0] === "get" || args[0] === "create")).toBe(true);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    await expect(
      Promise.resolve(
        f.database.client`UPDATE factory.substrate_worker_capacity SET attempted_at=NULL`,
      ),
    ).rejects.toThrow("immutable");
    const pool = pools.values().next().value;
    if (!pool) throw Error("No owned pool");
    const metadata = pool["metadata"] as { uid: string; name: string };
    const originalUID = metadata.uid;
    metadata.uid = crypto.randomUUID();
    await expect(capacity.ensure()).rejects.toThrow("creation intent");
    expect(creates).toBe(2);
    metadata.uid = originalUID;
    pools.delete(metadata.name);
    await expect(capacity.ensure()).rejects.toThrow("missing");
    expect(creates).toBe(2);
    pools.set(metadata.name, pool);
    nodes.push(fixture.node("native-c"));
    reject = true;
    await expect(capacity.ensure()).rejects.toThrow("unconfirmed");
    expect(creates).toBe(3);
    await expect(capacity.ensure()).rejects.toThrow("rejected");
    expect(creates).toBe(3);
  } finally {
    await f.dispose();
  }
}, 60000);
