import { expect, test } from "bun:test";
import {
  configuredFactoryboxRuntimeProfile,
  deleteFactoryboxStore,
  type FactoryboxRuntimeInput,
  factoryboxOriginalWorkerRetired,
  factoryboxPreparationRequest,
  renderFactoryboxRuntime,
} from "./factorybox-runtime";
import type { runFactoryboxKubernetes } from "./factorybox-worker";

const input: FactoryboxRuntimeInput = {
  attemptID: "01234567-89ab-5def-8123-456789abcdef",
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
    subPath: "home",
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
    factoryboxPreparationRequest(input, {
      version: 1,
      namespaceUID: "namespace",
      claimUID: "claim",
      podUID: "pod",
      storeID: "d".repeat(32),
      epoch: "e".repeat(32),
      bootID: "boot",
      executableSHA256: input.profile.executableSHA256,
      controllerRoot: "/controller",
    }),
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
