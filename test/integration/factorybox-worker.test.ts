import { expect, test } from "bun:test";
import { z } from "zod";
import { reclaimRetiredFactoryboxBacking } from "../../apps/factory/src/runtime/factorybox-retirement";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import {
  createFactoryboxWorker,
  factoryboxAllocation,
  rememberFactoryboxIdentity,
  rememberFactoryboxSource,
  retainedFactoryboxProfile,
  withFactoryboxWorkerLock,
} from "../../apps/factory/src/runtime/worker";
import { recoverFactoryboxWorker } from "../../apps/factory/src/runtime/worker-recovery";
import { defaultReservePolicy } from "../../packages/runtime-domain/src/reserve";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import {
  factoryboxAssignmentSecret,
  type factoryboxLocation,
  factoryboxSharedLabels,
} from "../../packages/runtime-kubernetes/src/factorybox-location";
import {
  type FactoryboxRuntimeInput,
  type FactoryboxRuntimeProfile,
  factoryboxSandboxID,
  renderFactoryboxRuntime,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import type { executeFactoryboxOperation } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { executionPoolFixture } from "../fixtures/execution-pool";
import { eventually, factoryProcess } from "../fixtures/factory-process";
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

test("fresh isolated default execution binds its original node through the persisted destination without Workspace Source preparation", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const kube = infrastructure();
  const worker = createFactoryboxWorker(database, kube.kubernetes);
  try {
    const original = await factoryboxAllocation(database.client);
    expect(original.nodeName).toBeNull();
    const destination = { workerID: original.id, admissionID: original.admissionID };
    await worker.provision(resources(original), profile, runtimeImage, destination);
    const bound = await factoryboxAllocation(
      database.client,
      undefined,
      original.id,
      original.admissionID,
    );
    expect(bound.id).toBe(original.id);
    expect(bound.admissionID).toBe(original.admissionID);
    expect(bound.nodeName).toBe(profile.nodeName);
    expect(bound.profile).toEqual(profile);
    await expect(
      factoryboxAllocation(database.client, "another-node", original.id, original.admissionID),
    ).rejects.toThrow("retained node");
  } finally {
    await database.client.end();
    await host.dispose();
  }
});

test("node-derived worker budget is retained before create and never reselected for an admitted worker", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const kube = infrastructure();
  const worker = createFactoryboxWorker(database, kube.kubernetes);
  const configured: FactoryboxRuntimeProfile = {
    ...profile,
    resourceAdmission: { memoryHeadroomMiB: 2048 },
  };
  let observations = 0;
  try {
    const selected = await retainedFactoryboxProfile(
      database.client,
      configured,
      runtimeImage,
      async (input) => {
        observations++;
        expect(kube.writes).toHaveLength(0);
        return { ...input, resources: { cpuMilli: 8000, memoryMiB: 12288 } };
      },
    );
    const before = await factoryboxAllocation(database.client);
    expect(before.profile).toEqual(selected);
    expect(before.runtimeHostImage).toBe(runtimeImage);
    expect(before.attempted).toBe(false);
    expect(before.podUID).toBeNull();
    expect(selected.resources).toEqual({ cpuMilli: 8000, memoryMiB: 12288 });
    const location = await worker.location();
    const laterConsumer = `registry.invalid/runtime@sha256:${"c".repeat(64)}`;
    await worker.provision(resources(location, laterConsumer, selected), selected, laterConsumer);
    const after = await factoryboxAllocation(database.client);
    expect(after.attempted).toBe(true);
    expect(after.profile).toEqual(selected);
    expect(after.id).toBe(before.id);
    expect(after.admissionID).toBe(before.admissionID);
    expect(after.runtimeHostImage).toBe(runtimeImage);
    const [original] = await database.client<Array<{ image: string }>>`
      SELECT runtime_host_image AS image FROM factory.factorybox_worker WHERE id=${after.id}`;
    expect(original?.image).toBe(runtimeImage);
    expect(
      await retainedFactoryboxProfile(
        database.client,
        { ...configured, resourceAdmission: { memoryHeadroomMiB: 4096 } },
        runtimeImage,
        async () => {
          throw new Error("An admitted budget must not depend on later node availability");
        },
      ),
    ).toEqual(selected);
    expect(observations).toBe(1);
    await expect(
      worker.provision(
        resources(location, runtimeImage, selected),
        { ...selected, resources: { cpuMilli: 8000, memoryMiB: 16384 } },
        runtimeImage,
      ),
    ).rejects.toThrow("already pinned");
    const final = await factoryboxAllocation(database.client);
    expect(final.podUID).toBe(after.podUID);
    expect(final.claimUID).toBe(after.claimUID);
    expect(final.profile).toEqual(selected);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
});

