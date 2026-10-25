import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  inspectFactoryboxWorker,
  renderFactoryboxWorker,
  runFactoryboxKubernetes,
  type FactoryboxWorkerIdentity,
} from "./factorybox-worker";
import type { runCommand } from "./command";
import { runtimeVolumeClaimSpec } from "./storage";

const exactImage = z.string().regex(/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/);
export const factoryboxRuntimeProfile = z.strictObject({
  image: exactImage,
  executableSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  nodeName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)
    .max(253),
  kernel: z
    .string()
    .regex(/^[a-zA-Z0-9._+-]+$/)
    .max(256),
  boundedBytes: z.literal(8 * 1024 ** 3),
  claimGiB: z.literal(32),
});
export type FactoryboxRuntimeProfile = z.infer<typeof factoryboxRuntimeProfile>;

export function configuredFactoryboxRuntimeProfile(
  environment = process.env,
): FactoryboxRuntimeProfile {
  return factoryboxRuntimeProfile.parse({
    image: environment["FACTORY_FACTORYBOX_WORKER_IMAGE"],
    executableSHA256: environment["FACTORY_FACTORYBOX_EXECUTABLE_SHA256"],
    nodeName: environment["FACTORY_FACTORYBOX_NODE"],
    kernel: environment["FACTORY_FACTORYBOX_KERNEL"],
    boundedBytes: 8 * 1024 ** 3,
    claimGiB: 32,
  });
}

export interface FactoryboxRuntimeInput {
  readonly attemptID: string;
  readonly workerID?: string;
  readonly reserve?: boolean;
  readonly namespace: string;
  readonly podName: string;
  readonly runtimeOwnerID: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly runtimeHostImage: string;
  readonly profile: FactoryboxRuntimeProfile;
  readonly sharedSource: boolean;
  readonly storageNode?: string;
}

export const factoryboxExportProgram = readFileSync(
  new URL("./factorybox/export-rootfs.sh", import.meta.url),
  "utf8",
);
export const factoryboxPrepareProgram = readFileSync(
  new URL("./factorybox/prepare.py", import.meta.url),
  "utf8",
);
export const factoryboxBootstrapProgram = readFileSync(
  new URL("./factorybox/bootstrap.sh", import.meta.url),
  "utf8",
);
export const factoryboxReserveBootstrapProgram = readFileSync(
  new URL("./factorybox/reserve-bootstrap.sh", import.meta.url),
  "utf8",
);

export function factoryboxRuntimeRequest(input: FactoryboxRuntimeInput) {
  const profile = factoryboxRuntimeProfile.parse(input.profile);
  exactImage.parse(input.runtimeHostImage);
  const identifier = (value: string) =>
    z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(value.replaceAll("-", ""));
  if (input.storageNode && input.storageNode !== profile.nodeName)
    throw new Error("Canonical source and the admitted Factorybox worker must use the same node");
  return {
    version: 1 as const,
    ...profile,
    namespace: input.namespace,
    podName: input.podName,
    storeID: identifier(input.workerID ?? input.attemptID),
    trustDomainID: identifier(input.workerID ?? input.runtimeOwnerID),
  };
}

export function renderFactoryboxRuntime(input: FactoryboxRuntimeInput) {
  const request = factoryboxRuntimeRequest(input);
  const resources = renderFactoryboxWorker(request);
  const worker = resources[2].spec.containers[0];
  const labels = { ...resources[2].metadata.labels, ...input.labels };
  const environment = [
    { name: "FACTORY_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
    { name: "FACTORY_STORE_ID", value: request.storeID },
    { name: "FACTORY_RUNTIME_IMAGE", value: input.runtimeHostImage },
  ];
  return {
    claim: {
      ...resources[1],
      metadata: { ...resources[1].metadata, labels },
      spec: runtimeVolumeClaimSpec("32Gi"),
    },
    pod: {
      ...resources[2],
      metadata: { ...resources[2].metadata, labels },
      spec: {
        ...resources[2].spec,
        initContainers: [
          {
            name: "runtime-image",
            image: input.runtimeHostImage,
            imagePullPolicy: "IfNotPresent",
            command: ["/bin/sh", "-ec", factoryboxExportProgram],
            securityContext: {
              runAsUser: 0,
              runAsGroup: 0,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "1", memory: "256Mi" },
              limits: { cpu: "1", memory: "256Mi" },
            },
            env: environment,
            volumeMounts: [{ name: "store", mountPath: "/factory-seed", subPath: "seed" }],
          },
        ],
        containers: [
          {
            ...worker,
            env: [...worker.env, ...environment],
            volumeMounts: [
              ...worker.volumeMounts,
              { name: "assignment", mountPath: "/factory/assignment", readOnly: true },
              { name: "registry-ca", mountPath: "/factory/registry-ca", readOnly: true },
              ...(input.sharedSource
                ? [{ name: "runtime-data", mountPath: "/factory-source", subPath: "home" }]
                : []),
            ],
          },
        ],
        volumes: [
          ...resources[2].spec.volumes,
          { name: "assignment", secret: { secretName: "runtime-assignment", defaultMode: 256 } },
          { name: "registry-ca", secret: { secretName: "registry-ca", defaultMode: 256 } },
          ...(input.sharedSource
            ? [{ name: "runtime-data", persistentVolumeClaim: { claimName: "runtime-data" } }]
            : []),
        ],
      },
    },
  };
}

