import { expect, test } from "bun:test";
import { factoryboxLocation } from "./factorybox-location";
import {
  configuredFactoryboxRuntimeProfile,
  type FactoryboxRuntimeInput,
  renderFactoryboxRuntime,
} from "./factorybox-runtime";

const retainedProfile = {
  image: `registry.example/worker@sha256:${"a".repeat(64)}`,
  executableSHA256: "b".repeat(64),
  architecture: "arm64" as const,
  nodeName: "qualified-node",
  kernel: "qualified-kernel",
  boundedBytes: 32 * 1024 ** 3,
  claimGiB: 64,
};
const input: FactoryboxRuntimeInput = {
  ...factoryboxLocation("01234567-89ab-4def-8123-456789abcdef"),
  attemptID: "11234567-89ab-4def-8123-456789abcdef",
  sandboxID: "runtime-1123456789ab4def8123456789abcdef",
  runtimeOwnerID: "21234567-89ab-4def-8123-456789abcdef",
  labels: { "factory.dev/runtime-attempt": "11234567-89ab-4def-8123-456789abcdef" },
  runtimeHostImage: `registry.example/runtime@sha256:${"c".repeat(64)}`,
  profile: retainedProfile,
  sharedSource: true,
};

test("fresh worker admission checks its real backing capacity before native startup", () => {
  const profile = configuredFactoryboxRuntimeProfile({
    FACTORY_FACTORYBOX_WORKER_IMAGE: retainedProfile.image,
    FACTORY_FACTORYBOX_EXECUTABLE_SHA256: retainedProfile.executableSHA256,
    FACTORY_FACTORYBOX_ARCHITECTURE: retainedProfile.architecture,
    FACTORY_FACTORYBOX_NODE: retainedProfile.nodeName,
    FACTORY_FACTORYBOX_KERNEL: retainedProfile.kernel,
    FACTORY_FACTORYBOX_BOUNDED_BYTES: String(retainedProfile.boundedBytes),
    FACTORY_FACTORYBOX_CLAIM_GIB: String(retainedProfile.claimGiB),
  });
  const { pod } = renderFactoryboxRuntime({ ...input, profile });
  expect(pod.spec.initContainers.map((container) => container.name)).toEqual([
    "store-initialize",
    "runtime-image",
    "storage-admission",
  ]);
  const check = pod.spec.initContainers.find((container) => container.name === "storage-admission");
  expect(check).toBeDefined();
  expect(check?.image).toBe(retainedProfile.image);
  expect(check?.volumeMounts).toEqual([
    { name: "store", mountPath: "/factory-store", readOnly: true },
  ]);
  expect(check?.env).toEqual(
    expect.arrayContaining([
      { name: "FACTORY_BOUNDED_BYTES", value: String(retainedProfile.boundedBytes) },
    ]),
  );
  expect(check?.resources.requests.cpu).toBe("100m");
  expect(check?.securityContext.capabilities.drop).toEqual(["ALL"]);
  expect(JSON.stringify(check)).not.toMatch(
    /runtime-data|factory-source|docker.sock|token|deadline/i,
  );
  expect(pod.spec.restartPolicy).toBe("Never");
});

test("retained worker declarations do not gain another init container during an upgrade", () => {
  const before = renderFactoryboxRuntime(input);
  expect(before.pod.spec.initContainers.map((container) => container.name)).toEqual([
    "store-initialize",
    "runtime-image",
  ]);
  expect(retainedProfile.boundedBytes).toBe(32 * 1024 ** 3);
  expect(before.pod.spec.containers[0]?.args).toContain(String(retainedProfile.boundedBytes));
});
