import { createHash } from "node:crypto";
import { z } from "zod";
import flags from "../../deploy/substrate/internal_flags.json";
import pins from "../../deploy/substrate/pins.json";

export { flags, pins };

const name = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const image = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const substrateProfileInput = z.strictObject({
  namespace: name,
  pool: name,
  node: z
    .string()
    .max(253)
    .refine(
      (value) => value.split(".").every((label) => name.safeParse(label).success),
      "Expected a Kubernetes node hostname",
    ),
  workerImage: image,
  workloadImage: image,
  template: name,
  command: z.array(z.string().min(1)).min(1),
});

export function digest(bytes: Uint8Array, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

export function verifyNightly(bytes: Uint8Array) {
  if (digest(bytes) !== pins.gvisor.sha256 || digest(bytes, "sha512") !== pins.gvisor.sha512)
    throw new Error("Official gVisor archive does not match both pinned published checksums");
}

// Concrete native manifests only. No installation-wide default, provider switch,
// Actor create, Source initialization, or implicit cleanup is performed here.
export function renderSubstrateProfile(value: unknown) {
  const input = substrateProfileInput.parse(value);
  const configName = pins.gvisor.version;
  const labels = { "factory.runtime/profile": configName };
  const sandboxConfig = {
    apiVersion: "ate.dev/v1",
    kind: "SandboxConfig",
    metadata: { name: configName },
    spec: {
      sandboxClass: "gvisor",
      defaultVersion: configName,
      versions: [
        {
          name: configName,
          state: "Enabled",
          assets: {
            amd64: {
              gvisor: {
                url: pins.gvisor.url.replace("https://storage.googleapis.com/", "gs://"),
                sha256: pins.gvisor.sha256,
              },
            },
          },
        },
      ],
    },
  };
  const workerPool = {
    apiVersion: "ate.dev/v1",
    kind: "WorkerPool",
    metadata: { name: input.pool, namespace: input.namespace, labels },
    spec: {
      replicas: 1,
      workerImage: input.workerImage,
      sandboxClasses: [{ name: "gvisor", configRef: { name: configName } }],
      template: {
        nodeSelector: { "kubernetes.io/hostname": input.node },
        resources: {
          requests: { cpu: "250m", memory: "1536Mi" },
          limits: { cpu: "2", memory: "2Gi" },
        },
      },
    },
  };
  const actorTemplate = {
    metadata: { name: input.template, atespace: input.namespace },
    containers: [
      {
        name: "workload",
        image: input.workloadImage,
        command: ["/opt/factory-rootless/start.sh", ...input.command],
        securityContext: { capabilities: { add: ["SETUID", "SETGID"] } },
        volumeMounts: [
          { name: "saved", mountPath: "/home/rootless/persist" },
          { name: "trust", mountPath: "/run/ate/egress-trust-bundle" },
        ],
        wakeupProbe: { httpGet: { path: "/readyz", port: 18081 }, timeoutSeconds: 300 },
      },
    ],
    resources: { limits: { cpuMillicores: "1500", memoryBytes: "1073741824" } },
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
    ],
    workerSelector: { matchLabels: labels },
  };
  return { sandboxConfig, workerPool, actorTemplate };
}