test("resource observation neither commissions a worker nor pins a budget without execution", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const configured: FactoryboxRuntimeProfile = {
    ...profile,
    resourceAdmission: { memoryHeadroomMiB: 2048 },
  };
  try {
    expect(await retainedFactoryboxProfile(database.client, configured)).toEqual(configured);
    expect(await database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    await expect(
      retainedFactoryboxProfile(database.client, configured, runtimeImage, async () => {
        throw new Error("Owned node observation unavailable");
      }),
    ).rejects.toThrow("observation unavailable");
    const allocation = await factoryboxAllocation(database.client);
    expect(allocation.profile).toBeNull();
    expect(allocation.runtimeHostImage).toBeNull();
    expect(allocation.attempted).toBe(false);
    expect(allocation.podUID).toBeNull();
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
});

test("concurrent first executions share one selected resource budget and bootstrap image", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const configured: FactoryboxRuntimeProfile = {
    ...profile,
    resourceAdmission: { memoryHeadroomMiB: 2048 },
  };
  const otherImage = `registry.invalid/runtime@sha256:${"b".repeat(64)}`;
  try {
    const selections = await Promise.all(
      [runtimeImage, otherImage].map((image, index) =>
        retainedFactoryboxProfile(database.client, configured, image, async (input) => ({
          ...input,
          resources: { cpuMilli: 8000, memoryMiB: 12288 + index * 1024 },
        })),
      ),
    );
    expect(selections[0]).toEqual(selections[1]);
    const allocation = await factoryboxAllocation(database.client);
    expect(allocation.profile).toEqual(selections[0]);
    if (!allocation.runtimeHostImage) throw new Error("Missing retained worker bootstrap image");
    expect([runtimeImage, otherImage]).toContain(allocation.runtimeHostImage);
    expect(allocation.attempted).toBe(false);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
});

function infrastructure() {
  const objects = new Map<string, z.infer<typeof manifest>>();
  const writes: Array<{ action: string; kind: string; name: string }> = [];
  const fault = {
    losePodCreate: false,
    unavailableRead: false,
    beforeRead: async (_args: readonly string[]) => {},
    beforePodCreate: async (_pod: z.infer<typeof manifest>) => {},
  };
  const kubernetes = createKubernetesClient(async (args, body) => {
    if (args[0] === "get") {
      await fault.beforeRead(args);
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
      if (item.kind === "Pod") await fault.beforePodCreate(item);
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
      async attempt(state: "create-intended" | "starting" | "failed", generation = 1) {
        const id = crypto.randomUUID();
        await database.client`INSERT INTO factory.runtime_attempt(
          id,project_id,isolated_kind,generation,revision,state,
          parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          VALUES(${id},${projectID},'staging',${generation},${"a".repeat(40)},${state},
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

async function admittedWorker(controllerRoot = "/factorybox") {
  const f = await failedBootstrap();
  const { original } = f;
  if (!original.podUID || !original.claimUID || !original.namespaceUID)
    throw new Error("Missing admitted fixture identities");
  await f.database.client`INSERT INTO factory.administrator(user_id) VALUES(${f.actorID})`;
  const identity = {
    version: 1 as const,
    podUID: original.podUID,
    claimUID: original.claimUID,
    namespaceUID: original.namespaceUID,
    storeID: original.admissionID.replaceAll("-", ""),
    epoch: "e".repeat(32),
    bootID: "original-boot",
    nodeBootID: "original-node-boot",
    executableSHA256: profile.executableSHA256,
    controllerRoot,
  };
  await rememberFactoryboxIdentity(f.database.client, original.id, identity);
  return { ...f, identity };
}

test.each(["normal", "lost reply", "unconfirmed Delete", "missing checkpoint"] as const)(
  "successor retires exact old backing with %s while preserving execution and store identities",
  async (scenario) => {
    const root = "/var/lib/sysbox/fixed-store/data/store";
    const f = await admittedWorker(`${root}/epochs/${"e".repeat(32)}/controller`);
    const sql = f.database.coordination();
    let pool: Awaited<ReturnType<typeof executionPoolFixture>> | undefined;
    try {
      const store = createReserveStore(
        defaultReservePolicy,
        {
          staging: runtimeImage,
          verification: runtimeImage,
        },
        profile,
      );
      pool = await executionPoolFixture(
        f.database,
        store,
        profile,
        { staging: runtimeImage, verification: runtimeImage },
        { projectID: f.projectID, userID: f.actorID },
      );
      const template = await pool.prepareTemplate(f.identity);
      if (!template) throw new Error("Missing owned template");
      await store.retire(f.database.client, template.id);
      await store.intendDelete(f.database.client, template.id);
      const checkpoint = {
        source_id: factoryboxSandboxID(template.id),
        source_owner: "e".repeat(32),
        snapshot_id: template.id.replaceAll("-", ""),
        checkpoint_sha256: "f".repeat(64),
      };
      const slotRequest = {
        version: 1,
        storeID: f.identity.storeID,
        epoch: f.identity.epoch,
        sandboxID: checkpoint.source_id,
        checkpoints: [checkpoint],
        resumes: [],
        backing: {
          sandbox_id: checkpoint.source_id,
          sandbox_owner: checkpoint.source_owner,
          input_sha256: "a".repeat(64),
        },
      };
      await store.intendRetirement(f.database.client, template.id, slotRequest);
      if (scenario !== "missing checkpoint")
        await store.completeRetirementPart(f.database.client, template.id, {
          action: "retire-checkpoint",
          controllerRoot: f.identity.controllerRoot,
          request: checkpoint,
          intentSHA256: "1".repeat(64),
          completedAt: "original-native-checkpoint-retirement",
          availableBytesBefore: 1024,
          availableBytesAfter: 2048,
        });
      await store.retired(f.database.client, template.id);
      const oldID = await f.attempt("starting", 2);
      function input(
        attemptID: string,
        podName: string,
        selected: FactoryboxRuntimeProfile,
      ): FactoryboxRuntimeInput {
        return {
          attemptID,
          workerID: f.original.id,
          namespace: f.original.namespace,
          podName,
          sandboxID: factoryboxSandboxID(attemptID),
          runtimeOwnerID: attemptID,
          labels: {},
          sharedSource: false,
          runtimeHostImage: runtimeImage,
          profile: selected,
        };
      }
      const oldInput = input(oldID, f.original.podName, profile);
      const backing = {
        sandbox_id: oldInput.sandboxID,
        sandbox_owner: "a".repeat(32),
        input_sha256: "b".repeat(64),
      };
      await f.database
        .client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request,identity)
        VALUES(${oldID},${JSON.stringify(oldInput)}::jsonb,${JSON.stringify(f.identity)}::jsonb)`;
      await f.database.client`INSERT INTO factory.factorybox_lifecycle_operation
        (runtime_attempt_id,action,attempted_at,completed_at,observation)
        VALUES(${oldID},'delete',now(),now(),${JSON.stringify({
          id: backing.sandbox_id,
          owner: backing.sandbox_owner,
          inputSHA256: backing.input_sha256,
          phase: scenario === "unconfirmed Delete" ? "running" : "deleted",
        })}::jsonb)`;
      await f.database.client`INSERT INTO factory.factorybox_lifecycle_operation
        (runtime_attempt_id,action,request,attempted_at)
        VALUES(${oldID},'retire-sandbox',${JSON.stringify(backing)}::jsonb,now())`;
      await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',
        stop_intended_at=now(),stopped_at=now() WHERE id IN (${oldID},${pool.stagingID})`;
      const before = [
        ...(await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${oldID}`),
      ];
      const [originalOperation] = await f.database.client`SELECT intended_at,attempted_at,request
        FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${oldID} AND action='retire-sandbox'`;
      const nextProfile = {
        ...profile,
        image: `registry.invalid/upgraded@sha256:${"7".repeat(64)}`,
        executableSHA256: "8".repeat(64),
      };
      await recoverFactoryboxWorker(f.database, f.kube.kubernetes, nextProfile, runtimeImage, {
        actorID: f.actorID,
        requestID: crypto.randomUUID(),
      });
      const selected = await retainedFactoryboxProfile(f.database.client);
      const location = await f.worker.location();
      await f.worker.provision(resources(location, runtimeImage, selected), selected, runtimeImage);
      const next = await factoryboxAllocation(f.database.client);
      const identity = {
        ...f.identity,
        podUID: next.podUID ?? "",
        epoch: "f".repeat(32),
        controllerRoot: `${root}/epochs/${"f".repeat(32)}/controller`,
        executableSHA256: nextProfile.executableSHA256,
      };
      await rememberFactoryboxIdentity(f.database.client, next.id, identity);
      const currentID = await f.attempt("starting", 3);
      const request = input(currentID, next.podName, selected);
      await f.database
        .client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request,identity)
        VALUES(${currentID},${JSON.stringify(request)}::jsonb,${JSON.stringify(identity)}::jsonb)`;
      const calls: unknown[] = [];
      let lost = scenario === "lost reply";
      const execute: typeof executeFactoryboxOperation = async (target, observed, operation) => {
        expect(target.executableSHA256).toBe(nextProfile.executableSHA256);
        expect(observed).toEqual(identity);
        expect(operation).toMatchObject({
          action: "retire-sandbox",
          sourceRoot: f.identity.controllerRoot,
        });
        if (operation.action !== "retire-sandbox") throw new Error("Unexpected native execution");
        calls.push(operation);
        if (lost && operation.sandboxID === oldInput.sandboxID) {
          lost = false;
          return { confirmed: false, stdout: "", stderr: "lost original reply", exitCode: 1 };
        }
        return {
          confirmed: true,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            version: 1,
            payload_kind: "sandbox-backing",
            request: {
              sandbox_id: operation.sandboxID,
              sandbox_owner: operation.sandboxOwner,
              input_sha256: operation.inputSHA256,
            },
            intent_sha256: "9".repeat(64),
            completed_at: "retired-by-current-worker",
            before: { root: f.identity.controllerRoot, filesystem_available_bytes: 2048 },
            after: { root: f.identity.controllerRoot, filesystem_available_bytes: 4096 },
          }),
        };
      };
      let cursor = { attempts: null as string | null, slots: null as string | null };
      async function sweep() {
        cursor = await withFactoryboxWorkerLock(sql, () =>
          reclaimRetiredFactoryboxBacking(sql, { request, identity }, cursor, undefined, execute),
        );
      }
      await sweep();
      if (scenario === "lost reply") {
        const [pending] = await f.database.client`SELECT completed_at
          FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${oldID} AND action='retire-sandbox'`;
        expect(pending?.["completed_at"]).toBeNull();
        await sweep();
      }
      const [operation] = await f.database
        .client`SELECT intended_at,attempted_at,request,completed_at
        FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${oldID} AND action='retire-sandbox'`;
      if (!originalOperation || !operation)
        throw new Error("Missing original retained backing intent");
      expect(operation).toMatchObject(originalOperation);
      expect(operation?.["completed_at"] !== null).toBe(scenario !== "unconfirmed Delete");
      expect([
        ...(await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${oldID}`),
      ]).toEqual(before);
      const [saved] = await f.database.client`SELECT request,identity,
        inputs_released_at IS NOT NULL AS released FROM factory.factorybox_runtime
        WHERE runtime_attempt_id=${oldID}`;
      expect(saved).toMatchObject({
        request: oldInput,
        identity: f.identity,
        released: scenario !== "unconfirmed Delete",
      });
      const [slot] = await f.database.client`SELECT factorybox_retirement_progress AS progress,
        factorybox_retirement_observation AS observation FROM factory.execution_slot WHERE id=${template.id}`;
      expect(slot?.["observation"] !== null).toBe(scenario !== "missing checkpoint");
      expect(slot?.["progress"]).toHaveLength(scenario === "missing checkpoint" ? 0 : 2);
      const count = calls.length;
      await sweep();
      expect(calls).toHaveLength(count);
      expect(next.claimUID).toBe(f.original.claimUID);
      expect(next.sourceClaimUID).toBe(f.original.sourceClaimUID);
    } finally {
      await pool?.cleanup();
      await sql.end({ timeout: 1 });
      await f.dispose();
    }
  },
  60_000,
);

