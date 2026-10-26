import { expect, test } from "bun:test";
import {
  configuredFactoryboxRuntimeProfile,
  deleteFactoryboxStore,
  type FactoryboxRuntimeInput,
  factoryboxOriginalWorkerRetired,
  factoryboxPreparationRequest,
  factoryboxPreparationAssignment,
  renderFactoryboxRuntime,
} from "./factorybox-runtime";
import type { runFactoryboxKubernetes } from "./factorybox-worker";

const input: FactoryboxRuntimeInput = {
  attemptID: "01234567-89ab-5def-8123-456789abcdef",
  sandboxID: "runtime-0123456789ab5def8123456789abcdef",
  runtimeOwnerID: "11234567-89ab-5def-8123-456789abcdef",
  namespace: "factory-test",
  podName: "runtime-1",
  labels: { "factory.dev/runtime-attempt": "01234567-89ab-5def-8123-456789abcdef" },
  runtimeHostImage: `registry.example/runtime@sha256:${"a".repeat(64)}`,
  sharedSource: true,
  profile: {
    image: `registry.example/worker@sha256:${"b".repeat(64)}`,
    executableSHA256: "c".repeat(64),
    architecture: "amd64",
    nodeName: "source-node",
    kernel: "6.12.0",
    boundedBytes: 8589934592,
    claimGiB: 32,
  },
};

function assignmentFiles(execution = input): Readonly<Record<string, string>> {
  return execution.reserve
    ? {
        "slot.json": JSON.stringify({
          version: 1,
          id: execution.labels["factory.dev/execution-slot"],
        }),
      }
    : {
        "assignment.json": JSON.stringify({
          version: 1,
          runtimeAttemptId: execution.attemptID,
          generation: 1,
        }),
        "parent-token": "parent-private",
        "child-token": "child-private",
      };
}

test("shared workers receive only the selected Sandbox assignment, never an ambient Secret mount", () => {
  const identity = {
    version: 1 as const,
    namespaceUID: "namespace",
    claimUID: "claim",
    podUID: "pod",
    storeID: input.attemptID.replaceAll("-", ""),
    epoch: "e".repeat(32),
    bootID: "boot",
    executableSHA256: input.profile.executableSHA256,
    controllerRoot: "/controller",
  };
  const assignment = assignmentFiles();
  const request = factoryboxPreparationRequest(input, identity, assignment);
  expect(request.version).toBe(3);
  expect(request.assignment).toEqual(assignment);
  expect(request.sourceWorkspaceID).toBe(input.runtimeOwnerID!.replaceAll("-", ""));
  const pod = renderFactoryboxRuntime(input).pod;
  expect(pod.spec.volumes.some((volume) => volume.name === "assignment")).toBe(false);
  expect(pod.spec.containers[0]!.volumeMounts.some((mount) => mount.name === "assignment")).toBe(
    false,
  );
  expect(JSON.stringify(pod)).not.toContain("parent-private");
  expect(JSON.stringify(input)).not.toContain("parent-private");
});

test("assignment reads reject another owner and keep assigned credentials out of a reserve seed", () => {
  const files = assignmentFiles();
  const secret = {
    metadata: {
      labels: {
        "app.kubernetes.io/managed-by": "open-software-factory",
        "factory.dev/runtime-owner": input.runtimeOwnerID,
        "factory.dev/runtime-attempt": input.attemptID,
      },
    },
    data: Object.fromEntries(
      Object.entries(files).map(([name, value]) => [name, Buffer.from(value).toString("base64")]),
    ),
  };
  expect(factoryboxPreparationAssignment(input, secret)).toEqual(files);
  for (const field of ["factory.dev/runtime-owner", "factory.dev/runtime-attempt"])
    expect(() =>
      factoryboxPreparationAssignment(input, {
        ...secret,
        metadata: { labels: { ...secret.metadata.labels, [field]: "foreign" } },
      }),
    ).toThrow("another immutable execution owner");
  const reserved = {
    ...input,
    reserve: true,
    sharedSource: false,
    labels: { ...input.labels, "factory.dev/execution-slot": input.attemptID },
  };
  const slot = assignmentFiles(reserved);
  const seed = factoryboxPreparationAssignment(reserved, {
    ...secret,
    metadata: {
      labels: { ...secret.metadata.labels, "factory.dev/execution-slot": input.attemptID },
    },
    data: {
      ...secret.data,
      "slot.json": Buffer.from(slot["slot.json"]!).toString("base64"),
    },
  });
  expect(seed).toEqual(slot);
  expect(JSON.stringify(seed)).not.toContain("parent-private");
  expect(JSON.stringify(seed)).not.toContain("child-private");
});

