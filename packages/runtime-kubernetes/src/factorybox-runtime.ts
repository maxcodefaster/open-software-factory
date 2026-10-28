import { readFileSync } from "node:fs";
import { z } from "zod";
import type { runCommand } from "./command";
import { ensureFactoryboxConsumer } from "./factorybox-consumer";
import {
  factoryboxAssignmentSecret,
  factoryboxLocation,
  factoryboxSharedLabels,
} from "./factorybox-location";
import {
  type FactoryboxWorkerIdentity,
  inspectFactoryboxWorker,
  renderFactoryboxWorker,
  runFactoryboxKubernetes,
} from "./factorybox-worker";
import { workspaceSourceKey } from "./source-manifest";
import { runtimeVolumeClaimSpec } from "./storage";

const exactImage = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/)
  .refine(
    (value) =>
      value
        .slice(0, value.indexOf("@"))
        .split("/")
        .slice(1)
        .every((part) => part !== "" && part !== "." && part !== ".."),
    { message: "Runtime images need a qualified registry and canonical repository path" },
  );
export const factoryboxRuntimeProfile = z.strictObject({
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:/-]*@sha256:[a-f0-9]{64}$/),
  executableSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  architecture: z.enum(["arm64", "amd64"]),
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
    architecture: environment["FACTORY_FACTORYBOX_ARCHITECTURE"],
    nodeName: environment["FACTORY_FACTORYBOX_NODE"],
    kernel: environment["FACTORY_FACTORYBOX_KERNEL"],
    boundedBytes: 8 * 1024 ** 3,
    claimGiB: 32,
  });
}

export interface FactoryboxRuntimeInput {
  readonly attemptID: string;
  readonly sandboxID: string;
  readonly workerID: string;
  readonly reserve?: boolean;
  readonly namespace: string;
  readonly podName: string;
  readonly runtimeOwnerID: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly runtimeHostImage: string;
  // The original Pod's bootstrap export is not the selected Sandbox image.
  readonly workerRuntimeHostImage?: string;
  readonly profile: FactoryboxRuntimeProfile;
  readonly sharedSource: boolean;
  readonly storageNode?: string;
}

export function factoryboxSandboxID(executionID: string) {
  return `runtime-${z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(executionID.replaceAll("-", ""))}`;
}

export const factoryboxExportProgram = readFileSync(
  new URL("./factorybox/export-rootfs.sh", import.meta.url),
  "utf8",
);
export const factoryboxInitializeStoreProgram = readFileSync(
  new URL("./factorybox/initialize-store.py", import.meta.url),
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
  if (input.workerRuntimeHostImage) exactImage.parse(input.workerRuntimeHostImage);
  const identifier = (value: string) =>
    z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(value.replaceAll("-", ""));
  if (input.storageNode && input.storageNode !== profile.nodeName)
    throw new Error("Canonical source and the admitted Factorybox worker must use the same node");
  const executionID = input.reserve ? input.labels["factory.dev/execution-slot"] : input.attemptID;
  if (!executionID || input.sandboxID !== factoryboxSandboxID(executionID))
    throw new Error("Sandbox identity differs from its immutable execution or reserve slot");
  const location = factoryboxLocation(input.workerID);
  if (input.namespace !== location.namespace || input.podName !== location.podName)
    throw new Error("Sandbox execution must use its Factory's shared worker");
  return {
    version: 1 as const,
    ...profile,
    namespace: input.namespace,
    podName: input.podName,
    storeID: identifier(input.workerID),
    trustDomainID: identifier(input.workerID),
  };
}

export function renderFactoryboxRuntime(input: FactoryboxRuntimeInput) {
  const request = factoryboxRuntimeRequest(input);
  const resources = renderFactoryboxWorker(request);
  const worker = resources[2].spec.containers[0];
  const shared = factoryboxSharedLabels(input.workerID);
  const labels = { ...resources[2].metadata.labels, ...shared };
  const bootstrapImage = input.workerRuntimeHostImage ?? input.runtimeHostImage;
  const environment = [
    { name: "FACTORY_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
    { name: "FACTORY_STORE_ID", value: request.storeID },
    { name: "FACTORY_RUNTIME_IMAGE", value: bootstrapImage },
  ];
  return {
    namespace: {
      ...resources[0],
      metadata: { ...resources[0].metadata, labels: shared },
    },
    sourceClaim: {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim" as const,
      metadata: { name: "runtime-data", namespace: input.namespace, labels: shared },
      spec: runtimeVolumeClaimSpec(),
    },
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
            name: "store-initialize",
            image: request.image,
            imagePullPolicy: "IfNotPresent",
            command: ["python3", "-c", factoryboxInitializeStoreProgram],
            securityContext: {
              runAsUser: 0,
              runAsGroup: 0,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "250m", memory: "64Mi" },
              limits: { cpu: "250m", memory: "64Mi" },
            },
            env: environment,
            volumeMounts: [{ name: "store", mountPath: "/factory-store" }],
          },
          {
            name: "runtime-image",
            image: bootstrapImage,
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
              { name: "registry-ca", mountPath: "/factory/registry-ca", readOnly: true },
              { name: "runtime-data", mountPath: "/factory-source" },
            ],
          },
        ],
        volumes: [
          ...resources[2].spec.volumes,
          { name: "registry-ca", secret: { secretName: "registry-ca", defaultMode: 256 } },
          { name: "runtime-data", persistentVolumeClaim: { claimName: "runtime-data" } },
        ],
      },
    },
  };
}

