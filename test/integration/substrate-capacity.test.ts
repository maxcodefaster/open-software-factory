import { expect, test } from "bun:test";
import {
  beginInstallationMaintenance,
  finishInstallationMaintenance,
} from "../../apps/factory/src/installation/maintenance";
import { createSubstrateCapacity } from "../../apps/factory/src/runtime/substrate-capacity";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import type { runNativeCapacityKubernetes } from "../../packages/runtime-kubernetes/src/substrate-capacity";
import { substrateFixture } from "../fixtures/substrate";
import { nativeCapacityFixture } from "../fixtures/substrate-capacity";

test.each(["amd64", "arm64"] as const)(
  "native %s admission uses its confirmed fully reserved original worker without resizing a smaller additional pool",
  async (architecture) => {
    const f = await substrateFixture();
    const fixture = nativeCapacityFixture(architecture);
    fixture.base.spec.template.resources = {
      requests: { cpu: "4", memory: "8Gi" },
      limits: { cpu: "4", memory: "8Gi" },
    };
    const original = structuredClone(fixture.base);
    const node = fixture.node("native-a");
    const pods = [
      {
        metadata: { uid: crypto.randomUUID() },
        spec: {
          nodeName: "native-a",
          containers: [
            { name: "original-worker", resources: fixture.base.spec.template.resources },
            { name: "control-plane", resources: { requests: { cpu: "2365m" } } },
          ],
        },
        status: { phase: "Running" },
      },
    ];
    const pools = new Map<string, Record<string, unknown>>();
    let creates = 0;
    const config: SubstrateInstallationConfiguration = {
      deployment: "fresh-workspaces",
      database: f.config.database,
      connection: f.config.connection,
      provisioner: f.config.connection,
      editorPrincipal: "user:system:serviceaccount:owned:control",
      connectorURL: f.config.connectorURL,
      factoryCAFile: "/unused/ca",
      workloadImage: fixture.image,
      profile: f.config.profile,
      runtime: {
        ...f.config.runtime,
        version: {
          ...f.config.runtime.version,
          attributes: f.config.runtime.version.attributes.map((attribute) =>
            attribute.key === "architecture" ? { ...attribute, value: architecture } : attribute,
          ),
        },
      },
      workerSelector: fixture.selector,
      egressHosts: [],
      resources: { cpuMilli: 3000, memoryMiB: 4096 },
    };
    const run: typeof runNativeCapacityKubernetes = async (args, input) => {
      let value: unknown;
      if (args[0] === "create") {
        const intended = JSON.parse(input ?? "null");
        creates++;
        const created = {
          ...intended,
          metadata: {
            ...intended.metadata,
            uid: crypto.randomUUID(),
            creationTimestamp: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
          },
          status: { readyReplicas: 1 },
        };
        pools.set(intended.metadata.name, created);
        value = created;
      } else if (args[1] === "workerpools") value = { items: [fixture.base, ...pools.values()] };
      else if (args[1] === "nodes") value = { items: [node] };
      else if (args[1] === "pods") value = { items: pods };
      else if (args[1] === "sandboxconfig") value = fixture.sandbox;
      else if (args[1] === "workerpool") value = pools.get(args[2] ?? "");
      else throw Error(`Unexpected native capacity command ${args.join(" ")}`);
      return { exitCode: 0, stdout: value === undefined ? "" : JSON.stringify(value), stderr: "" };
    };
    const capacity = createSubstrateCapacity(f.database, config, run);
    const resources = { cpuMilli: 3000, memoryMiB: 4096 };
    try {
      await capacity.requireReady(resources);
      expect(creates).toBe(1);
      const observed = await capacity.ensure();
      expect(observed.ready).toContainEqual({ cpuMilli: 4000, memoryMiB: 8192 });
      expect(observed.ready.some((worker) => worker.cpuMilli < resources.cpuMilli)).toBe(true);
      expect(fixture.base).toEqual(original);

      fixture.base.status.readyReplicas = 0;
      await expect(capacity.requireReady(resources)).rejects.toMatchObject({ code: "unavailable" });
      fixture.base.status.readyReplicas = 1;
      fixture.base.spec.template.resources.requests.cpu = "250m";
      await expect(capacity.requireReady(resources)).rejects.toMatchObject({ code: "unavailable" });
      fixture.base.spec.template.resources.requests.cpu = "4";
      fixture.base.spec.template.nodeSelector["kubernetes.io/hostname"] = "unconfirmed-node";
      await expect(capacity.requireReady(resources)).rejects.toMatchObject({ code: "unavailable" });
      fixture.base.spec.template.nodeSelector["kubernetes.io/hostname"] = "native-a";
      const bootID = node.status.nodeInfo.bootID;
      node.status.nodeInfo.bootID = crypto.randomUUID();
      await expect(capacity.requireReady(resources)).rejects.toMatchObject({ code: "unavailable" });
      node.status.nodeInfo.bootID = bootID;
      const ready = node.status.conditions.find((condition) => condition.type === "Ready");
      if (!ready) throw Error("No original Ready condition");
      ready.status = "False";
      await expect(capacity.requireReady(resources)).rejects.toMatchObject({ code: "unavailable" });
      ready.status = "True";
      fixture.base.spec.workerImage = `registry.factory/foreign@sha256:${"a".repeat(64)}`;
      await expect(capacity.requireReady(resources)).rejects.toThrow(
        "original installation identity",
      );
      fixture.base.spec.workerImage = original.spec.workerImage;
      const uid = fixture.base.metadata.uid;
      fixture.base.metadata.uid = crypto.randomUUID();
      await expect(capacity.requireReady(resources)).rejects.toThrow(
        "original installation identity",
      );
      fixture.base.metadata.uid = uid;
      await capacity.requireReady(resources);
      expect(creates).toBe(1);
      expect(fixture.base).toEqual(original);
      expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  },
  60000,
);

test.each(["amd64", "arm64"] as const)(
  "native %s capacity persists one create, recovers a lost reply and preserves original pools",
  async (architecture) => {
    const f = await substrateFixture();
    const fixture = nativeCapacityFixture(architecture);
    const original = structuredClone(fixture.base);
    const nodes = [
      fixture.node("native-a"),
      nativeCapacityFixture(architecture === "amd64" ? "arm64" : "amd64").node(
        "different-architecture",
      ),
    ];
    const pools = new Map<string, Record<string, unknown>>();
    const pods: Record<string, unknown>[] = [];
    const calls: string[][] = [];
    let creates = 0;
    let lose = true;
    let reject = false;
    const resources = { cpuMilli: 2000, memoryMiB: 4096 };
    const config: SubstrateInstallationConfiguration = {
      deployment: "fresh-workspaces",
      database: f.config.database,
      connection: f.config.connection,
      provisioner: f.config.connection,
      editorPrincipal: "user:system:serviceaccount:owned:control",
      connectorURL: f.config.connectorURL,
      factoryCAFile: "/unused/ca",
      workloadImage: fixture.image,
      profile: f.config.profile,
      runtime: {
        ...f.config.runtime,
        version: {
          ...f.config.runtime.version,
          attributes: f.config.runtime.version.attributes.map((attribute) =>
            attribute.key === "architecture" ? { ...attribute, value: architecture } : attribute,
          ),
        },
      },
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
        expect(saved?.["intent"].node.architecture).toBe(architecture);
        expect(intended.spec.template.nodeSelector["kubernetes.io/arch"]).toBe(architecture);
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
          containers: [
            { name: "editor", resources: { requests: { cpu: "50m", memory: "256Mi" } } },
          ],
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
      expect([
        ...(await f.database.client`SELECT to_regclass('factory.factorybox_worker') AS worker`),
      ]).toEqual([{ worker: null }]);
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
  },
  60000,
);