export function factoryboxPreparationRequest(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
) {
  const request = factoryboxRuntimeRequest(input);
  if (
    identity.storeID !== request.storeID ||
    identity.executableSHA256 !== request.executableSHA256
  )
    throw new Error("Factory preparation does not match its admitted worker");
  return {
    version: 1,
    storeID: identity.storeID,
    epoch: identity.epoch,
    podUID: identity.podUID,
    runtimeHostImage: input.runtimeHostImage,
    sharedSource: input.sharedSource,
    bootstrap: input.reserve ? factoryboxReserveBootstrapProgram : factoryboxBootstrapProgram,
    reserveSeed: input.reserve ?? false,
  };
}

export function factoryboxRuntimeDeclaration(input: FactoryboxRuntimeInput) {
  return {
    ...renderFactoryboxRuntime(input),
    namespace: {
      metadata: {
        labels: {
          "app.kubernetes.io/managed-by": "open-software-factory",
          "factory.dev/runtime-owner": input.runtimeOwnerID,
          ...(input.labels["factory.dev/project"]
            ? { "factory.dev/project": input.labels["factory.dev/project"] }
            : {}),
        },
      },
    },
  };
}

export async function prepareFactoryboxRuntime(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  run: typeof runCommand = runFactoryboxKubernetes,
  timeoutMS = 420_000,
) {
  const deadline = performance.now() + timeoutMS;
  await inspectFactoryboxWorker(
    factoryboxRuntimeRequest(input),
    identity,
    run,
    factoryboxRuntimeDeclaration(input),
  );
  const result = await run(
    [
      "exec",
      "-i",
      input.podName,
      "-n",
      input.namespace,
      "-c",
      "worker",
      "--",
      "python3",
      "-c",
      factoryboxPrepareProgram,
    ],
    JSON.stringify(factoryboxPreparationRequest(input, identity)),
    { timeoutMS: Math.max(1, deadline - performance.now()), outputBytes: 1024 ** 2 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Factorybox preparation is unconfirmed: ${result.stderr}`);
  return z
    .strictObject({
      version: z.literal(1),
      bundle: z.literal(`/var/lib/sysbox/fixed-store/data/store/input/${identity.storeID}/bundle`),
      configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      rootfsSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      storeID: z.literal(identity.storeID),
      epoch: z.literal(identity.epoch),
      podUID: z.literal(identity.podUID),
    })
    .parse(JSON.parse(result.stdout));
}

export async function releaseFactoryboxRuntime(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  neverStarted: boolean,
  run: typeof runCommand = runFactoryboxKubernetes,
) {
  await inspectFactoryboxWorker(
    factoryboxRuntimeRequest(input),
    identity,
    run,
    factoryboxRuntimeDeclaration(input),
  );
  const result = await run(
    [
      "exec",
      "-i",
      input.podName,
      "-n",
      input.namespace,
      "-c",
      "worker",
      "--",
      "python3",
      "-c",
      factoryboxPrepareProgram,
      "release",
      ...(neverStarted ? ["--never-started"] : []),
    ],
    JSON.stringify(factoryboxPreparationRequest(input, identity)),
    { timeoutMS: 60_000, outputBytes: 1024 ** 2 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Factorybox private input release is unconfirmed: ${result.stderr}`);
  return z
    .strictObject({ version: z.literal(1), released: z.literal(true) })
    .parse(JSON.parse(result.stdout));
}

// Explicit Stop may retire a lost original worker. It cannot manufacture a
// native Delete receipt, adopt a replacement Pod, or treat an unavailable read
// as absence. The caller still deletes only its exact Pod and store claim.
export async function factoryboxOriginalWorkerRetired(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  run: typeof runCommand = runFactoryboxKubernetes,
) {
  const missing = (value: { exitCode: number; stderr: string }) =>
    value.exitCode !== 0 && /^Error from server \(NotFound\):/.test(value.stderr.trim());
  const namespace = await run(["get", "namespace", input.namespace, "-o", "json"]);
  if (missing(namespace)) return true;
  if (namespace.exitCode !== 0)
    throw new Error("Original worker Namespace observation is unavailable");
  z.object({ metadata: z.object({ uid: z.literal(identity.namespaceUID) }) }).parse(
    JSON.parse(namespace.stdout),
  );
  const pod = await run(["get", "pod", input.podName, "-n", input.namespace, "-o", "json"]);
  if (missing(pod)) return true;
  if (pod.exitCode !== 0) throw new Error("Original worker Pod observation is unavailable");
  const observed = z
    .object({
      metadata: z.object({ uid: z.literal(identity.podUID) }),
      status: z.object({
        phase: z.string(),
        containerStatuses: z
          .array(z.object({ name: z.string(), restartCount: z.number() }))
          .optional(),
      }),
    })
    .parse(JSON.parse(pod.stdout));
  return (
    ["Failed", "Succeeded"].includes(observed.status.phase) ||
    observed.status.containerStatuses?.some(
      (value) => value.name === "worker" && value.restartCount > 0,
    ) ||
    false
  );
}

export async function deleteFactoryboxStore(
  input: {
    namespace: string;
    namespaceUID: string;
    podName: string;
    attemptID: string;
    storeID: string;
    claimUID?: string;
  },
  run: typeof runCommand = runFactoryboxKubernetes,
) {
  const dns = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  dns.parse(input.namespace);
  dns.parse(input.podName);
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(input.storeID);
  const name = `store-${input.storeID}`;
  const missing = (value: { exitCode: number; stderr: string }) =>
    value.exitCode !== 0 && /^Error from server \(NotFound\):/m.test(value.stderr);
  const namespace = await run(["get", "namespace", input.namespace, "-o", "json"]);
  if (missing(namespace)) return;
  if (namespace.exitCode !== 0)
    throw new Error("Factorybox store Namespace observation is unavailable");
  const owner = z
    .object({ metadata: z.object({ uid: z.literal(input.namespaceUID) }) })
    .safeParse(JSON.parse(namespace.stdout));
  if (!owner.success) throw new Error("Factorybox store Namespace UID changed");
  const pod = await run(["get", "pod", input.podName, "-n", input.namespace, "-o", "json"]);
  if (!missing(pod))
    throw new Error("Factorybox store must remain until its original worker Pod is gone");
  const claim = await run(["get", "pvc", name, "-n", input.namespace, "-o", "json"]);
  if (missing(claim)) return;
  if (claim.exitCode !== 0) throw new Error("Factorybox store claim observation is unavailable");
  const observed = z
    .object({
      metadata: z.object({ uid: z.string().min(1), labels: z.record(z.string(), z.string()) }),
    })
    .parse(JSON.parse(claim.stdout));
  if (
    (input.claimUID && observed.metadata.uid !== input.claimUID) ||
    observed.metadata.labels["factory.dev/factorybox-store"] !== input.storeID ||
    observed.metadata.labels["factory.dev/runtime-attempt"] !== input.attemptID ||
    observed.metadata.labels["app.kubernetes.io/managed-by"] !== "open-software-factory"
  )
    throw new Error("Factorybox store claim ownership changed");
  const result = await run(
    [
      "delete",
      "--raw",
      `/api/v1/namespaces/${input.namespace}/persistentvolumeclaims/${name}`,
      "-f",
      "-",
    ],
    JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: observed.metadata.uid },
    }),
  );
  if (result.exitCode !== 0) throw new Error("Factorybox store deletion is unconfirmed");
  // A deletion response can precede finalizer completion. Leave the retained
  // Stop pending until observation confirms that exact backing is gone.
  const after = await run(["get", "pvc", name, "-n", input.namespace, "-o", "json"]);
  if (!missing(after)) throw new Error("Factorybox store deletion is still pending");
}
