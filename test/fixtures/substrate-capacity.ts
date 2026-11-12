import pins from "../../deploy/substrate/pins.json";
import { renderSubstrateProfile } from "../../scripts/runtime/substrate-profile";

export function nativeCapacityFixture() {
  const selector = {
    "factory.runtime/profile": pins.gvisor.version,
    "factory.dev/deployment": "owned-capacity",
  };
  const image = pins.substrate.workerImage;
  const rendered = renderSubstrateProfile({
    namespace: "owned-capacity",
    pool: "original-worker",
    node: "native-a",
    workerImage: image,
    workloadImage: image,
    template: "unused-capacity-fixture",
    command: ["true"],
  });
  const base = {
    ...rendered.workerPool,
    metadata: {
      ...rendered.workerPool.metadata,
      labels: selector,
      uid: crypto.randomUUID(),
      creationTimestamp: new Date().toISOString(),
    },
    status: { readyReplicas: 1 },
  };
  const sandbox = {
    ...rendered.sandboxConfig,
    metadata: {
      ...rendered.sandboxConfig.metadata,
      uid: crypto.randomUUID(),
      creationTimestamp: new Date().toISOString(),
    },
  };
  function node(name: string) {
    return {
      metadata: { name, uid: crypto.randomUUID(), labels: { "kubernetes.io/hostname": name } },
      spec: {},
      status: {
        nodeInfo: {
          architecture: "amd64",
          operatingSystem: "linux",
          bootID: crypto.randomUUID(),
          kernelVersion: "6.12.0",
        },
        allocatable: { cpu: "8", memory: "16Gi" },
        conditions: [
          { type: "Ready", status: "True" },
          { type: "MemoryPressure", status: "False" },
          { type: "DiskPressure", status: "False" },
          { type: "PIDPressure", status: "False" },
        ],
      },
    };
  }
  return { selector, image, base, sandbox, node };
}
