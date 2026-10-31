import { expect, test } from "bun:test";
import type { runCommand } from "./command";
import {
  executeFactoryboxOperation,
  type FactoryboxWorkerRequest,
  factoryboxOperation,
  factoryboxOperationFailure,
  factoryboxWorkerRequest,
  inspectFactoryboxWorker,
  observeOriginalFactoryboxDeclaration,
  renderFactoryboxWorker,
} from "./factorybox-worker";

const request: FactoryboxWorkerRequest = {
  version: 1,
  namespace: "factorybox-owned-test",
  podName: "worker",
  storeID: "a".repeat(32),
  trustDomainID: "b".repeat(32),
  image: `registry.invalid/factorybox@sha256:${"c".repeat(64)}`,
  executableSHA256: "d".repeat(64),
  architecture: "amd64",
  nodeName: "owned-linux-node",
  kernel: "7.2.8-9-omarchy",
  boundedBytes: 4 * 1024 ** 3,
  claimGiB: 32,
};
const epoch = "e".repeat(32);
const root = `/var/lib/sysbox/fixed-store/data/store/epochs/${epoch}/controller`;

test("aggregate worker budgets do not inherit one Sandbox's qualification ceiling", () => {
  const selected = factoryboxWorkerRequest.parse({
    ...request,
    cpuRequestMilli: 100,
    resources: { cpuMilli: 8000, memoryMiB: 12288 },
  });
  expect(renderFactoryboxWorker(selected)[2].spec.containers[0].resources).toEqual({
    requests: { cpu: "100m", memory: "12Gi" },
    limits: { cpu: "8", memory: "12Gi" },
  });
  expect(renderFactoryboxWorker(request)[2].spec.containers[0].resources).toEqual({
    requests: { cpu: "3", memory: "3Gi" },
    limits: { cpu: "3", memory: "3Gi" },
  });
});

test.each([
  [12922, "12922Mi"],
  [1024, "1Gi"],
  [1024 ** 2, "1Ti"],
] as const)(
  "selected %s MiB memory matches Kubernetes canonical quantity %s",
  (memoryMiB, expected) => {
    const selected = factoryboxWorkerRequest.parse({
      ...request,
      resources: { cpuMilli: 3000, memoryMiB },
    });
    const resource = renderFactoryboxWorker(selected)[2].spec.containers[0].resources;
    expect(resource.requests.memory).toBe(expected);
    expect(resource.limits.memory).toBe(expected);
  },
);

test("unconfirmed native work retains a compact actual cause without implying a safe mutation retry", () => {
  const reason = "available filesystem space is below the native write reserve";
  const error = factoryboxOperationFailure(
    "start",
    `\u001b[31m${reason}\u001b[0m\ncommand terminated with exit code 1\n`,
  );
  expect(error.message).toStartWith("Factorybox start outcome is unconfirmed");
  expect(error.message).toContain(reason);
  expect(error.message).not.toContain("\u001b");
  expect(error.message).not.toContain("command terminated");
  const pause = factoryboxOperationFailure("pause", "native\0 checkpoint\u0007 failed\n");
  expect(pause.message).toContain("native checkpoint failed");
  expect(pause.message).not.toContain("\0");
  expect(pause.message).not.toContain("\u0007");
  expect(factoryboxOperationFailure("resume", "").message).toBe(
    "Factorybox resume outcome is unconfirmed",
  );
  expect(
    factoryboxOperationFailure("pause", "diagnostic ".repeat(1000)).message.length,
  ).toBeLessThan(2100);
});

