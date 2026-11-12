import { substrateResourceReservation } from "./substrate-resources";

// Concrete pinned Actor bootstrap shared by Workspace and isolated Verification.
// It supplies neither host sockets nor Kubernetes/native control credentials.
export function renderSubstrateTemplate(
  atespace: string,
  config: {
    workloadImage: string;
    workerSelector: Record<string, string>;
    resources?: { cpuMilli: number; memoryMiB: number } | undefined;
  },
  bootstrap: unknown,
) {
  const resources = substrateResourceReservation(config);
  return {
    metadata: { atespace, name: "runtime" },
    containers: [
      {
        name: "workload",
        image: config.workloadImage,
        command: [
          "/opt/factory-rootless/start.sh",
          "/opt/factory-rootless/connector.sh",
          "/usr/local/bin/factory-runtime-connector",
          "native-parent",
        ],
        env: [{ name: "FACTORY_SUBSTRATE_BOOTSTRAP", value: JSON.stringify(bootstrap) }],
        securityContext: { capabilities: { add: ["SETUID", "SETGID"] } },
        volumeMounts: [
          { name: "saved", mountPath: "/home/rootless/persist" },
          { name: "trust", mountPath: "/run/ate/egress-trust-bundle" },
          { name: "identity", mountPath: "/run/ate/identity" },
        ],
        wakeupProbe: { httpGet: { path: "/readyz", port: 18081 }, timeoutSeconds: 300 },
      },
    ],
    resources: {
      limits: {
        cpuMillicores: String(resources.cpuMilli),
        memoryBytes: String(resources.memoryMiB * 1024 ** 2),
      },
    },
    snapshotConfig: {
      preferredFidelity: "SNAPSHOT_FIDELITY_ROOTFS",
      goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
    },
    volumes: [
      { name: "saved", durableDir: {} },
      {
        name: "trust",
        systemInfo: {
          dataSources: [
            {
              trustBundle: {
                names: ["egress-mitm.ate.dev", "system-roots.ate.dev"],
                path: "trust-bundle.pem",
              },
            },
          ],
        },
      },
      {
        name: "identity",
        systemInfo: {
          dataSources: [
            { actorMetadata: { items: [{ field: "ACTOR_METADATA_FIELD_UID", path: "uid" }] } },
          ],
        },
      },
    ],
    workerSelector: { matchLabels: config.workerSelector },
  };
}
