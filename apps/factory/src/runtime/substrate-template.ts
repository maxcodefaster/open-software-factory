import { readFileSync } from "node:fs";
import { substrateResourceReservation } from "./substrate-resources";

export function substrateBootstrapCA(factoryCAFile: string) {
  const publicCA = (file: string) => {
    const pem = readFileSync(file, "utf8");
    if (!pem.includes("-----BEGIN CERTIFICATE-----") || pem.includes("PRIVATE KEY"))
      throw new Error("Native bootstrap trust must contain public certificates only");
    return pem;
  };
  const factoryCA = publicCA(factoryCAFile);
  const registryCAFile = process.env["FACTORY_REGISTRY_CA_FILE"];
  // The chart's default is not extra trust: Substrate already supplies system roots.
  // Keep the original bytes (and template hash) when no additional CA is admitted.
  if (
    !registryCAFile ||
    registryCAFile === "/etc/ssl/certs/ca-certificates.crt" ||
    registryCAFile === factoryCAFile
  )
    return factoryCA;
  const registryCA = publicCA(registryCAFile).trim();
  return factoryCA.includes(registryCA) ? factoryCA : `${factoryCA.trimEnd()}\n${registryCA}\n`;
}

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