function factoryboxPreparationIdentity(
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
    version: 3,
    sandboxID: input.sandboxID,
    storeID: identity.storeID,
    epoch: identity.epoch,
    podUID: identity.podUID,
    runtimeHostImage: input.runtimeHostImage,
    sharedSource: input.sharedSource,
    sourceWorkspaceID: input.sharedSource ? workspaceSourceKey(input.runtimeOwnerID) : null,
    bootstrap: input.reserve ? factoryboxReserveBootstrapProgram : factoryboxBootstrapProgram,
    reserveSeed: input.reserve ?? false,
  };
}

export function factoryboxPreparationRequest(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  assignment: Readonly<Record<string, string>>,
) {
  const owner = factoryboxPreparationIdentity(input, identity);
  const text = z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0"));
  const files: Record<string, string> = input.reserve
    ? z.strictObject({ "slot.json": text }).parse(assignment)
    : z
        .strictObject({
          "assignment.json": text,
          "parent-token": text,
          "child-token": text,
        })
        .parse(assignment);
  const executionID = input.reserve
    ? z
        .object({ version: z.literal(1), id: z.string() })
        .parse(JSON.parse(files["slot.json"] ?? "")).id
    : z
        .object({
          version: z.literal(1),
          runtimeAttemptId: z.literal(input.attemptID),
          generation: z.number().int().positive(),
        })
        .parse(JSON.parse(files["assignment.json"] ?? "")).runtimeAttemptId;
  if (factoryboxSandboxID(executionID) !== input.sandboxID)
    throw new Error("Sandbox assignment belongs to another immutable execution");
  const request = { ...owner, assignment: files };
  if (Buffer.byteLength(JSON.stringify(request)) > 65_536)
    throw new Error("Factory preparation request exceeds 64 KiB");
  return request;
}

export function factoryboxPreparationAssignment(input: FactoryboxRuntimeInput, value: unknown) {
  factoryboxRuntimeRequest(input);
  const secret = z
    .object({
      metadata: z.object({ labels: z.record(z.string(), z.string()) }),
      data: z.record(z.string(), z.string()),
    })
    .parse(value);
  const labels = secret.metadata.labels;
  if (
    labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    labels["factory.dev/runtime-owner"] !== input.runtimeOwnerID ||
    (input.reserve
      ? labels["factory.dev/execution-slot"] !== input.labels["factory.dev/execution-slot"]
      : labels["factory.dev/runtime-attempt"] !== input.attemptID)
  )
    throw new Error("Sandbox assignment belongs to another immutable execution owner");
  const names = input.reserve ? ["slot.json"] : ["assignment.json", "parent-token", "child-token"];
  return Object.fromEntries(
    names.map((name) => {
      const encoded = secret.data[name];
      if (!encoded) throw new Error("Sandbox assignment is incomplete");
      return [name, Buffer.from(encoded, "base64").toString("utf8")];
    }),
  );
}

export function factoryboxRuntimeDeclaration(input: FactoryboxRuntimeInput) {
  return renderFactoryboxRuntime(input);
}

export async function prepareFactoryboxRuntime(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  run: typeof runCommand = runFactoryboxKubernetes,
  timeoutMS = 420_000,
) {
  const deadline = performance.now() + timeoutMS;
  const assignmentID = input.reserve ? input.labels["factory.dev/execution-slot"] : input.attemptID;
  if (!assignmentID) throw new Error("Sandbox assignment identity is missing");
  await inspectFactoryboxWorker(
    factoryboxRuntimeRequest(input),
    identity,
    run,
    factoryboxRuntimeDeclaration(input),
  );
  await ensureFactoryboxConsumer(input, identity, run, deadline);
  const secret = await run([
    "get",
    "secret",
    factoryboxAssignmentSecret(assignmentID),
    "-n",
    input.namespace,
    "-o",
    "json",
  ]);
  if (secret.exitCode !== 0) throw new Error("Sandbox assignment observation is unavailable");
  const assignment = factoryboxPreparationAssignment(input, JSON.parse(secret.stdout));
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
    JSON.stringify(factoryboxPreparationRequest(input, identity, assignment)),
    { timeoutMS: Math.max(1, deadline - performance.now()), outputBytes: 1024 ** 2 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Factorybox preparation is unconfirmed: ${result.stderr}`);
  return z
    .strictObject({
      version: z.literal(3),
      sandboxID: z.literal(input.sandboxID),
      bundle: z.literal(`/var/lib/sysbox/fixed-store/data/store/input/${input.sandboxID}/bundle`),
      configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      rootfsSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      storeID: z.literal(identity.storeID),
      epoch: z.literal(identity.epoch),
      podUID: z.literal(identity.podUID),
    })
    .parse(JSON.parse(result.stdout));
}

export async function cancelFactoryboxPreparation(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
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
      "cancel",
    ],
    JSON.stringify(factoryboxPreparationIdentity(input, identity)),
    { timeoutMS: 30_000, outputBytes: 16_384 },
  );
  if (result.exitCode !== 0)
    throw new Error("Incomplete Factorybox preparation must remain retained for inspection");
  return z
    .strictObject({
      version: z.literal(1),
      cancelled: z.literal(true),
      sandboxID: z.literal(input.sandboxID),
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
    JSON.stringify(factoryboxPreparationIdentity(input, identity)),
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
// as absence. The caller retires only its Sandbox, never the shared Pod or store.
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
