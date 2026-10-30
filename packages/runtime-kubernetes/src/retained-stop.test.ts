import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { factoryboxLocation, factoryboxSharedLabels } from "./factorybox-location";
import {
  createRetainedStopClient,
  type RetainedStopDeclaration,
  renderRetainedStopPod,
  retainedStopPodName,
} from "./retained-stop";

function fixture() {
  const workerID = crypto.randomUUID(),
    workspaceID = crypto.randomUUID();
  const runner = 'console.log("owned native Stop");';
  const input: RetainedStopDeclaration = {
    stopID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
    workspaceID,
    projectID: crypto.randomUUID(),
    workerID,
    namespace: factoryboxLocation(workerID).namespace,
    namespaceUID: crypto.randomUUID(),
    claimUID: crypto.randomUUID(),
    sourcePodName: `source-${workspaceID.replaceAll("-", "")}-1`,
    sourcePodUID: crypto.randomUUID(),
    storageNode: "owned-node",
    sourceDirectory: `workspaces/${workspaceID.replaceAll("-", "")}/home`,
    image: `owned/runtime@sha256:${"a".repeat(64)}`,
    runnerSHA256: createHash("sha256").update(runner).digest("hex"),
    input: {
      stopID: "owned-stop",
      attemptID: "owned-attempt",
      sessionID: "owned-session",
      promptID: "owned-prompt",
      modelID: "owned-model",
      version: "2.0.27",
    },
  };
  const source = {
    namespace: { metadata: { uid: input.namespaceUID, labels: factoryboxSharedLabels(workerID) } },
    persistentvolumeclaim: {
      metadata: { uid: input.claimUID, labels: factoryboxSharedLabels(workerID) },
    },
    pod: {
      metadata: { uid: input.sourcePodUID, labels: { "factory.dev/runtime-owner": workspaceID } },
    },
    node: {
      metadata: { uid: crypto.randomUUID(), labels: {} },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
  };
  const native = {
    ...renderRetainedStopPod(input, runner),
    metadata: { ...renderRetainedStopPod(input, runner).metadata, uid: crypto.randomUUID() },
    status: {
      phase: "Succeeded",
      containerStatuses: [
        {
          name: "settle",
          state: { terminated: { exitCode: 0, finishedAt: new Date().toISOString() } },
        },
      ],
    },
  };
  // Match Kubernetes' omission of empty/default Pod fields, not just authored YAML.
  Reflect.deleteProperty(native.spec, "initContainers");
  Reflect.deleteProperty(native.spec, "hostNetwork");
  Reflect.deleteProperty(native.spec, "hostPID");
  Reflect.deleteProperty(native.spec, "hostIPC");
  Reflect.deleteProperty(native.spec, "shareProcessNamespace");
  let present = false;
  const writes: string[] = [];
  const client = createRetainedStopClient(async (argv, raw) => {
    const args = [...argv];
    if (args.includes("get")) {
      const position = args.indexOf("get");
      const kind = args[position + 1],
        name = args[position + 2];
      const value =
        kind === "pod" && name === retainedStopPodName(input.stopID)
          ? present
            ? native
            : undefined
          : kind === "namespace"
            ? source.namespace
            : kind === "persistentvolumeclaim"
              ? source.persistentvolumeclaim
              : kind === "node"
                ? source.node
                : source.pod;
      return { stdout: value ? JSON.stringify(value) : "", stderr: "", exitCode: 0 };
    }
    if (args.includes("create")) {
      expect(JSON.parse(raw ?? "")).toEqual(renderRetainedStopPod(input, runner));
      writes.push("create");
      present = true;
      return { stdout: JSON.stringify(native), stderr: "", exitCode: 0 };
    }
    if (args.includes("logs"))
      return { stdout: JSON.stringify({ confirmed: true }), stderr: "", exitCode: 0 };
    if (args.includes("delete")) {
      expect(JSON.parse(raw ?? "")["preconditions"]).toEqual({ uid: native.metadata.uid });
      writes.push("delete");
      present = false;
      return { stdout: "{}", stderr: "", exitCode: 0 };
    }
    throw new Error("Unexpected native Stop fixture command");
  });
  return { input, runner, source, native, client, writes };
}

test("native Stop Pod mounts only retained Git metadata and has no Project or execution capabilities", async () => {
  const owned = fixture();
  const pod = renderRetainedStopPod(owned.input, owned.runner);
  expect(pod.spec.automountServiceAccountToken).toBe(false);
  expect(pod.spec.restartPolicy).toBe("Never");
  expect(pod.spec.securityContext.runAsUser).toBe(101000);
  expect(pod.spec.volumes).toEqual([
    { name: "native", persistentVolumeClaim: { claimName: "runtime-data" } },
    { name: "location", emptyDir: { sizeLimit: "1Mi" } },
    { name: "temporary", emptyDir: { sizeLimit: "256Mi" } },
  ]);
  expect(pod.spec.containers[0]?.volumeMounts[0]).toEqual({
    name: "native",
    mountPath: "/native-session",
    subPath: `${owned.input.sourceDirectory}/project/.git`,
  });
  const created = await owned.client.create(owned.input, owned.runner);
  expect(created).toEqual({
    uid: owned.native.metadata.uid,
    phase: "Succeeded",
    result: { confirmed: true },
  });
  await owned.client.remove(owned.input, created.uid);
  expect(owned.writes).toEqual(["create", "delete"]);
});

for (const changed of ["namespace", "claim", "source"] as const)
  test(`native Stop refuses a changed ${changed} UID before external create`, async () => {
    const owned = fixture();
    const resource =
      changed === "namespace"
        ? owned.source.namespace
        : changed === "claim"
          ? owned.source.persistentvolumeclaim
          : owned.source.pod;
    resource.metadata.uid = crypto.randomUUID();
    await expect(owned.client.create(owned.input, owned.runner)).rejects.toThrow(
      "Source identity changed",
    );
    expect(owned.writes).toEqual([]);
  });

for (const changed of ["runner", "image", "mount", "sidecar"] as const)
  test(`native Stop observation refuses changed ${changed}`, async () => {
    const owned = fixture();
    await owned.client.create(owned.input, owned.runner);
    const container = owned.native.spec.containers[0];
    if (!container) throw new Error("Missing owned native container");
    if (changed === "runner") container.command[3] = "bm90LWd6aXA=";
    if (changed === "image") container.image = `owned/other@sha256:${"b".repeat(64)}`;
    if (changed === "mount")
      container.volumeMounts.push({
        name: "native",
        mountPath: "/workspace/project",
        subPath: owned.input.sourceDirectory,
      });
    if (changed === "sidecar")
      owned.native.spec.containers.push({ ...container, name: "unexpected" });
    await expect(owned.client.observe(owned.input)).rejects.toThrow();
    expect(owned.writes).toEqual(["create"]);
  });

test("native Stop cleanup uses the exact observed Pod UID", async () => {
  const owned = fixture();
  const created = await owned.client.create(owned.input, owned.runner);
  owned.native.metadata.uid = crypto.randomUUID();
  await expect(owned.client.remove(owned.input, created.uid)).rejects.toThrow("UID changed");
  expect(owned.writes).toEqual(["create"]);
});

test("native Stop recovers the original Pod after JSONB reorders retained input properties", async () => {
  const owned = fixture();
  const created = await owned.client.create(owned.input, owned.runner);
  const recovered = JSON.parse(JSON.stringify(owned.input)) as RetainedStopDeclaration;
  recovered.input = Object.fromEntries(Object.entries(recovered.input).reverse());
  expect(JSON.stringify(recovered.input)).not.toBe(JSON.stringify(owned.input.input));
  expect(await owned.client.observe(recovered)).toEqual(created);
  await owned.client.remove(recovered, created.uid);
  expect(owned.writes).toEqual(["create", "delete"]);
});

for (const changed of ["value", "property", "environment", "invalid-json"] as const)
  test(`native Stop refuses changed input ${changed} after persistence`, async () => {
    const owned = fixture();
    await owned.client.create(owned.input, owned.runner);
    const container = owned.native.spec.containers[0];
    const environment = container?.env[0];
    if (!container || !environment) throw new Error("Missing owned native input");
    if (changed === "value")
      environment.value = JSON.stringify({ ...owned.input.input, modelID: "another-model" });
    if (changed === "property")
      environment.value = JSON.stringify({ ...owned.input.input, unknown: "unexpected" });
    if (changed === "environment") container.env.push({ name: "UNEXPECTED", value: "unexpected" });
    if (changed === "invalid-json") environment.value = "{";
    await expect(owned.client.observe(owned.input)).rejects.toThrow();
    expect(owned.writes).toEqual(["create"]);
  });

test("native Stop distinguishes proven non-execution from an unproved failed Pod", async () => {
  const owned = fixture();
  await owned.client.create(owned.input, owned.runner);
  owned.native.status.phase = "Failed";
  const state = owned.native.status.containerStatuses[0];
  if (!state) throw new Error("Missing owned native process status");
  Reflect.deleteProperty(state.state, "terminated");
  expect((await owned.client.observe(owned.input))?.terminal).toBeUndefined();
  Reflect.set(owned.native.status, "reason", "DeadlineExceeded");
  Reflect.set(state, "started", false);
  Reflect.set(state, "restartCount", 0);
  Reflect.set(state, "imageID", "");
  expect((await owned.client.observe(owned.input))?.terminal).toBe("not-started");
  Reflect.set(state.state, "terminated", {
    exitCode: 137,
    reason: "ContainerStatusUnknown",
    startedAt: null,
    finishedAt: null,
  });
  expect((await owned.client.observe(owned.input))?.terminal).toBe("not-started");
  const ready = owned.source.node.status.conditions[0];
  if (!ready) throw new Error("Missing owned node readiness");
  ready.status = "False";
  expect((await owned.client.observe(owned.input))?.terminal).toBeUndefined();
  ready.status = "True";
  Reflect.set(state, "started", true);
  expect((await owned.client.observe(owned.input))?.terminal).toBeUndefined();
});
