import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type NativeArchitecture,
  nativeArchitecture,
  pinnedNativeSandboxSpec,
} from "#runtime-kubernetes/substrate-profile";
import flags from "../../deploy/substrate/internal_flags.json";
import pins from "../../deploy/substrate/pins.json";

export { flags, pins };

const name = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const image = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const substrateProfileInput = z.strictObject({
  architecture: nativeArchitecture,
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

export function verifyNightly(bytes: Uint8Array, architecture: NativeArchitecture) {
  const expected = pins.gvisor.architectures[nativeArchitecture.parse(architecture)];
  if (digest(bytes) !== expected.sha256 || digest(bytes, "sha512") !== expected.sha512)
    throw new Error("Official gVisor archive does not match both pinned published checksums");
}

const routerDeployment = z.looseObject({
  apiVersion: z.literal("apps/v1"),
  kind: z.literal("Deployment"),
  metadata: z.looseObject({
    namespace: z.literal("ate-system"),
    name: z.literal("atenet-router"),
    uid: z.string().min(1),
    resourceVersion: z.string().min(1),
  }),
  spec: z.looseObject({
    template: z.looseObject({
      spec: z.looseObject({
        containers: z.array(
          z.looseObject({ name: z.string(), args: z.array(z.string()).optional() }),
        ),
      }),
    }),
  }),
});

function podSPIFFEIdentity(namespace: string, serviceAccount: string) {
  name.parse(namespace);
  z.string()
    .max(253)
    .refine((value) => value.split(".").every((label) => name.safeParse(label).success))
    .parse(serviceAccount);
  return `spiffe://cluster.local/ns/${namespace}/sa/${serviceAccount}`;
}

// Offline operator plan for the pinned Envoy Router, not a Factory API or an
// installer. Upstream cmd/atenet/internal/router/cmd.go uses StringSliceVar:
// repeating this flag APPENDS; replacing its existing list would revoke clients.
export function planSubstrateRouterAdmission(
  value: unknown,
  namespace: string,
  serviceAccount: string,
) {
  const spiffeID = podSPIFFEIdentity(namespace, serviceAccount);
  const deployment = routerDeployment.parse(value);
  const containers = deployment.spec.template.spec.containers;
  const index = containers.findIndex((container) => container.name === "atenet-router");
  if (containers.filter((container) => container.name === "atenet-router").length !== 1)
    throw new Error("Expected exactly one native atenet-router container");
  const args = containers[index]?.args;
  if (args?.[0] !== "router" || args.includes("--"))
    throw new Error("Unsupported native Router argv");
  const values = (flag: string) =>
    args.flatMap((arg, index) => {
      if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1)];
      if (arg !== flag) return [];
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing native Router ${flag} value`);
      return [next];
    });
  for (const [flag, expected] of [
    ["--mode", "ingress"],
    ["--ingress-client-ca-file", "/run/podidentity.podcert.ate.dev/trust-bundle.pem"],
    ["--envoy-cert-path", "/run/servicedns.podcert.ate.dev/credential-bundle.pem"],
  ] as const) {
    const observed = values(flag);
    if (observed.length !== 1 || observed[0] !== expected)
      throw new Error(`Unsupported native Router ${flag}`);
  }
  if (values("--atenet-dataplane").some((dataplane) => dataplane !== "envoy"))
    throw new Error("Expected the pinned Envoy Router");
  const allowedSPIFFEIDs = values("--ingress-allowed-spiffe-ids").flatMap((value) =>
    value === "" ? [] : value.split(","),
  );
  // This bounded path supports the official signer's literal Pod identities.
  // Unknown forms need operator review, never silent normalization or removal.
  for (const id of allowedSPIFFEIDs) {
    const match = /^spiffe:\/\/cluster\.local\/ns\/([^/]+)\/sa\/([^/]+)$/.exec(id);
    if (!match || podSPIFFEIdentity(match[1] ?? "", match[2] ?? "") !== id)
      throw new Error("Expected exact native Pod SPIFFE IDs without wildcards");
  }
  const path = `/spec/template/spec/containers/${index}`;
  const patch = allowedSPIFFEIDs.includes(spiffeID)
    ? []
    : [
        { op: "test", path: "/metadata/uid", value: deployment.metadata.uid },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: deployment.metadata.resourceVersion,
        },
        { op: "test", path: `${path}/name`, value: "atenet-router" },
        { op: "test", path: `${path}/args`, value: args },
        { op: "add", path: `${path}/args/-`, value: `--ingress-allowed-spiffe-ids=${spiffeID}` },
      ];
  return { spiffeID, allowedSPIFFEIDs, patch };
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
    spec: pinnedNativeSandboxSpec(),
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
        nodeSelector: {
          "kubernetes.io/hostname": input.node,
          "kubernetes.io/os": "linux",
          "kubernetes.io/arch": input.architecture,
        },
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
        command: [...input.command],
        securityContext: { capabilities: { drop: ["ALL"] } },
        env: [
          "SSL_CERT_FILE",
          "GIT_SSL_CAINFO",
          "NODE_EXTRA_CA_CERTS",
          "REQUESTS_CA_BUNDLE",
          "CURL_CA_BUNDLE",
        ].map((name) => ({ name, value: "/run/ate/egress-trust-bundle/trust-bundle.pem" })),
        volumeMounts: [{ name: "trust", mountPath: "/run/ate/egress-trust-bundle" }],
      },
    ],
    resources: { limits: { cpuMillicores: "1500", memoryBytes: "1073741824" } },
    snapshotConfig: {
      preferredFidelity: "SNAPSHOT_FIDELITY_MEMORY",
      goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
    },
    volumes: [
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
