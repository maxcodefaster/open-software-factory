import type { FactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";

// Controller fixtures inject Kubernetes. These artifacts are never pulled or started.
export const ownedFactoryboxProfile = {
  image: `example.invalid/owned-worker@sha256:${"e".repeat(64)}`,
  executableSHA256: "f".repeat(64),
  architecture: "amd64",
  nodeName: "owned-node",
  kernel: "6.12.0",
  boundedBytes: 8589934592,
  claimGiB: 32,
} satisfies FactoryboxRuntimeProfile;

export const ownedRuntimeConfiguration = {
  FACTORY_RUNTIME_HOST_IMAGE: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  FACTORY_BUILD_RUNTIME_HOST_IMAGE: `example.invalid/owned-build@sha256:${"b".repeat(64)}`,
  FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE: `example.invalid/owned-verification@sha256:${"c".repeat(64)}`,
  FACTORY_BROWSER_TOOLS_IMAGE: `example.invalid/owned-browser@sha256:${"d".repeat(64)}`,
  FACTORY_FACTORYBOX_WORKER_IMAGE: ownedFactoryboxProfile.image,
  FACTORY_FACTORYBOX_EXECUTABLE_SHA256: ownedFactoryboxProfile.executableSHA256,
  FACTORY_FACTORYBOX_ARCHITECTURE: ownedFactoryboxProfile.architecture,
  FACTORY_FACTORYBOX_NODE: ownedFactoryboxProfile.nodeName,
  FACTORY_FACTORYBOX_KERNEL: ownedFactoryboxProfile.kernel,
  FACTORY_FORGEJO_API_URL: "http://127.0.0.1:1/api/v1",
  FACTORY_FORGEJO_TOKEN: "owned-mocked-forge-token",
  FACTORY_FORGEJO_OWNER: "owned-runtime-fixture",
};

export function installOwnedRuntimeConfiguration() {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ownedRuntimeConfiguration)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