test("explicit operator recovery keeps one store and Source while admitting a distinct worker lifetime", async () => {
  const f = await admittedWorker();
  try {
    const oldAttempt = await f.attempt("failed");
    const before = [
      ...(await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${oldAttempt}`),
    ];
    const request = { actorID: f.actorID, requestID: crypto.randomUUID() };
    const selected = { ...profile, resources: { cpuMilli: 8000, memoryMiB: 12288 } };
    const writes = f.kube.writes.length;
    const recovery = await recoverFactoryboxWorker(
      f.database,
      f.kube.kubernetes,
      selected,
      runtimeImage,
      request,
    );
    expect(f.kube.writes).toHaveLength(writes);
    expect(
      await recoverFactoryboxWorker(f.database, f.kube.kubernetes, selected, runtimeImage, request),
    ).toEqual(recovery);
    const current = await factoryboxAllocation(f.database.client);
    expect(current.claimUID).toBe(f.original.claimUID);
    expect(current.sourceClaimUID).toBe(f.original.sourceClaimUID);
    expect(current.namespaceUID).toBe(f.original.namespaceUID);
    expect(current.podUID).toBeNull();
    expect(current.identity).toBeNull();
    const retained = await retainedFactoryboxProfile(f.database.client);
    expect(retained.retainedStore).toEqual({
      storeID: f.identity.storeID,
      initializedByPodUID: f.identity.podUID,
      boundedBytes: profile.boundedBytes,
    });
    const location = await f.worker.location();
    await f.worker.provision(resources(location, runtimeImage, retained), retained, runtimeImage);
    const next = await factoryboxAllocation(f.database.client);
    expect(next.podUID).not.toBe(f.original.podUID);
    expect(next.claimUID).toBe(f.original.claimUID);
    expect(
      [...f.kube.objects.values()].filter((item) => item.kind === "PersistentVolumeClaim"),
    ).toHaveLength(2);
    expect([
      ...(await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${oldAttempt}`),
    ]).toEqual(before);
    await rememberFactoryboxIdentity(f.database.client, next.id, {
      ...f.identity,
      podUID: next.podUID ?? "",
      epoch: "f".repeat(32),
    });
    const [old] = await f.database.client`SELECT identity,retirement_observation
      FROM factory.factorybox_worker_admission WHERE id=${f.original.admissionID}`;
    expect(old?.["identity"]).toEqual(f.identity);
    expect(old?.["retirement_observation"]).toMatchObject({
      kind: "operator-recovery",
      requestID: request.requestID,
    });
  } finally {
    await f.dispose();
  }
}, 30_000);

