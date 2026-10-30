import { expect, test } from "bun:test";
import { fixtureValue } from "../../../test/fixtures/value";
import { factoryboxLocation } from "./factorybox-location";
import {
  configuredFactoryboxRuntimeProfile,
  type FactoryboxRuntimeInput,
  factoryboxBootstrapProgram,
  factoryboxOriginalWorkerRetired,
  factoryboxPreparationAssignment,
  factoryboxPreparationRequest,
  factoryboxReserveBootstrapProgram,
  factoryboxRuntimeRequest,
  prepareFactoryboxRuntime,
  renderFactoryboxRuntime,
} from "./factorybox-runtime";
import type { runFactoryboxKubernetes } from "./factorybox-worker";

const input: FactoryboxRuntimeInput = {
  attemptID: "01234567-89ab-5def-8123-456789abcdef",
  sandboxID: "runtime-0123456789ab5def8123456789abcdef",
  runtimeOwnerID: "11234567-89ab-5def-8123-456789abcdef",
  ...factoryboxLocation("01234567-89ab-5def-8123-456789abcdef"),
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

test.each([
  ["assigned", factoryboxBootstrapProgram],
  ["reserve", factoryboxReserveBootstrapProgram],
] as const)("%s execution selects the qualified private Docker storage driver", (_kind, script) => {
  const daemons = script
    .split("\n")
    .filter((line) => /^dockerd\s/.test(line))
    .map((line) => line.split(/\s+/));
  expect(daemons).toHaveLength(1);
  expect(daemons[0]).toContain("--storage-driver=overlay2");
  expect(daemons[0]).toContain("--host=unix:///var/run/docker.sock");
  expect(script).not.toContain("dockerd-entrypoint");
});

test("a successor uses its new native store and Pod but retains the canonical Source trust domain", () => {
  const admissionID = "17164fe7-7c86-451e-ae6e-0b0fe6b8bf5e";
  const successor = {
    ...input,
    ...factoryboxLocation(input.workerID, admissionID),
    profile: { ...input.profile, storageAdmission: 1 as const },
  };
  const request = factoryboxRuntimeRequest(successor);
  expect(request.storeID).toBe(admissionID.replaceAll("-", ""));
  expect(request.trustDomainID).toBe(input.workerID.replaceAll("-", ""));
  expect(request).not.toHaveProperty("storageAdmission");
  const rendered = renderFactoryboxRuntime(successor);
  expect(rendered.namespace.metadata).toEqual(renderFactoryboxRuntime(input).namespace.metadata);
  expect(rendered.sourceClaim).toEqual(renderFactoryboxRuntime(input).sourceClaim);
  expect(rendered.pod.metadata.name).toBe(request.podName);
  expect(rendered.claim.metadata.name).toBe(`store-${request.storeID}`);
  expect(() =>
    factoryboxRuntimeRequest({
      ...successor,
      podName: `worker-${input.workerID.replaceAll("-", "")}`,
    }),
  ).toThrow("original Pod name");
});

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
    nodeBootID: "node-boot",
    executableSHA256: input.profile.executableSHA256,
    controllerRoot: "/controller",
  };
  const assignment = assignmentFiles();
  const request = factoryboxPreparationRequest(input, identity, assignment);
  expect(request.version).toBe(3);
  expect(request.assignment).toEqual(assignment);
  expect(request.sourceWorkspaceID).toBe(input.runtimeOwnerID.replaceAll("-", ""));
  const pod = renderFactoryboxRuntime(input).pod;
  expect(pod.spec.volumes.some((volume) => volume.name === "assignment")).toBe(false);
  expect(
    fixtureValue(pod.spec.containers[0], "pod.spec.containers[0]").volumeMounts.some(
      (mount) => mount.name === "assignment",
    ),
  ).toBe(false);
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
      "slot.json": Buffer.from(fixtureValue(slot["slot.json"], 'slot["slot.json"]')).toString(
        "base64",
      ),
    },
  });
  expect(seed).toEqual(slot);
  expect(JSON.stringify(seed)).not.toContain("parent-private");
  expect(JSON.stringify(seed)).not.toContain("child-private");
});