test("two executions on one worker retain distinct Sandbox and preparation identities", () => {
  const workerID = "a".repeat(32);
  const identity = {
    version: 1 as const,
    namespaceUID: "namespace",
    claimUID: "claim",
    podUID: "pod",
    storeID: workerID,
    epoch: "e".repeat(32),
    bootID: "boot",
    executableSHA256: input.profile.executableSHA256,
    controllerRoot: "/controller",
  };
  const first = factoryboxPreparationRequest({ ...input, workerID }, identity, assignmentFiles());
  const sibling = {
    ...input,
    workerID,
    runtimeOwnerID: "31234567-89ab-5def-8123-456789abcdef",
    attemptID: "21234567-89ab-5def-8123-456789abcdef",
    sandboxID: "runtime-2123456789ab5def8123456789abcdef",
  };
  const second = factoryboxPreparationRequest(sibling, identity, assignmentFiles(sibling));
  expect(first.version).toBe(3);
  expect(first.sandboxID).toBe("runtime-0123456789ab5def8123456789abcdef");
  expect(second.sandboxID).toBe("runtime-2123456789ab5def8123456789abcdef");
  expect(second.storeID).toBe(first.storeID);
  expect(second.sourceWorkspaceID).not.toBe(first.sourceWorkspaceID);
  expect(second.assignment["assignment.json"]).not.toBe(first.assignment["assignment.json"]);
});

test("missing, changed and another execution's Sandbox identities fail before worker effects", () => {
  for (const sandboxID of [undefined, "runtime", "runtime-" + "a".repeat(32)]) {
    expect(() =>
      renderFactoryboxRuntime({ ...input, sandboxID } as FactoryboxRuntimeInput),
    ).toThrow("Sandbox identity");
  }
});

test("assigning a never-used reserve keeps its original Sandbox independently of the worker ID", () => {
  const slotID = "31234567-89ab-5def-8123-456789abcdef";
  const workerID = "a".repeat(32);
  const reserved = {
    ...input,
    attemptID: slotID,
    sandboxID: `runtime-${slotID.replaceAll("-", "")}`,
    workerID,
    reserve: true,
    sharedSource: false,
    labels: { ...input.labels, "factory.dev/execution-slot": slotID },
  };
  const identity = {
    version: 1 as const,
    namespaceUID: "namespace",
    claimUID: "claim",
    podUID: "pod",
    storeID: workerID,
    epoch: "e".repeat(32),
    bootID: "boot",
    executableSHA256: input.profile.executableSHA256,
    controllerRoot: "/controller",
  };
  const before = factoryboxPreparationRequest(reserved, identity, assignmentFiles(reserved));
  const after = factoryboxPreparationRequest(
    { ...reserved, attemptID: input.attemptID },
    identity,
    assignmentFiles(reserved),
  );
  expect(after).toEqual(before);
  expect(after.sandboxID).not.toContain(workerID);
});

test("registry trust follows the qualified exact runtime image, including private ports", () => {
  for (const authority of ["ghcr.io", "registry.portable.svc:5000"]) {
    const request = {
      ...input,
      runtimeHostImage: `${authority}/factory/runtime@sha256:${"a".repeat(64)}`,
    };
    const rendered = renderFactoryboxRuntime(request);
    expect(rendered.pod.spec.initContainers[0]?.image).toBe(request.runtimeHostImage);
    expect(rendered.pod.spec.containers[0]?.volumeMounts).toContainEqual({
      name: "registry-ca",
      mountPath: "/factory/registry-ca",
      readOnly: true,
    });
    expect(JSON.stringify(rendered)).not.toContain("envbox");
  }
});