test("explicit fresh storage recovery admits a new store without resizing or moving retained Source", async () => {
  const f = await admittedWorker();
  try {
    const oldAttempt = await f.attempt("failed");
    const before = [
      ...(await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${oldAttempt}`),
    ];
    const source = structuredClone(f.kube.objects.get("persistentvolumeclaim/runtime-data"));
    const oldClaim = structuredClone(
      f.kube.objects.get(`persistentvolumeclaim/store-${f.identity.storeID}`),
    );
    const request = {
      actorID: f.actorID,
      requestID: crypto.randomUUID(),
      storage: "fresh" as const,
    };
    const selected = { ...profile, boundedBytes: 16 * 1024 ** 3, claimGiB: 48 };
    const writes = f.kube.writes.length;
    const recovery = await recoverFactoryboxWorker(
      f.database,
      f.kube.kubernetes,
      selected,
      runtimeImage,
      request,
    );
    expect(f.kube.writes).toHaveLength(writes);
    const current = await factoryboxAllocation(f.database.client);
    expect(current.claimUID).toBeNull();
    expect(current.sourceClaimUID).toBe(f.original.sourceClaimUID);
    expect(current.namespaceUID).toBe(f.original.namespaceUID);
    const retained = await retainedFactoryboxProfile(f.database.client);
    expect(retained.boundedBytes).toBe(selected.boundedBytes);
    expect(retained.retainedStore).toBeUndefined();
    const location = await f.worker.location();
    await f.worker.provision(resources(location, runtimeImage, retained), retained, runtimeImage);
    const next = await factoryboxAllocation(f.database.client);
    expect(next.claimUID).not.toBe(f.original.claimUID);
    expect(next.podUID).not.toBe(f.original.podUID);
    expect(f.kube.objects.get("persistentvolumeclaim/runtime-data")).toEqual(source);
    expect(f.kube.objects.get(`persistentvolumeclaim/store-${f.identity.storeID}`)).toEqual(
      oldClaim,
    );
    expect(
      f.kube.objects.has(`persistentvolumeclaim/store-${request.requestID.replaceAll("-", "")}`),
    ).toBe(true);
    expect([
      ...(await f.database.client`SELECT * FROM factory.runtime_attempt WHERE id=${oldAttempt}`),
    ]).toEqual(before);
    expect(
      await recoverFactoryboxWorker(f.database, f.kube.kubernetes, selected, runtimeImage, request),
    ).toEqual(recovery);
    await expect(
      recoverFactoryboxWorker(f.database, f.kube.kubernetes, selected, runtimeImage, {
        ...request,
        storage: "retain",
      }),
    ).rejects.toThrow("another admission or actor");
  } finally {
    await f.dispose();
  }
}, 30_000);

test("fresh storage refuses unreleased private backing after logical Stop", async () => {
  const f = await admittedWorker();
  try {
    const attemptID = await f.attempt("starting");
    const request: FactoryboxRuntimeInput = {
      ...f.location,
      attemptID,
      sandboxID: factoryboxSandboxID(attemptID),
      runtimeOwnerID: attemptID,
      labels: {},
      sharedSource: false,
      runtimeHostImage: runtimeImage,
      profile,
    };
    await f.database
      .client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request,identity)
      VALUES(${attemptID},${JSON.stringify(request)}::jsonb,${JSON.stringify(f.identity)}::jsonb)`;
    await f.database.client`UPDATE factory.runtime_attempt
      SET state='stopped',stop_intended_at=now(),stopped_at=now() WHERE id=${attemptID}`;
    const before = [
      ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
    ];
    await expect(
      recoverFactoryboxWorker(f.database, f.kube.kubernetes, profile, runtimeImage, {
        actorID: f.actorID,
        requestID: crypto.randomUUID(),
        storage: "fresh",
      }),
    ).rejects.toThrow("confirmed private backing cleanup");
    expect([
      ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
    ]).toEqual(before);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("database fresh storage guard rejects reattaching a retained store and rolls retirement back", async () => {
  const f = await admittedWorker();
  try {
    const before = [
      ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
    ];
    await expect(
      recoverFactoryboxWorker(
        f.database,
        f.kube.kubernetes,
        profile,
        runtimeImage,
        { actorID: f.actorID, requestID: crypto.randomUUID(), storage: "fresh" },
        async (input) => ({
          ...input,
          retainedStore: {
            storeID: f.identity.storeID,
            initializedByPodUID: f.identity.podUID,
            boundedBytes: profile.boundedBytes,
          },
        }),
      ),
    ).rejects.toThrow("distinct uncreated store");
    expect([
      ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
    ]).toEqual(before);
  } finally {
    await f.dispose();
  }
}, 30_000);

test.each(["command", "database"] as const)(
  "fresh storage %s refuses pending backing from an earlier admission sharing the store",
  async (boundary) => {
    const f = await admittedWorker();
    try {
      const attemptID = await f.attempt("starting");
      const request: FactoryboxRuntimeInput = {
        ...f.location,
        attemptID,
        sandboxID: factoryboxSandboxID(attemptID),
        runtimeOwnerID: attemptID,
        labels: {},
        sharedSource: false,
        runtimeHostImage: runtimeImage,
        profile,
      };
      await f.database
        .client`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request,identity)
        VALUES(${attemptID},${JSON.stringify(request)}::jsonb,${JSON.stringify(f.identity)}::jsonb)`;
      await f.database.client`UPDATE factory.runtime_attempt
        SET state='stopped',stop_intended_at=now(),stopped_at=now() WHERE id=${attemptID}`;
      await recoverFactoryboxWorker(f.database, f.kube.kubernetes, profile, runtimeImage, {
        actorID: f.actorID,
        requestID: crypto.randomUUID(),
      });
      const selected = await retainedFactoryboxProfile(f.database.client);
      const location = await f.worker.location();
      await f.worker.provision(resources(location, runtimeImage, selected), selected, runtimeImage);
      const current = await factoryboxAllocation(f.database.client);
      expect(current.claimUID).toBe(f.original.claimUID);
      const pod = f.kube.objects.get(`pod/${current.podName}`);
      if (!pod) throw new Error("Missing retained successor Pod");
      Reflect.set(pod, "status", { phase: "Succeeded" });
      const before = [
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission ORDER BY id`),
      ];
      const fresh = {
        actorID: f.actorID,
        requestID: crypto.randomUUID(),
        storage: "fresh" as const,
      };
      const recovering =
        boundary === "command"
          ? recoverFactoryboxWorker(f.database, f.kube.kubernetes, profile, runtimeImage, fresh)
          : f.database.client`UPDATE factory.factorybox_worker_admission
            SET retired_at=now(),retirement_observation=${JSON.stringify({
              version: 1,
              kind: "operator-recovery",
              podUID: current.podUID,
              phase: "Succeeded",
              namespaceUID: current.namespaceUID,
              ...fresh,
            })}::jsonb WHERE id=${current.admissionID}`.then(() => {});
      await expect(recovering).rejects.toThrow("confirmed private backing cleanup");
      expect([
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission ORDER BY id`),
      ]).toEqual(before);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each([
  "running",
  "missing",
  "replacement",
  "active execution",
  "not manager",
  "unavailable",
] as const)(
  "operator recovery refuses %s before changing admissions or source",
  async (scenario) => {
    const f = await admittedWorker();
    try {
      if (scenario === "running") Reflect.set(f.pod, "status", { phase: "Running" });
      if (scenario === "missing") f.kube.objects.delete("pod/worker");
      if (scenario === "replacement") f.pod.metadata.uid = crypto.randomUUID();
      if (scenario === "active execution") await f.attempt("create-intended");
      if (scenario === "not manager")
        await f.database.client`DELETE FROM factory.administrator WHERE user_id=${f.actorID}`;
      if (scenario === "unavailable") f.kube.fault.unavailableRead = true;
      const before = [
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
      ];
      await expect(
        recoverFactoryboxWorker(f.database, f.kube.kubernetes, profile, runtimeImage, {
          actorID: f.actorID,
          requestID: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
      expect([
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
      ]).toEqual(before);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each(["storeID", "initializedByPodUID", "boundedBytes"] as const)(
  "database recovery guard rejects a changed retained %s and rolls retirement back",
  async (field) => {
    const f = await admittedWorker();
    try {
      const before = [
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
      ];
      await expect(
        recoverFactoryboxWorker(
          f.database,
          f.kube.kubernetes,
          profile,
          runtimeImage,
          { actorID: f.actorID, requestID: crypto.randomUUID() },
          async (input) => ({
            ...input,
            retainedStore: {
              storeID: f.identity.storeID,
              initializedByPodUID: f.identity.podUID,
              boundedBytes: profile.boundedBytes,
              [field]: field === "boundedBytes" ? 9 * 1024 ** 3 : "f".repeat(32),
            },
          }),
        ),
      ).rejects.toThrow("exact store");
      expect([
        ...(await f.database.client`SELECT * FROM factory.factorybox_worker_admission`),
      ]).toEqual(before);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test("recovery row lock fences a concurrent fresh commission on the retired admission", async () => {
  const f = await admittedWorker();
  const writer = f.database.coordination();
  const observed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  f.kube.fault.beforeRead = async (args) => {
    if (!held && args[1] === "pod") {
      held = true;
      observed.resolve();
      await release.promise;
    }
  };
  let recovering: ReturnType<typeof recoverFactoryboxWorker> | undefined;
  try {
    recovering = recoverFactoryboxWorker(f.database, f.kube.kubernetes, profile, runtimeImage, {
      actorID: f.actorID,
      requestID: crypto.randomUUID(),
    });
    await observed.promise;
    const [session] = await writer<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    if (!session) throw new Error("Missing concurrent writer");
    const id = crypto.randomUUID();
    const inserting = writer`INSERT INTO factory.runtime_attempt(
      id,project_id,isolated_kind,generation,revision,state,factorybox_worker_id,factorybox_admission_id,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${id},${f.projectID},'staging',1,${"a".repeat(40)},'create-intended',
        ${f.original.id},${f.original.admissionID},${"b".repeat(64)},${"c".repeat(64)},now(),${f.actorID})`.then(
      () => null,
      (cause: unknown) => cause,
    );
    await eventually(
      async () => [
        ...(await f.database.client`
      SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=${session.pid}`),
      ],
      (rows) => rows[0]?.["wait_event_type"] === "Lock" && rows[0]?.["wait_event"] !== "advisory",
      "Fresh commission never waited on the admission row",
    );
    release.resolve();
    await recovering;
    expect(String(await inserting)).toContain("active worker admission");
    expect(
      await f.database.client`SELECT id FROM factory.runtime_attempt WHERE id=${id}`,
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await recovering?.catch(() => {});
    await writer.end({ timeout: 2 });
    await f.dispose();
  }
}, 30_000);

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
    kube.fault.beforePodCreate = async (pod) => {
      const [admission] = await database.client<
        Array<{ attempted: boolean; declaration: unknown }>
      >`
        SELECT create_attempted AS attempted,declaration FROM factory.factorybox_worker_admission
        WHERE worker_id=${location.workerID} AND retired_at IS NULL`;
      expect(admission?.attempted).toBe(true);
      expect(admission?.declaration).toMatchObject({
        pod: { metadata: pod.metadata, spec: Reflect.get(pod, "spec") },
      });
    };
    const original = await worker.provision(resources(location), profile, runtimeImage);
    const originalPod = structuredClone(kube.objects.get("pod/worker"));
    const originalWorker = await factoryboxAllocation(database.client);
    const nextImage = `registry.invalid/runtime@sha256:${"b".repeat(64)}`;
    const upgraded = resources(location, nextImage);
    const upgradedPod = upgraded.find((item) => item.kind === "Pod");
    if (!upgradedPod) throw new Error("Missing upgraded renderer Pod");
    const spec = z
      .object({
        initContainers: z.array(
          z.object({ name: z.string(), command: z.array(z.string()) }).passthrough(),
        ),
      })
      .passthrough()
      .parse(Reflect.get(upgradedPod, "spec"));
    const exporter = spec.initContainers.find((container) => container.name === "runtime-image");
    if (!exporter) throw new Error("Missing upgraded exporter");
    exporter.command[2] = "upgraded exporter must not replace the original";
    Reflect.set(upgradedPod, "spec", spec);
    const next = await worker.provision(upgraded, profile, nextImage);
    expect(next).toMatchObject(original);
    expect(kube.objects.get("pod/worker")).toEqual(originalPod);
    expect(await factoryboxAllocation(database.client)).toEqual(originalWorker);
    expect(kube.writes.filter((write) => write.kind === "Pod")).toHaveLength(1);
    expect(kube.writes.filter((write) => write.kind === "PersistentVolumeClaim")).toHaveLength(2);
    expect(kube.writes.filter((write) => write.action === "apply")).toHaveLength(2);
    await expect(
      (async () => {
        await database.client`UPDATE factory.factorybox_worker_admission SET declaration='{}'::jsonb
          WHERE id=${originalWorker.admissionID}`;
      })(),
    ).rejects.toThrow("bootstrap declaration is immutable");
    await expect(
      (async () => {
        await database.client`UPDATE factory.factorybox_worker_admission SET declaration=NULL
          WHERE id=${originalWorker.admissionID}`;
      })(),
    ).rejects.toThrow("bootstrap declaration is immutable");
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
    await expect(worker.provision(requested, profile, runtimeImage)).rejects.toThrow(
      "no longer exists",
    );
    expect(kube.writes).toHaveLength(before);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);