test("two executions on one worker retain distinct Sandbox and preparation identities", () => {
  const workerID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const identity = {
    version: 1 as const,
    namespaceUID: "namespace",
    claimUID: "claim",
    podUID: "pod",
    storeID: workerID.replaceAll("-", ""),
    epoch: "e".repeat(32),
    bootID: "boot",
    nodeBootID: "node-boot",
    executableSHA256: input.profile.executableSHA256,
    controllerRoot: "/controller",
  };
  const first = factoryboxPreparationRequest(
    { ...input, ...factoryboxLocation(workerID) },
    identity,
    assignmentFiles(),
  );
  const sibling = {
    ...input,
    ...factoryboxLocation(workerID),
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
  for (const sandboxID of [undefined, "runtime", `runtime-${"a".repeat(32)}`]) {
    expect(() =>
      renderFactoryboxRuntime({ ...input, sandboxID } as FactoryboxRuntimeInput),
    ).toThrow("Sandbox identity");
  }
});

test("reserve preparation rejects a missing assignment identity before observing any worker", async () => {
  let commands = 0;
  await expect(
    prepareFactoryboxRuntime(
      { ...input, reserve: true },
      {
        version: 1,
        namespaceUID: "namespace",
        claimUID: "claim",
        podUID: "pod",
        storeID: input.attemptID.replaceAll("-", ""),
        epoch: "e".repeat(32),
        bootID: "boot",
        nodeBootID: "node-boot",
        executableSHA256: input.profile.executableSHA256,
        controllerRoot: "/controller",
      },
      async () => {
        commands++;
        throw new Error("Missing assignment must not reach Kubernetes");
      },
    ),
  ).rejects.toThrow("Sandbox assignment identity is missing");
  expect(commands).toBe(0);
});

test("assigning a never-used reserve keeps its original Sandbox independently of the worker ID", () => {
  const slotID = "31234567-89ab-5def-8123-456789abcdef";
  const workerID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reserved = {
    ...input,
    attemptID: slotID,
    sandboxID: `runtime-${slotID.replaceAll("-", "")}`,
    ...factoryboxLocation(workerID),
    reserve: true,
    sharedSource: false,
    labels: { ...input.labels, "factory.dev/execution-slot": slotID },
  };
  const identity = {
    version: 1 as const,
    namespaceUID: "namespace",
    claimUID: "claim",
    podUID: "pod",
    storeID: workerID.replaceAll("-", ""),
    epoch: "e".repeat(32),
    bootID: "boot",
    nodeBootID: "node-boot",
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
    expect(
      rendered.pod.spec.initContainers.find((container) => container.name === "runtime-image")
        ?.image,
    ).toBe(request.runtimeHostImage);
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
    expect(
      rendered.pod.spec.initContainers.find((container) => container.name === "runtime-image")
        ?.image,
    ).toBe(input.runtimeHostImage);
    expect(profile.architecture).toBe(architecture);
  },
);

test.each(["arm64", "amd64"] as const)(
  "fresh %s workers share available CPU instead of reserving their entire burst ceiling",
  (architecture) => {
    const profile = configuredFactoryboxRuntimeProfile({
      FACTORY_FACTORYBOX_WORKER_IMAGE: input.profile.image,
      FACTORY_FACTORYBOX_EXECUTABLE_SHA256: input.profile.executableSHA256,
      FACTORY_FACTORYBOX_ARCHITECTURE: architecture,
      FACTORY_FACTORYBOX_NODE: input.profile.nodeName,
      FACTORY_FACTORYBOX_KERNEL: input.profile.kernel,
    });
    const { pod } = renderFactoryboxRuntime({ ...input, profile });
    expect(fixtureValue(pod.spec.containers[0], "worker").resources).toEqual({
      requests: { cpu: "100m", memory: "3Gi" },
      limits: { cpu: "3", memory: "3Gi" },
    });
    for (const container of pod.spec.initContainers)
      expect(container.resources.requests.cpu).toBe("100m");
  },
);

test("the admitted CPU reservation also bounds init-container scheduling without changing old profiles", () => {
  const profile = { ...input.profile, cpuRequestMilli: 10 };
  const fresh = renderFactoryboxRuntime({ ...input, profile });
  expect(fixtureValue(fresh.pod.spec.containers[0], "fresh worker").resources.requests.cpu).toBe(
    "10m",
  );
  expect(
    fresh.pod.spec.initContainers.map((container) => container.resources.requests.cpu),
  ).toEqual(["10m", "10m"]);
  expect(fresh.pod.spec.initContainers.map((container) => container.resources.limits.cpu)).toEqual([
    "250m",
    "1",
  ]);
  const retained = renderFactoryboxRuntime(input);
  expect(
    fixtureValue(retained.pod.spec.containers[0], "retained worker").resources.requests.cpu,
  ).toBe("3");
  expect(
    retained.pod.spec.initContainers.map((container) => container.resources.requests.cpu),
  ).toEqual(["250m", "1"]);
});

test.each([
  { storeGiB: 8, claimGiB: 32 },
  { storeGiB: 24, claimGiB: 48 },
  { storeGiB: 32, claimGiB: 64 },
])("operator storage profile retains $storeGiB GiB within its $claimGiB GiB claim", (capacity) => {
  const profile = configuredFactoryboxRuntimeProfile({
    FACTORY_FACTORYBOX_WORKER_IMAGE: input.profile.image,
    FACTORY_FACTORYBOX_EXECUTABLE_SHA256: input.profile.executableSHA256,
    FACTORY_FACTORYBOX_ARCHITECTURE: input.profile.architecture,
    FACTORY_FACTORYBOX_NODE: input.profile.nodeName,
    FACTORY_FACTORYBOX_KERNEL: input.profile.kernel,
    FACTORY_FACTORYBOX_BOUNDED_BYTES: String(capacity.storeGiB * 1024 ** 3),
    FACTORY_FACTORYBOX_CLAIM_GIB: String(capacity.claimGiB),
  });
  expect(profile.boundedBytes).toBe(capacity.storeGiB * 1024 ** 3);
  expect(profile.claimGiB).toBe(capacity.claimGiB);
  const rendered = renderFactoryboxRuntime({ ...input, profile });
  expect(rendered.claim.spec.resources.requests.storage).toBe(`${capacity.claimGiB}Gi`);
  const worker = fixtureValue(rendered.pod.spec.containers[0], "worker");
  expect(worker.args).toContain(String(capacity.storeGiB * 1024 ** 3));
  expect(worker.resources).toEqual({
    requests: { cpu: "100m", memory: "3Gi" },
    limits: { cpu: "3", memory: "3Gi" },
  });
});

test.each([
  { bytes: String(7 * 1024 ** 3), claim: "32" },
  { bytes: String(33 * 1024 ** 3), claim: "64" },
  { bytes: String(8 * 1024 ** 3 + 1), claim: "32" },
  { bytes: String(24 * 1024 ** 3), claim: "40" },
  { bytes: String(8 * 1024 ** 3), claim: "32.5" },
  { bytes: "not-a-capacity", claim: "32" },
])("operator storage profile rejects an unadmitted capacity $bytes/$claim", (capacity) => {
  expect(() =>
    configuredFactoryboxRuntimeProfile({
      FACTORY_FACTORYBOX_WORKER_IMAGE: input.profile.image,
      FACTORY_FACTORYBOX_EXECUTABLE_SHA256: input.profile.executableSHA256,
      FACTORY_FACTORYBOX_ARCHITECTURE: input.profile.architecture,
      FACTORY_FACTORYBOX_NODE: input.profile.nodeName,
      FACTORY_FACTORYBOX_KERNEL: input.profile.kernel,
      FACTORY_FACTORYBOX_BOUNDED_BYTES: capacity.bytes,
      FACTORY_FACTORYBOX_CLAIM_GIB: capacity.claim,
    }),
  ).toThrow();
});

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
      nodeBootID: "node-boot",
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
  expect(fixtureValue(pod.spec.containers[0], "pod.spec.containers[0]").resources.limits).toEqual({
    cpu: "3",
    memory: "3Gi",
  });
  expect(pod.spec.initContainers.map((container) => container.name)).toEqual([
    "store-initialize",
    "runtime-image",
  ]);
  expect(fixtureValue(pod.spec.initContainers[0], "pod.spec.initContainers[0]").image).toBe(
    input.profile.image,
  );
  expect(
    fixtureValue(pod.spec.initContainers[0], "pod.spec.initContainers[0]").volumeMounts,
  ).toEqual([{ name: "store", mountPath: "/factory-store" }]);
  expect(
    fixtureValue(pod.spec.initContainers[0], "pod.spec.initContainers[0]").securityContext
      .capabilities.drop,
  ).toEqual(["ALL"]);
  expect(
    pod.spec.initContainers.find((container) => container.name === "runtime-image")?.image,
  ).toBe(input.runtimeHostImage);
  expect(
    pod.spec.initContainers.find((container) => container.name === "runtime-image")?.volumeMounts,
  ).toEqual([{ name: "store", mountPath: "/factory-seed", subPath: "seed" }]);
  expect(
    fixtureValue(pod.spec.containers[0], "pod.spec.containers[0]").volumeMounts,
  ).toContainEqual({
    name: "runtime-data",
    mountPath: "/factory-source",
  });
  expect(JSON.stringify(pod)).not.toContain("docker.sock");
  expect(JSON.stringify(pod)).not.toContain("CODER_INNER_IMAGE");
  expect(claim.spec.resources.requests.storage).toBe("32Gi");
  expect(claim.metadata.name).toBe("store-0123456789ab5def8123456789abcdef");
});

test("the shared worker retains canonical Source while isolated Sandbox preparation has no Source bind", () => {
  expect(JSON.stringify(renderFactoryboxRuntime({ ...input, sharedSource: false }))).toContain(
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
        nodeBootID: "node-boot",
        executableSHA256: input.profile.executableSHA256,
        controllerRoot: "/controller",
      },
      assignmentFiles(),
    ),
  ).toThrow("admitted worker");
});