test("runtime image names cannot inject commands or traverse certificate directories", () => {
  for (const image of [
    "registry;id/factory",
    "registry$(id)/factory",
    "../factory",
    "/factory",
    "unqualified-image",
    `registry.example/../runtime@sha256:${"a".repeat(64)}`,
  ])
    expect(() => renderFactoryboxRuntime({ ...input, runtimeHostImage: image })).toThrow();
});

test.each(["arm64", "amd64"] as const)(
  "%s runtime preparation uses its admitted profile rather than the control-plane architecture",
  (architecture) => {
    const profile = configuredFactoryboxRuntimeProfile({
      FACTORY_FACTORYBOX_WORKER_IMAGE: input.profile.image,
      FACTORY_FACTORYBOX_EXECUTABLE_SHA256: input.profile.executableSHA256,
      FACTORY_FACTORYBOX_ARCHITECTURE: architecture,
      FACTORY_FACTORYBOX_NODE: input.profile.nodeName,
      FACTORY_FACTORYBOX_KERNEL: input.profile.kernel,
    });
    const rendered = renderFactoryboxRuntime({ ...input, profile });
    expect(rendered.pod.spec.nodeSelector["kubernetes.io/arch"]).toBe(architecture);
    expect(rendered.pod.spec.initContainers[0]!.image).toBe(input.runtimeHostImage);
    expect(profile.architecture).toBe(architecture);
  },
);

for (const scenario of [
  "running",
  "failed",
  "missing",
  "restarted",
  "foreign-pod",
  "foreign-namespace",
  "unavailable",
] as const) {
  test(`explicit Stop observes original worker retirement: ${scenario}`, async () => {
    const seen: Array<readonly string[]> = [];
    const identity = {
      version: 1 as const,
      namespaceUID: "namespace-uid",
      podUID: "pod-uid",
      claimUID: "claim-uid",
      storeID: input.attemptID.replaceAll("-", ""),
      epoch: "e".repeat(32),
      bootID: "boot",
      executableSHA256: input.profile.executableSHA256,
      controllerRoot: "/controller",
    };
    const run: typeof runFactoryboxKubernetes = async (args) => {
      seen.push(args);
      if (scenario === "unavailable")
        return { exitCode: 1, stdout: "", stderr: "kubeconfig file not found" };
      if (args[1] === "namespace")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            metadata: { uid: scenario === "foreign-namespace" ? "foreign" : "namespace-uid" },
          }),
        };
      if (scenario === "missing")
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Error from server (NotFound): owned worker not found",
        };
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          metadata: { uid: scenario === "foreign-pod" ? "foreign" : "pod-uid" },
          status: {
            phase: scenario === "failed" ? "Failed" : "Running",
            containerStatuses: [{ name: "worker", restartCount: scenario === "restarted" ? 1 : 0 }],
          },
        }),
      };
    };
    if (["foreign-pod", "foreign-namespace", "unavailable"].includes(scenario))
      await expect(factoryboxOriginalWorkerRetired(input, identity, run)).rejects.toThrow();
    else
      expect(await factoryboxOriginalWorkerRetired(input, identity, run)).toBe(
        scenario !== "running",
      );
    expect(seen.every((args) => args[0] === "get")).toBe(true);
  });
}

test("consumer image exports before PID 1 starts, with source and credentials confined to the worker", () => {
  const { pod, claim } = renderFactoryboxRuntime(input);
  expect(pod.spec.restartPolicy).toBe("Never");
  expect(pod.spec.hostNetwork).toBe(false);
  expect(pod.spec.automountServiceAccountToken).toBe(false);
  expect(pod.spec.containers[0]!.resources.limits).toEqual({ cpu: "3", memory: "3Gi" });
  expect(pod.spec.initContainers[0]!.image).toBe(input.runtimeHostImage);
  expect(pod.spec.initContainers[0]!.volumeMounts).toEqual([
    { name: "store", mountPath: "/factory-seed", subPath: "seed" },
  ]);
  expect(pod.spec.containers[0]!.volumeMounts).toContainEqual({
    name: "runtime-data",
    mountPath: "/factory-source",
  });
  expect(JSON.stringify(pod)).not.toContain("docker.sock");
  expect(JSON.stringify(pod)).not.toContain("CODER_INNER_IMAGE");
  expect(claim.spec.resources.requests.storage).toBe("32Gi");
  expect(claim.metadata.name).toBe("store-0123456789ab5def8123456789abcdef");
});