function fixture(input: FactoryboxWorkerRequest = request) {
  const resources = renderFactoryboxWorker(input);
  const namespace = {
    ...resources[0],
    metadata: { ...resources[0].metadata, uid: "namespace-uid" },
  };
  const claim = {
    ...resources[1],
    metadata: { ...resources[1].metadata, uid: "claim-uid" },
    status: { phase: "Bound" },
  };
  const pod = {
    ...resources[2],
    metadata: { ...resources[2].metadata, uid: "pod-uid" },
    spec: { ...resources[2].spec, nodeName: input.nodeName },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "worker", restartCount: 0, ready: true }],
    },
  };
  const node = {
    metadata: { name: input.nodeName },
    status: {
      nodeInfo: {
        operatingSystem: "linux",
        architecture: input.architecture,
        kernelVersion: input.kernel,
        bootID: "boot-id",
      },
    },
  };
  const status = {
    schema: 1,
    store_id: input.storeID,
    store: "/var/lib/sysbox/fixed-store/data/store",
    epoch,
    boot_id: "boot-id",
    supervisor_sha256: input.executableSHA256,
    supervisor: { pid: 1 },
    ready_at: "2026-10-25T10:00:00Z",
    lifecycle: {
      root,
      manager_root: "/var/lib/sysbox/fixed-store/data/store/manager",
      bounded_store: {
        target: "/var/lib/sysbox/fixed-store/data",
        direct_io: true,
        image: { owner: input.storeID, bytes: input.boundedBytes },
      },
    },
  };
  const calls: Array<readonly string[]> = [];
  const capacity: Record<string, unknown> = {
    version: 1,
    root,
    new_write_admitted: true,
  };
  let operation = { exitCode: 0, stdout: JSON.stringify({ root }), stderr: "" };
  const run: typeof runCommand = async (args) => {
    calls.push(args);
    const value =
      args[0] === "get"
        ? ({ namespace, pvc: claim, pod, node } as Record<string, unknown>)[args[1] ?? ""]
        : args.at(-1) === "worker-status"
          ? status
          : args.at(-1) === "capacity"
            ? capacity
            : null;
    return value ? { exitCode: 0, stdout: JSON.stringify(value), stderr: "" } : operation;
  };
  return {
    namespace,
    claim,
    pod,
    node,
    status,
    capacity,
    calls,
    run,
    result(value: typeof operation) {
      operation = value;
    },
  };
}

test.each(["start", "fork"] as const)(
  "native disk refusal leaves %s undispatched and its mutation-attempt fence untouched",
  async (action) => {
    const f = fixture();
    const identity = await inspectFactoryboxWorker(request, undefined, f.run);
    f.capacity["new_write_admitted"] = false;
    f.result({
      exitCode: 0,
      stdout: JSON.stringify({ record: { version: 1, id: "owned", phase: "running" } }),
      stderr: "",
    });
    let attempted = false;
    await expect(
      executeFactoryboxOperation(
        request,
        identity,
        action === "start"
          ? {
              action: "start",
              sandboxID: "owned",
              bundle: "/var/lib/sysbox/fixed-store/data/store/input/owned/bundle",
            }
          : {
              action: "fork",
              sandboxID: "owned",
              sourceSandboxID: "source",
              snapshotID: "b".repeat(32),
              sourceOwner: "f".repeat(32),
              checkpointSHA256: "a".repeat(64),
            },
        f.run,
        undefined,
        async () => {
          attempted = true;
        },
      ),
    ).rejects.toThrow(`capacity refused ${action === "start" ? "Start" : "Fork"} before dispatch`);
    expect(attempted).toBe(false);
    expect(f.calls.some((args) => args.includes(action))).toBe(false);
  },
);

test.each(["missing decision", "foreign controller", "unavailable"] as const)(
  "unverified %s capacity cannot dispatch a new Start",
  async (scenario) => {
    const f = fixture();
    const identity = await inspectFactoryboxWorker(request, undefined, f.run);
    if (scenario === "missing decision") delete f.capacity["new_write_admitted"];
    if (scenario === "foreign controller") f.capacity["root"] = "/another/controller";
    const run: typeof f.run = async (...args) => {
      if (scenario === "unavailable" && args[0].at(-1) === "capacity")
        return { exitCode: 1, stdout: "", stderr: "Controlled unavailable capacity" };
      return f.run(...args);
    };
    f.result({
      exitCode: 0,
      stdout: JSON.stringify({ record: { version: 1, id: "owned", phase: "running" } }),
      stderr: "",
    });
    let attempted = false;
    await expect(
      executeFactoryboxOperation(
        request,
        identity,
        {
          action: "start",
          sandboxID: "owned",
          bundle: "/var/lib/sysbox/fixed-store/data/store/input/owned/bundle",
        },
        run,
        undefined,
        async () => {
          attempted = true;
        },
      ),
    ).rejects.toThrow("before dispatch");
    expect(attempted).toBe(false);
    expect(f.calls.some((args) => args.includes("start"))).toBe(false);
  },
);

