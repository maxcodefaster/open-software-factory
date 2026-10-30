import { expect, test } from "bun:test";
import type { runCommand } from "./command";
import {
  ensureFactoryboxConsumer,
  factoryboxConsumerIntent,
  renderFactoryboxConsumer,
} from "./factorybox-consumer";
import { factoryboxLocation } from "./factorybox-location";
import { type FactoryboxRuntimeInput, renderFactoryboxRuntime } from "./factorybox-runtime";
import type { FactoryboxWorkerIdentity } from "./factorybox-worker";

const workerID = "01234567-89ab-4def-8123-456789abcdef";
const bootstrap = `registry.invalid/runtime@sha256:${"a".repeat(64)}`;
const input: FactoryboxRuntimeInput = {
  ...factoryboxLocation(workerID),
  attemptID: workerID,
  sandboxID: `runtime-${workerID.replaceAll("-", "")}`,
  runtimeOwnerID: workerID,
  labels: {},
  runtimeHostImage: `registry.invalid/runtime@sha256:${"b".repeat(64)}`,
  workerRuntimeHostImage: bootstrap,
  sharedSource: false,
  profile: {
    image: `registry.invalid/worker@sha256:${"c".repeat(64)}`,
    executableSHA256: "d".repeat(64),
    architecture: "arm64",
    kernel: "6.12.0",
    nodeName: "owned-node",
    boundedBytes: 8589934592,
    claimGiB: 32,
  },
};
const identity: FactoryboxWorkerIdentity = {
  version: 1,
  namespaceUID: "namespace-uid",
  podUID: "worker-uid",
  claimUID: "claim-uid",
  storeID: workerID.replaceAll("-", ""),
  epoch: "e".repeat(32),
  bootID: "boot",
  nodeBootID: "node-boot",
  executableSHA256: input.profile.executableSHA256,
  controllerRoot: "/controller",
};

function fixture() {
  const intent = factoryboxConsumerIntent(input, identity);
  const key = new Bun.CryptoHasher("sha256").update(input.runtimeHostImage).digest("hex");
  const subPath = `consumer-seeds/${key}`;
  const declared = renderFactoryboxConsumer(input, identity, subPath);
  const events: string[] = [];
  let observed: unknown = null;
  let attempted = false;
  let completed = false;
  let savedUID: string | null = null;
  const faults = {
    loseCreate: false,
    disappear: false,
    uid: "exporter-uid",
    mutate: (_value: typeof declared) => {},
  };
  const run: typeof runCommand = async (args, body) => {
    const reply = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
    if (args[0] === "exec") {
      const request = JSON.parse(body ?? "");
      expect(request.intent).toEqual(intent);
      events.push(request.action);
      if (request.action === "begin") {
        const create = !attempted;
        if (create && request.existingUID) throw new Error("Unowned exporter");
        attempted = true;
        return reply({ create, complete: completed, exporterUID: savedUID ?? undefined, subPath });
      }
      if (savedUID && savedUID !== request.exporterUID) throw new Error("Pod UID changed");
      savedUID = request.exporterUID;
      if (request.action === "complete") completed = true;
      return reply({ create: false, complete: completed, exporterUID: savedUID, subPath });
    }
    if (args[0] === "get")
      return observed
        ? reply(observed)
        : { stdout: "", stderr: "Error from server (NotFound): absent", exitCode: 1 };
    if (args[0] === "create") {
      expect(attempted).toBe(true);
      expect(JSON.parse(body ?? "")).toEqual(declared);
      events.push("create");
      const pod = structuredClone(declared);
      faults.mutate(pod);
      observed = {
        ...pod,
        metadata: { ...pod.metadata, uid: faults.uid },
        status: {
          phase: "Succeeded",
          containerStatuses: [{ restartCount: 0, state: { terminated: { exitCode: 0 } } }],
        },
      };
      if (faults.disappear) observed = null;
      return faults.loseCreate || faults.disappear
        ? { stdout: "", stderr: "Lost create reply", exitCode: 1 }
        : reply(observed);
    }
    if (args[0] === "delete") {
      expect(JSON.parse(body ?? "").preconditions.uid).toBe(savedUID);
      events.push("delete");
      observed = null;
      return reply({});
    }
    throw new Error(`Unexpected command ${args[0]}`);
  };
  return {
    run,
    events,
    faults,
    replace() {
      observed = { ...declared, metadata: { ...declared.metadata, uid: "replacement" } };
    },
  };
}