test("isolated execution has no shared source bind and wrong source placement fails before create", () => {
  expect(JSON.stringify(renderFactoryboxRuntime({ ...input, sharedSource: false }))).not.toContain(
    "/factory-source",
  );
  expect(() => renderFactoryboxRuntime({ ...input, storageNode: "different-node" })).toThrow(
    "same node",
  );
});

test("preparation rejects another admitted worker before returning any mutation request", () => {
  expect(() =>
    factoryboxPreparationRequest(
      input,
      {
        version: 1,
        namespaceUID: "namespace",
        claimUID: "claim",
        podUID: "pod",
        storeID: "d".repeat(32),
        epoch: "e".repeat(32),
        bootID: "boot",
        executableSHA256: input.profile.executableSHA256,
        controllerRoot: "/controller",
      },
      assignmentFiles(),
    ),
  ).toThrow("admitted worker");
});

test("store cleanup requires a gone worker, exact ownership and a UID precondition", async () => {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const storeID = "a".repeat(32);
  let removed = false;
  const run: typeof runFactoryboxKubernetes = async (args, body) => {
    calls.push({ args, ...(body === undefined ? {} : { input: body }) });
    if (args[0] === "delete") {
      removed = true;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    }
    if (args[1] === "namespace")
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ metadata: { uid: "namespace-uid" } }),
      };
    if (args[1] === "pod" || removed)
      return {
        exitCode: 1,
        stderr: "Error from server (NotFound): owned object not found",
        stdout: "",
      };
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        metadata: {
          uid: "claim-uid",
          labels: {
            "app.kubernetes.io/managed-by": "open-software-factory",
            "factory.dev/factorybox-store": storeID,
            "factory.dev/runtime-attempt": input.attemptID,
          },
        },
      }),
    };
  };
  await deleteFactoryboxStore(
    {
      namespace: input.namespace,
      namespaceUID: "namespace-uid",
      podName: input.podName,
      attemptID: input.attemptID,
      storeID,
      claimUID: "claim-uid",
    },
    run,
  );
  const deletes = calls.filter(({ args }) => args[0] === "delete");
  expect(deletes).toHaveLength(1);
  expect(deletes[0]?.args).toContain(
    `/api/v1/namespaces/${input.namespace}/persistentvolumeclaims/store-${storeID}`,
  );
  expect(JSON.parse(deletes[0]?.input ?? "{}").preconditions).toEqual({ uid: "claim-uid" });
  expect(JSON.stringify(calls)).not.toContain("runtime-data");
});

test.each(["foreign-namespace", "live-worker", "missing-kubeconfig"])(
  "store cleanup refuses %s without mutation",
  async (kind) => {
    let deletes = 0;
    const run: typeof runFactoryboxKubernetes = async (args) => {
      if (args[0] === "delete") deletes++;
      if (kind === "missing-kubeconfig")
        return { exitCode: 1, stdout: "", stderr: "Kubeconfig file not found" };
      if (args[1] === "namespace")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            metadata: { uid: kind === "foreign-namespace" ? "foreign" : "namespace-uid" },
          }),
        };
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ metadata: { uid: "live-worker" } }),
      };
    };
    await expect(
      deleteFactoryboxStore(
        {
          namespace: input.namespace,
          namespaceUID: "namespace-uid",
          podName: input.podName,
          attemptID: input.attemptID,
          storeID: "a".repeat(32),
        },
        run,
      ),
    ).rejects.toThrow();
    expect(deletes).toBe(0);
  },
);