test("retained declaration observation pins immutable original commands while checking the native identity", async () => {
  const f = fixture();
  const base = renderFactoryboxWorker(request);
  const original = {
    namespace: base[0],
    claim: base[1],
    pod: {
      ...base[2],
      spec: {
        ...base[2].spec,
        initContainers: [
          {
            name: "runtime-image",
            image: `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
            command: ["sh", "-ec", "original exporter"],
          },
        ],
      },
    },
  };
  Reflect.set(f.pod.spec, "initContainers", structuredClone(original.pod.spec.initContainers));
  const identity = await inspectFactoryboxWorker(request, undefined, f.run, original);
  const next = structuredClone(original);
  Reflect.set(next.pod.spec.initContainers[0]?.command ?? [], 2, "upgraded exporter");
  await expect(inspectFactoryboxWorker(request, identity, f.run, next)).rejects.toThrow(
    "exact admission",
  );
  const captured = await observeOriginalFactoryboxDeclaration(request, identity, next, f.run);
  expect(captured).toEqual(original);
  expect(await inspectFactoryboxWorker(request, identity, f.run, captured)).toEqual(identity);
  Reflect.set(f.pod.spec.containers[0].resources.limits, "memory", "4Gi");
  await expect(
    observeOriginalFactoryboxDeclaration(request, identity, next, f.run),
  ).rejects.toThrow("exact admission");
  Reflect.set(f.pod.spec.containers[0].resources.limits, "memory", "3Gi");
  Reflect.set(f.pod.spec.containers[0], "image", `registry.invalid/other@sha256:${"f".repeat(64)}`);
  await expect(
    observeOriginalFactoryboxDeclaration(request, identity, next, f.run),
  ).rejects.toThrow("exact admission");
  Reflect.set(f.pod.spec.containers[0], "image", request.image);
  f.pod.metadata.uid = "replacement";
  await expect(
    observeOriginalFactoryboxDeclaration(request, identity, next, f.run),
  ).rejects.toThrow("Original worker UID");
});

test("worker admission preserves the complete private store and finite worker ceilings", () => {
  const resources = renderFactoryboxWorker(request);
  const pod = resources[2];
  expect(pod.spec.containers[0].resources).toEqual({
    requests: { cpu: "3", memory: "3Gi" },
    limits: { cpu: "3", memory: "3Gi" },
  });
  expect(pod.spec.restartPolicy).toBe("Never");
  expect(pod.spec.containers[0].startupProbe.httpGet).toEqual({ path: "/readyz", port: "health" });
  expect(pod.spec.volumes[0]).toEqual({
    name: "store",
    persistentVolumeClaim: { claimName: `store-${request.storeID}` },
  });
  expect(JSON.stringify(resources)).not.toMatch(
    /docker.sock|hostPath|\/lib\/modules|runtime-data|home\/coder|ServiceAccountToken":true|execProbe|livenessProbe/,
  );
  expect(() => factoryboxWorkerRequest.parse({ ...request, claimGiB: 20 })).toThrow();
  expect(() => factoryboxWorkerRequest.parse({ ...request, image: "factorybox:latest" })).toThrow();
  expect(() =>
    factoryboxWorkerRequest.parse({ ...request, canonicalSource: "/project" }),
  ).toThrow();
  expect(() =>
    factoryboxOperation.parse({
      action: "start",
      sandboxID: "owned",
      bundle: "/home/coder/project",
    }),
  ).toThrow();
});

test("automatic storage freezes the admitted native capacity within the declared range", async () => {
  const automatic = factoryboxWorkerRequest.parse({
    ...request,
    boundedBytes: 32 * 1024 ** 3,
    minimumBoundedBytes: 8 * 1024 ** 3,
    claimGiB: 64,
  });
  const f = fixture(automatic);
  expect(f.pod.spec.containers[0].args).toEqual(
    expect.arrayContaining(["--bounded-min-bytes", String(8 * 1024 ** 3)]),
  );
  f.status.lifecycle.bounded_store.image.bytes = 17 * 1024 ** 3;
  Reflect.set(f.status, "bounded_capacity", {
    minimum_bytes: 8 * 1024 ** 3,
    maximum_bytes: 32 * 1024 ** 3,
  });
  const identity = await inspectFactoryboxWorker(automatic, undefined, f.run);
  expect(identity).toMatchObject({ boundedBytes: 17 * 1024 ** 3 });
  expect(await inspectFactoryboxWorker(automatic, identity, f.run)).toEqual(identity);
  f.status.lifecycle.bounded_store.image.bytes = 18 * 1024 ** 3;
  await expect(inspectFactoryboxWorker(automatic, identity, f.run)).rejects.toThrow(
    "identity changed",
  );
});

test("automatic admission refuses unconfirmed ranges and capacities before publishing a worker identity", async () => {
  const automatic = factoryboxWorkerRequest.parse({
    ...request,
    boundedBytes: 32 * 1024 ** 3,
    minimumBoundedBytes: 8 * 1024 ** 3,
    claimGiB: 64,
  });
  for (const selected of [7 * 1024 ** 3, 33 * 1024 ** 3, 17 * 1024 ** 3 + 1]) {
    const f = fixture(automatic);
    Reflect.set(f.status, "bounded_capacity", {
      minimum_bytes: 8 * 1024 ** 3,
      maximum_bytes: 32 * 1024 ** 3,
    });
    f.status.lifecycle.bounded_store.image.bytes = selected;
    await expect(inspectFactoryboxWorker(automatic, undefined, f.run)).rejects.toThrow();
  }
  const unknown = fixture(automatic);
  await expect(inspectFactoryboxWorker(automatic, undefined, unknown.run)).rejects.toThrow();
  Reflect.set(unknown.status, "bounded_capacity", {
    minimum_bytes: 9 * 1024 ** 3,
    maximum_bytes: 32 * 1024 ** 3,
  });
  await expect(inspectFactoryboxWorker(automatic, undefined, unknown.run)).rejects.toThrow();
  for (const minimumBoundedBytes of [0, -1, 33 * 1024 ** 3, 8 * 1024 ** 3 + 1]) {
    expect(() => factoryboxWorkerRequest.parse({ ...automatic, minimumBoundedBytes })).toThrow();
  }
  const fixed = fixture();
  expect(await inspectFactoryboxWorker(request, undefined, fixed.run)).not.toHaveProperty(
    "boundedBytes",
  );
});

test.each([10, 100, 1000, 3000])(
  "worker CPU reservation %im remains separate from its qualified burst ceiling",
  (cpuRequestMilli) => {
    const admitted = factoryboxWorkerRequest.parse({ ...request, cpuRequestMilli });
    const pod = renderFactoryboxWorker(admitted)[2];
    expect(pod.spec.containers[0].resources).toEqual({
      requests: {
        cpu: cpuRequestMilli % 1000 === 0 ? String(cpuRequestMilli / 1000) : `${cpuRequestMilli}m`,
        memory: "3Gi",
      },
      limits: { cpu: "3", memory: "3Gi" },
    });
    expect(admitted.cpuRequestMilli).toBe(cpuRequestMilli);
  },
);

test.each([0, 9, 100.5, 3001, Number.NaN])(
  "worker rejects an invalid CPU reservation %s before rendering",
  (cpuRequestMilli) => {
    expect(() => factoryboxWorkerRequest.parse({ ...request, cpuRequestMilli })).toThrow();
  },
);

test("native state waits for a busy worker without manufacturing a failed Sandbox", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  let observations = 0;
  const run: typeof f.run = async (...args) => {
    if (args[0].includes("state")) {
      observations++;
      if (observations === 1)
        return {
          exitCode: 1,
          stdout: "",
          stderr: "resource temporarily unavailable\ncommand terminated with exit code 1\n",
        };
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ record: { version: 1, id: "owned", phase: "paused" } }),
      };
    }
    return f.run(...args);
  };
  const result = await executeFactoryboxOperation(
    request,
    identity,
    { action: "state", sandboxID: "owned" },
    run,
  );
  expect(result.confirmed).toBe(true);
  expect(observations).toBe(2);
});

test("busy native mutations remain one-shot and retain their unconfirmed outcome", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  f.result({ exitCode: 1, stdout: "", stderr: "resource temporarily unavailable\n" });
  const result = await executeFactoryboxOperation(
    request,
    identity,
    { action: "resume", sandboxID: "owned", snapshotID: "1".repeat(32) },
    f.run,
  );
  expect(result.confirmed).toBe(false);
  expect(f.calls.filter((args) => args.includes("resume"))).toHaveLength(1);
});

test("busy observation cannot follow a replacement worker Pod", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  let observations = 0;
  const run: typeof f.run = async (...args) => {
    if (args[0].includes("state")) {
      observations++;
      f.pod.metadata.uid = "replacement";
      return { exitCode: 1, stdout: "", stderr: "resource temporarily unavailable\n" };
    }
    return f.run(...args);
  };
  await expect(
    executeFactoryboxOperation(request, identity, { action: "state", sandboxID: "owned" }, run),
  ).rejects.toThrow();
  expect(observations).toBe(1);
});

test("Fork pins its source owner and published checkpoint before creating a distinct target", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const snapshotID = "1".repeat(32);
  const sourceOwner = "2".repeat(32);
  const checkpointSHA256 = "3".repeat(64);
  f.result({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      record: {
        version: 1,
        id: "target",
        phase: "running",
        owner: "4".repeat(32),
        runtime_id: `fbx-${"4".repeat(32)}`,
        fork: {
          source_id: "source",
          checkpoint_id: snapshotID,
          checkpoint_sha256: checkpointSHA256,
        },
      },
    }),
  });
  const run: typeof f.run = async (...args) => {
    const result = await f.run(...args);
    if (args[0].includes("state"))
      return {
        ...result,
        stdout: JSON.stringify({
          record: {
            version: 1,
            id: "source",
            phase: "paused",
            owner: sourceOwner,
            pause: {
              snapshot_id: snapshotID,
              checkpoint_sha256: checkpointSHA256,
              completed_at: "now",
            },
          },
        }),
      };
    return result;
  };
  const result = await executeFactoryboxOperation(
    request,
    identity,
    {
      action: "fork",
      sandboxID: "target",
      sourceSandboxID: "source",
      snapshotID,
      sourceOwner,
      checkpointSHA256,
    },
    run,
  );
  expect(result.confirmed).toBe(true);
  const call = f.calls.find((args) => args.includes("fork"));
  expect(call?.slice(-6)).toEqual([
    "fork",
    "--source",
    "source",
    "--snapshot-id",
    snapshotID,
    "target",
  ]);
});

test("Fork refuses a different source owner, hash, unpublished snapshot or canonical Source before target creation", async () => {
  for (const changed of ["owner", "hash", "unpublished", "shared-source"] as const) {
    const f = fixture();
    const identity = await inspectFactoryboxWorker(request, undefined, f.run);
    const sourceOwner = "2".repeat(32);
    const checkpointSHA256 = "3".repeat(64);
    const snapshotID = "1".repeat(32);
    const run: typeof f.run = async (...args) => {
      const result = await f.run(...args);
      if (args[0].includes("state"))
        return {
          ...result,
          stdout: JSON.stringify({
            record: {
              version: 1,
              id: "source",
              phase: "paused",
              owner: changed === "owner" ? "5".repeat(32) : sourceOwner,
              ...(changed === "shared-source" ? { shared_source: { source: "/canonical" } } : {}),
              pause: {
                snapshot_id: snapshotID,
                checkpoint_sha256: changed === "hash" ? "6".repeat(64) : checkpointSHA256,
                ...(changed === "unpublished" ? {} : { completed_at: "now" }),
              },
            },
          }),
        };
      return result;
    };
    await expect(
      executeFactoryboxOperation(
        request,
        identity,
        {
          action: "fork",
          sandboxID: "target",
          sourceSandboxID: "source",
          snapshotID,
          sourceOwner,
          checkpointSHA256,
        },
        run,
      ),
    ).rejects.toThrow("Fork source");
    expect(f.calls.some((args) => args.includes("fork"))).toBe(false);
  }
});

test("Fork never accepts a receipt from another immutable checkpoint", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const sourceOwner = "2".repeat(32),
    checkpointSHA256 = "3".repeat(64),
    snapshotID = "1".repeat(32);
  f.result({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      record: {
        version: 1,
        id: "target",
        phase: "running",
        owner: "4".repeat(32),
        runtime_id: `fbx-${"4".repeat(32)}`,
        fork: { source_id: "source", checkpoint_id: snapshotID, checkpoint_sha256: "5".repeat(64) },
      },
    }),
  });
  const run: typeof f.run = async (...args) => {
    const result = await f.run(...args);
    if (args[0].includes("state"))
      return {
        ...result,
        stdout: JSON.stringify({
          record: {
            version: 1,
            id: "source",
            phase: "paused",
            owner: sourceOwner,
            pause: {
              snapshot_id: snapshotID,
              checkpoint_sha256: checkpointSHA256,
              completed_at: "now",
            },
          },
        }),
      };
    return result;
  };
  await expect(
    executeFactoryboxOperation(
      request,
      identity,
      {
        action: "fork",
        sandboxID: "target",
        sourceSandboxID: "source",
        snapshotID,
        sourceOwner,
        checkpointSHA256,
      },
      run,
    ),
  ).rejects.toThrow("Fork response");
  expect(f.calls.filter((args) => args.includes("fork"))).toHaveLength(1);
});

test("no exec is admitted until exact Kubernetes resources and HTTP readiness agree", async () => {
  const f = fixture();
  f.pod.status.conditions = [{ type: "Ready", status: "False" }];
  await expect(inspectFactoryboxWorker(request, undefined, f.run)).rejects.toThrow("not ready");
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
});

test.each(["retire-checkpoint", "retire-resume"] as const)(
  "%s pins the original worker, Sandbox, owner and complete checkpoint hash",
  async (action) => {
    const f = fixture();
    const identity = await inspectFactoryboxWorker(request, undefined, f.run);
    const checkpoint = {
      source_id: "owned",
      snapshot_id: "a".repeat(32),
      source_owner: "b".repeat(32),
      checkpoint_sha256: "c".repeat(64),
    };
    const operation = {
      action,
      sandboxID: checkpoint.source_id,
      snapshotID: checkpoint.snapshot_id,
      sourceOwner: checkpoint.source_owner,
      checkpointSHA256: checkpoint.checkpoint_sha256,
    };
    const receipt = {
      version: 1,
      ...(action === "retire-resume" ? { payload_kind: "resume-images" } : {}),
      request: checkpoint,
      intent_sha256: "d".repeat(64),
      completed_at: "2026-10-26T12:00:00Z",
      before: { root, filesystem_available_bytes: 1024 },
      after: { root, filesystem_available_bytes: 2048 },
    };
    f.result({ exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) });
    const result = await executeFactoryboxOperation(request, identity, operation, f.run);
    expect(result.confirmed).toBe(true);
    expect(f.calls.at(-1)?.slice(-10)).toEqual([
      "--worker-epoch",
      epoch,
      action,
      "--snapshot-id",
      checkpoint.snapshot_id,
      "--source-owner",
      checkpoint.source_owner,
      "--checkpoint-sha256",
      checkpoint.checkpoint_sha256,
      checkpoint.source_id,
    ]);
    for (const invalid of [
      { ...receipt, request: { ...checkpoint, source_owner: "e".repeat(32) } },
      { ...receipt, request: { ...checkpoint, snapshot_id: "e".repeat(32) } },
      { ...receipt, request: { ...checkpoint, checkpoint_sha256: "e".repeat(64) } },
      { ...receipt, completed_at: "" },
      { ...receipt, after: { ...receipt.after, root: "/another-controller" } },
      { ...receipt, before: { ...receipt.before, filesystem_available_bytes: -1 } },
      { ...receipt, payload_kind: action === "retire-resume" ? undefined : "resume-images" },
    ]) {
      f.result({ exitCode: 0, stderr: "", stdout: JSON.stringify(invalid) });
      await expect(
        executeFactoryboxOperation(request, identity, operation, f.run),
      ).rejects.toThrow();
    }
    const previousCalls = f.calls.length;
    f.result({
      exitCode: 1,
      stderr: "retirement output was lost",
      stdout: JSON.stringify(receipt),
    });
    expect((await executeFactoryboxOperation(request, identity, operation, f.run)).confirmed).toBe(
      false,
    );
    expect(f.calls.slice(previousCalls).filter((args) => args.includes(action))).toHaveLength(1);
  },
);

test.each(["arm64", "amd64"] as const)(
  "%s admission pins the requested architecture and refuses a different node before exec",
  async (architecture) => {
    const input = { ...request, architecture };
    const f = fixture(input);
    expect(f.pod.spec.nodeSelector["kubernetes.io/arch"]).toBe(architecture);
    await inspectFactoryboxWorker(input, undefined, f.run);
    f.calls.length = 0;
    f.node.status.nodeInfo.architecture = architecture === "arm64" ? "amd64" : "arm64";
    await expect(inspectFactoryboxWorker(input, undefined, f.run)).rejects.toThrow();
    expect(f.calls.every((args) => args[0] === "get")).toBe(true);
  },
);

test("private backing retirement requires exact deleted owner, input and worker receipt", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const operation = {
    action: "retire-sandbox",
    sandboxID: "owned",
    sandboxOwner: "a".repeat(32),
    inputSHA256: "b".repeat(64),
  } as const;
  const receipt = {
    version: 1,
    payload_kind: "sandbox-backing",
    request: {
      sandbox_id: "owned",
      sandbox_owner: operation.sandboxOwner,
      input_sha256: operation.inputSHA256,
    },
    intent_sha256: "c".repeat(64),
    completed_at: "2026-10-26T12:00:00Z",
    before: { root, filesystem_available_bytes: 1024 },
    after: { root, filesystem_available_bytes: 2048 },
  };
  f.result({ exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) });
  expect((await executeFactoryboxOperation(request, identity, operation, f.run)).confirmed).toBe(
    true,
  );
  expect(f.calls.at(-1)?.slice(-6)).toEqual([
    "retire-sandbox",
    "--sandbox-owner",
    operation.sandboxOwner,
    "--input-sha256",
    operation.inputSHA256,
    "owned",
  ]);
  for (const invalid of [
    { ...receipt, payload_kind: "resume-images" },
    { ...receipt, request: { ...receipt.request, sandbox_id: "foreign" } },
    { ...receipt, request: { ...receipt.request, sandbox_owner: "d".repeat(32) } },
    { ...receipt, request: { ...receipt.request, input_sha256: "d".repeat(64) } },
    { ...receipt, completed_at: "" },
    { ...receipt, after: { ...receipt.after, root: "/foreign" } },
  ]) {
    f.result({ exitCode: 0, stderr: "", stdout: JSON.stringify(invalid) });
    await expect(executeFactoryboxOperation(request, identity, operation, f.run)).rejects.toThrow();
  }
});

test("worker architecture is explicit and rejects unsupported or inferred targets", () => {
  expect(() => factoryboxWorkerRequest.parse({ ...request, architecture: undefined })).toThrow();
  expect(() => factoryboxWorkerRequest.parse({ ...request, architecture: "riscv64" })).toThrow();
});

test("real status must bind the supervisor, bounded filesystem, boot and epoch", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.status.store_id = "f".repeat(32);
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.supervisor_sha256 = "f".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.lifecycle.root = "/other/controller";
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.lifecycle.bounded_store.direct_io = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.status.boot_id = "";
    },
    (f: ReturnType<typeof fixture>) => {
      f.node.status.nodeInfo.kernelVersion = "unqualified";
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.spec.containers[0], "image", "changed");
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.spec.containers[0].resources.limits, "memory", "8Gi");
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.spec, "initContainers", [{ name: "foreign" }]);
    },
    (f: ReturnType<typeof fixture>) => {
      Reflect.set(f.pod.metadata, "deletionTimestamp", "now");
    },
    (f: ReturnType<typeof fixture>) => {
      f.namespace.metadata.labels["factory.dev/trust-domain"] = "other";
    },
  ]) {
    const f = fixture();
    change(f);
    await expect(inspectFactoryboxWorker(request, undefined, f.run)).rejects.toThrow();
  }
});

test("node-reported and kernel-reported boot identities are independently pinned, never equated", async () => {
  const f = fixture();
  f.node.status.nodeInfo.bootID = "kubelet-boot";
  f.status.boot_id = "worker-kernel-boot";
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  expect(identity.nodeBootID).toBe("kubelet-boot");
  expect(identity.bootID).toBe("worker-kernel-boot");
  await inspectFactoryboxWorker(request, identity, f.run);
  f.node.status.nodeInfo.bootID = "replacement-node-boot";
  f.calls.length = 0;
  await expect(inspectFactoryboxWorker(request, identity, f.run)).rejects.toThrow(
    "boot identity changed",
  );
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
  f.node.status.nodeInfo.bootID = "kubelet-boot";
  f.status.boot_id = "replacement-worker-boot";
  await expect(inspectFactoryboxWorker(request, identity, f.run)).rejects.toThrow(
    "live identity changed",
  );
});
test("UID or epoch replacement refuses a delayed operation without issuing it", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  f.calls.length = 0;
  f.pod.metadata.uid = "replacement";
  await expect(
    executeFactoryboxOperation(request, identity, { action: "capacity" }, f.run),
  ).rejects.toThrow("UID changed");
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
  f.pod.metadata.uid = identity.podUID;
  f.status.epoch = "f".repeat(32);
  f.status.lifecycle.root = root.replace(epoch, f.status.epoch);
  await expect(
    executeFactoryboxOperation(request, identity, { action: "capacity" }, f.run),
  ).rejects.toThrow("live identity changed");
  expect(
    f.calls.filter((args) => args[0] === "exec").every((args) => args.at(-1) === "worker-status"),
  ).toBe(true);
});

test("every mutation pins its store/epoch inside the executed CLI and never retries a partial failure", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const snapshotID = "1".repeat(32);
  f.result({
    exitCode: 1,
    stdout: JSON.stringify({ record: { id: "owned", phase: "pausing" } }),
    stderr: "unconfirmed",
  });
  const result = await executeFactoryboxOperation(
    request,
    identity,
    { action: "pause", sandboxID: "owned", snapshotID },
    f.run,
  );
  expect(result.confirmed).toBe(false);
  const mutation = f.calls.filter((args) => args.includes("--worker-epoch"));
  expect(mutation).toHaveLength(1);
  expect(mutation[0]).toEqual([
    "exec",
    "worker",
    "-n",
    request.namespace,
    "-c",
    "worker",
    "--",
    "/opt/factorybox/factorybox",
    "--worker-run-root",
    "/run/factorybox",
    "--worker-store-id",
    request.storeID,
    "--worker-epoch",
    epoch,
    "pause",
    "--snapshot-id",
    snapshotID,
    "owned",
  ]);
});

test("zero exit alone cannot confirm an unrelated pause or incomplete resume", async () => {
  const f = fixture();
  const identity = await inspectFactoryboxWorker(request, undefined, f.run);
  const snapshotID = "1".repeat(32);
  f.result({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      record: {
        version: 1,
        id: "owned",
        phase: "paused",
        pause: { snapshot_id: "2".repeat(32), completed_at: "now" },
      },
    }),
  });
  await expect(
    executeFactoryboxOperation(
      request,
      identity,
      { action: "pause", sandboxID: "owned", snapshotID },
      f.run,
    ),
  ).rejects.toThrow("exact pause/resume");
  f.result({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      record: {
        version: 1,
        id: "owned",
        phase: "running",
        pause: { snapshot_id: snapshotID, completed_at: "now", resume: {} },
      },
    }),
  });
  await expect(
    executeFactoryboxOperation(
      request,
      identity,
      { action: "resume", sandboxID: "owned", snapshotID },
      f.run,
    ),
  ).rejects.toThrow("exact pause/resume");
});