test("consumer selection changes no original Pod declaration, mounts no Source or credentials in its exporter", () => {
  const original = renderFactoryboxRuntime({ ...input, runtimeHostImage: bootstrap });
  expect(renderFactoryboxRuntime(input)).toEqual(original);
  const declaration = renderFactoryboxConsumer(
    input,
    identity,
    `consumer-seeds/${new Bun.CryptoHasher("sha256").update(input.runtimeHostImage).digest("hex")}`,
  );
  expect(declaration.spec.containers[0]?.image).toBe(input.runtimeHostImage);
  expect(declaration.spec.volumes).toHaveLength(1);
  expect(declaration.spec.containers[0]?.volumeMounts).toHaveLength(1);
  expect(declaration.spec.containers[0]?.resources).toEqual({
    requests: { cpu: "500m", memory: "256Mi" },
    limits: { cpu: "500m", memory: "256Mi" },
  });
  expect(declaration.spec.containers[0]?.command[2]).toContain("fdatasyncSync(descriptor)");
  expect(declaration.spec.automountServiceAccountToken).toBe(false);
  expect(JSON.stringify(declaration)).not.toContain("runtime-data");
  expect(JSON.stringify(declaration)).not.toContain("Secret");
  expect(() => renderFactoryboxConsumer(input, identity, "seed")).toThrow("immutable image");
});

test.each([10, 100, 1000])(
  "later consumer image exports retain the worker's %im CPU scheduling envelope",
  (cpuRequestMilli) => {
    const request = { ...input, profile: { ...input.profile, cpuRequestMilli } };
    const declaration = renderFactoryboxConsumer(
      request,
      identity,
      `consumer-seeds/${new Bun.CryptoHasher("sha256").update(input.runtimeHostImage).digest("hex")}`,
    );
    expect(declaration.spec.containers[0]?.resources).toEqual({
      requests: { cpu: `${Math.min(cpuRequestMilli, 500)}m`, memory: "256Mi" },
      limits: { cpu: "500m", memory: "256Mi" },
    });
  },
);

test.each([false, true])(
  "a confirmed export is shared, UID-cleaned and never recreated, lost reply=%s",
  async (lost) => {
    const f = fixture();
    f.faults.loseCreate = lost;
    await ensureFactoryboxConsumer(input, identity, f.run, performance.now() + 10_000);
    await ensureFactoryboxConsumer(input, identity, f.run, performance.now() + 10_000);
    expect(f.events).toEqual(["begin", "create", "observe", "complete", "delete", "begin"]);
  },
);

test("an uncertain missing exporter cannot authorize a second create", async () => {
  const f = fixture();
  f.faults.disappear = true;
  await expect(
    ensureFactoryboxConsumer(input, identity, f.run, performance.now() + 10_000),
  ).rejects.toThrow("unconfirmed");
  await expect(
    ensureFactoryboxConsumer(input, identity, f.run, performance.now() + 10_000),
  ).rejects.toThrow("refusing replacement");
  expect(f.events.filter((event) => event === "create")).toHaveLength(1);
});

test.each(["image", "credentials", "storage", "service-account"] as const)(
  "consumer export refuses %s drift before accepting or deleting the exporter",
  async (change) => {
    const f = fixture();
    f.faults.mutate = (pod) => {
      const container = pod.spec.containers[0];
      if (!container) throw new Error("Missing exporter");
      if (change === "image") container.image = bootstrap;
      if (change === "credentials")
        Reflect.set(container, "envFrom", [{ secretRef: { name: "foreign" } }]);
      const volume = pod.spec.volumes[0];
      if (change === "storage" && volume) volume.persistentVolumeClaim.claimName = "runtime-data";
      if (change === "service-account")
        Reflect.deleteProperty(pod.spec, "automountServiceAccountToken");
    };
    await expect(
      ensureFactoryboxConsumer(input, identity, f.run, performance.now() + 10_000),
    ).rejects.toThrow("original declaration");
    expect(f.events).toEqual(["begin", "create"]);
  },
);

test("completed export cleanup never deletes a replacement Pod", async () => {
  const f = fixture();
  await ensureFactoryboxConsumer(input, identity, f.run, performance.now() + 10_000);
  f.replace();
  await expect(
    ensureFactoryboxConsumer(input, identity, f.run, performance.now() + 10_000),
  ).rejects.toThrow("replacement Pod");
  expect(f.events.filter((event) => event === "create")).toHaveLength(1);
  expect(f.events.filter((event) => event === "delete")).toHaveLength(1);
});
