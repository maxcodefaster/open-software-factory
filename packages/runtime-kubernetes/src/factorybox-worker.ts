import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { runCommand } from "./command";
import { kubernetesCommand } from "./config";
import { readFactoryboxCheckpointRetirement } from "./factorybox-retention";

const token = z.string().regex(/^[a-f0-9]{32}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const uid = z.string().min(1).max(128);
const storeRoot = "/var/lib/sysbox/fixed-store/data/store";
const binary = "/opt/factorybox/factorybox";

// This is an administrative admission lane. Product Workspace source remains
// owned by its existing Source controller and is never mounted into this store.
export const factoryboxWorkerRequest = z
  .strictObject({
    version: z.literal(1),
    namespace: name,
    podName: name,
    storeID: token,
    trustDomainID: token,
    image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:/-]*@sha256:[a-f0-9]{64}$/),
    executableSHA256: digest,
    architecture: z.enum(["arm64", "amd64"]),
    nodeName: z
      .string()
      .max(253)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
    kernel: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9._+-]+$/),
    boundedBytes: z
      .number()
      .int()
      .min(512 * 1024 ** 2)
      .max(32 * 1024 ** 3)
      .multipleOf(4096),
    // Leave at least the worker's 12 GiB host reserve + 4 GiB admission headroom.
    claimGiB: z.number().int().min(20).max(1024),
    storageClass: z
      .string()
      .max(253)
      .regex(/^[a-z0-9][a-z0-9.-]*$/)
      .optional(),
  })
  .refine((value) => value.claimGiB * 1024 ** 3 >= value.boundedBytes + 17 * 1024 ** 3, {
    message: "Worker PVC must cover the bounded image, 16 GiB host admission floor and metadata",
  });
export type FactoryboxWorkerRequest = z.infer<typeof factoryboxWorkerRequest>;

export const factoryboxWorkerIdentity = z.strictObject({
  version: z.literal(1),
  namespaceUID: uid,
  podUID: uid,
  claimUID: uid,
  storeID: token,
  epoch: token,
  bootID: uid,
  executableSHA256: digest,
  controllerRoot: z.string(),
});
export type FactoryboxWorkerIdentity = z.infer<typeof factoryboxWorkerIdentity>;

const sandbox = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const factoryboxOperation = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("capacity") }),
  z.strictObject({ action: z.literal("state"), sandboxID: sandbox }),
  z.strictObject({ action: z.literal("delete"), sandboxID: sandbox }),
  z.strictObject({
    action: z.literal("start"),
    sandboxID: sandbox,
    bundle: z.string().regex(new RegExp(`^${storeRoot}/input/(?:[a-zA-Z0-9_-]+/)?bundle$`)),
  }),
  z.strictObject({ action: z.literal("pause"), sandboxID: sandbox, snapshotID: token }),
  z.strictObject({ action: z.literal("resume"), sandboxID: sandbox, snapshotID: token }),
  z.strictObject({
    action: z.literal("retire-checkpoint"),
    sandboxID: sandbox,
    snapshotID: token,
    sourceOwner: token,
    checkpointSHA256: digest,
  }),
]);
export type FactoryboxOperation = z.infer<typeof factoryboxOperation>;

export function renderFactoryboxWorker(request: FactoryboxWorkerRequest) {
  const input = factoryboxWorkerRequest.parse(request);
  const labels = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/factorybox-store": input.storeID,
    "factory.dev/trust-domain": input.trustDomainID,
  };
  const claimName = `store-${input.storeID}`;
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: input.namespace, labels } },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: claimName, namespace: input.namespace, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        volumeMode: "Filesystem",
        ...(input.storageClass ? { storageClassName: input.storageClass } : {}),
        resources: { requests: { storage: `${input.claimGiB}Gi` } },
      },
    },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: input.podName, namespace: input.namespace, labels },
      spec: {
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 45,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        shareProcessNamespace: false,
        nodeSelector: {
          "kubernetes.io/os": "linux",
          "kubernetes.io/arch": input.architecture,
          "kubernetes.io/hostname": input.nodeName,
        },
        containers: [
          {
            name: "worker",
            image: input.image,
            imagePullPolicy: "IfNotPresent",
            command: [binary, "worker"],
            args: [
              "--store-id",
              input.storeID,
              "--bounded-root",
              "/var/lib/sysbox/fixed-store",
              "--bounded-bytes",
              String(input.boundedBytes),
              "--health-listen",
              "0.0.0.0:8081",
            ],
            securityContext: { privileged: true, runAsUser: 0, runAsGroup: 0 },
            resources: {
              requests: { cpu: "3", memory: "3Gi" },
              limits: { cpu: "3", memory: "3Gi" },
            },
            env: [
              { name: "GOMAXPROCS", value: "2" },
              { name: "GOMEMLIMIT", value: "256MiB" },
            ],
            ports: [{ name: "health", containerPort: 8081 }],
            startupProbe: {
              httpGet: { path: "/readyz", port: "health" },
              periodSeconds: 2,
              timeoutSeconds: 5,
              failureThreshold: 60,
            },
            readinessProbe: {
              httpGet: { path: "/readyz", port: "health" },
              periodSeconds: 10,
              timeoutSeconds: 5,
              failureThreshold: 1,
            },
            volumeMounts: [
              { name: "store", mountPath: "/var/lib/sysbox" },
              { name: "kernel-modules", mountPath: "/lib/modules", readOnly: true },
            ],
          },
        ],
        volumes: [
          { name: "store", persistentVolumeClaim: { claimName } },
          { name: "kernel-modules", hostPath: { path: "/lib/modules", type: "Directory" } },
        ],
      },
    },
  ] as const;
}

type Run = typeof runCommand;
export interface FactoryboxWorkerDeclaration {
  readonly namespace: { readonly metadata: { readonly labels: Readonly<Record<string, string>> } };
  readonly claim: {
    readonly metadata: { readonly name: string; readonly labels: Readonly<Record<string, string>> };
    readonly spec: object;
  };
  readonly pod: {
    readonly metadata: { readonly labels: Readonly<Record<string, string>> };
    readonly spec: object;
  };
}
export const runFactoryboxKubernetes: Run = (args, input, limits) =>
  runCommand(
    kubernetesCommand([
      // The bounded subprocess owns long exec deadlines. An API request timeout
      // must not cut a valid CRIU operation off after ten seconds.
      args[0] === "exec" ? "--request-timeout=0" : "--request-timeout=10s",
      ...args,
    ]),
    input,
    limits,
  );

const resource = z
  .object({
    metadata: z.object({
      uid,
      labels: z.record(z.string(), z.string()),
      deletionTimestamp: z.string().optional(),
    }),
  })
  .passthrough();

async function read(run: Run, args: string[]) {
  const result = await run(["get", ...args, "-o", "json"]);
  if (result.exitCode !== 0) throw new Error(`Observe Factorybox resource: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown;
}

function requireFields(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => requireFields(entry, actual[index]))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        value === false &&
        ["hostNetwork", "hostPID", "hostIPC"].includes(key) &&
        Reflect.get(actual, key) === undefined
          ? true
          : requireFields(value, Reflect.get(actual, key)),
      )
    );
  return expected === actual;
}

export async function inspectFactoryboxWorker(
  request: FactoryboxWorkerRequest,
  previous?: FactoryboxWorkerIdentity,
  run: Run = runFactoryboxKubernetes,
  declaration?: FactoryboxWorkerDeclaration,
): Promise<FactoryboxWorkerIdentity> {
  const input = factoryboxWorkerRequest.parse(request);
  const base = renderFactoryboxWorker(input);
  const declared = declaration ?? { namespace: base[0], claim: base[1], pod: base[2] };
  const expected = [declared.namespace, declared.claim, declared.pod] as const;
  const [namespaceRaw, claimRaw, podRaw, nodeRaw] = await Promise.all([
    read(run, ["namespace", input.namespace]),
    read(run, ["pvc", expected[1].metadata.name, "-n", input.namespace]),
    read(run, ["pod", input.podName, "-n", input.namespace]),
    read(run, ["node", input.nodeName]),
  ]);
  const namespace = resource.parse(namespaceRaw);
  const claim = resource
    .extend({
      spec: z.object({
        accessModes: z.array(z.string()),
        volumeMode: z.string(),
        storageClassName: z.string().optional(),
        resources: z.object({ requests: z.object({ storage: z.string() }) }),
      }),
      status: z.object({ phase: z.literal("Bound") }),
    })
    .parse(claimRaw);
  const pod = resource
    .extend({
      spec: z.object({ nodeName: z.string() }).catchall(z.unknown()),
      status: z.object({
        phase: z.literal("Running"),
        conditions: z.array(z.object({ type: z.string(), status: z.string() })),
        containerStatuses: z
          .array(z.object({ name: z.string(), restartCount: z.literal(0), ready: z.literal(true) }))
          .length(1),
      }),
    })
    .parse(podRaw);
  const node = z
    .object({
      metadata: z.object({ name: z.literal(input.nodeName) }),
      status: z.object({
        nodeInfo: z.object({
          operatingSystem: z.literal("linux"),
          architecture: z.literal(input.architecture),
          kernelVersion: z.literal(input.kernel),
          bootID: uid,
        }),
      }),
    })
    .parse(nodeRaw);
  for (const [wanted, actual] of [
    [expected[0], namespace],
    [expected[1], claim],
    [expected[2], pod],
  ] as const) {
    if (
      actual.metadata.deletionTimestamp ||
      !requireFields(wanted.metadata.labels, actual.metadata.labels)
    )
      throw new Error("Factorybox resource ownership changed or deletion is pending");
  }
  if (
    !requireFields(expected[1].spec, claim.spec) ||
    !requireFields(expected[2].spec, pod.spec) ||
    pod.spec.nodeName !== input.nodeName ||
    ["initContainers", "ephemeralContainers"].some((key) => {
      const value = pod.spec[key];
      if (key === "initContainers" && Object.hasOwn(expected[2].spec, key)) return false;
      return value !== undefined && (!Array.isArray(value) || value.length !== 0);
    }) ||
    !pod.status.conditions.some((value) => value.type === "Ready" && value.status === "True")
  )
    throw new Error("Factorybox Pod/PVC differs from its exact admission request or is not ready");
  if (
    previous &&
    (previous.namespaceUID !== namespace.metadata.uid ||
      previous.claimUID !== claim.metadata.uid ||
      previous.podUID !== pod.metadata.uid)
  )
    throw new Error("Factorybox Kubernetes UID changed; explicit new admission is required");

  // No exec has been created before HTTP readiness and exact Pod validation.
  const result = await run([
    "exec",
    input.podName,
    "-n",
    input.namespace,
    "-c",
    "worker",
    "--",
    binary,
    "worker-status",
  ]);
  if (result.exitCode !== 0) throw new Error(`Factorybox worker-status failed: ${result.stderr}`);
  const status = z
    .object({
      schema: z.literal(1),
      store_id: z.literal(input.storeID),
      store: z.literal(storeRoot),
      epoch: token,
      boot_id: z.literal(node.status.nodeInfo.bootID),
      supervisor_sha256: z.literal(input.executableSHA256),
      supervisor: z.object({ pid: z.literal(1) }),
      ready_at: z.string().min(1),
      lifecycle: z.object({
        root: z.string(),
        manager_root: z.literal(`${storeRoot}/manager`),
        bounded_store: z.object({
          target: z.literal("/var/lib/sysbox/fixed-store/data"),
          direct_io: z.literal(true),
          image: z.object({
            owner: z.literal(input.storeID),
            bytes: z.literal(input.boundedBytes),
          }),
        }),
      }),
    })
    .parse(JSON.parse(result.stdout));
  if (status.lifecycle.root !== `${storeRoot}/epochs/${status.epoch}/controller`)
    throw new Error("Factorybox controller root differs from its epoch");
  const identity: FactoryboxWorkerIdentity = {
    version: 1,
    namespaceUID: namespace.metadata.uid,
    podUID: pod.metadata.uid,
    claimUID: claim.metadata.uid,
    storeID: input.storeID,
    epoch: status.epoch,
    bootID: status.boot_id,
    executableSHA256: status.supervisor_sha256,
    controllerRoot: status.lifecycle.root,
  };
  if (previous && !isDeepStrictEqual(identity, factoryboxWorkerIdentity.parse(previous)))
    throw new Error("Factorybox live identity changed; recovery is a separate explicit operation");
  return identity;
}

export async function executeFactoryboxOperation(
  request: FactoryboxWorkerRequest,
  identity: FactoryboxWorkerIdentity,
  operation: FactoryboxOperation,
  run: Run = runFactoryboxKubernetes,
  declaration?: FactoryboxWorkerDeclaration,
) {
  const deadline = performance.now() + 420_000;
  const input = factoryboxWorkerRequest.parse(request);
  const admitted = factoryboxWorkerIdentity.parse(identity);
  const op = factoryboxOperation.parse(operation);
  await inspectFactoryboxWorker(input, admitted, run, declaration);
  const args = [
    binary,
    "--worker-run-root",
    "/run/factorybox",
    "--worker-store-id",
    admitted.storeID,
    "--worker-epoch",
    admitted.epoch,
    op.action,
  ];
  if (op.action === "start") args.push("--bundle", op.bundle);
  if (op.action === "pause" || op.action === "resume" || op.action === "retire-checkpoint")
    args.push("--snapshot-id", op.snapshotID);
  if (op.action === "retire-checkpoint")
    args.push("--source-owner", op.sourceOwner, "--checkpoint-sha256", op.checkpointSHA256);
  if (op.action !== "capacity") args.push(op.sandboxID);
  const remainingMS = deadline - performance.now();
  if (remainingMS <= 0) throw new Error("Factorybox lifecycle deadline expired before mutation");
  // One invocation only. Lost output, nonzero exits and partial JSON retain the
  // original operation identity; they never authorize another Sandbox/epoch.
  const result = await run(
    ["exec", input.podName, "-n", input.namespace, "-c", "worker", "--", ...args],
    undefined,
    { timeoutMS: remainingMS, outputBytes: 4 * 1024 ** 2 },
  );
  if (result.exitCode !== 0) return { confirmed: false as const, ...result };
  const output = JSON.parse(result.stdout) as {
    record?: {
      version?: number;
      id?: string;
      phase?: string;
      pause?: { snapshot_id?: string; completed_at?: string; resume?: { completed_at?: string } };
    };
    root?: string;
  };
  if (op.action === "capacity") {
    if (output.root !== admitted.controllerRoot)
      throw new Error("Capacity response has a different controller");
  } else if (op.action === "retire-checkpoint") {
    readFactoryboxCheckpointRetirement(
      {
        source_id: op.sandboxID,
        snapshot_id: op.snapshotID,
        source_owner: op.sourceOwner,
        checkpoint_sha256: op.checkpointSHA256,
      },
      admitted.controllerRoot,
      output,
    );
  } else {
    const record = output.record;
    const expectedPhase = {
      start: "running",
      pause: "paused",
      resume: "running",
      delete: "deleted",
      state: undefined,
    }[op.action];
    if (
      record?.version !== 1 ||
      record.id !== op.sandboxID ||
      (expectedPhase && record.phase !== expectedPhase)
    )
      throw new Error("Factorybox response does not confirm the requested Sandbox state");
    if (
      (op.action === "pause" || op.action === "resume") &&
      (record.pause?.snapshot_id !== op.snapshotID ||
        !record.pause.completed_at ||
        (op.action === "resume" && !record.pause.resume?.completed_at))
    )
      throw new Error("Factorybox response does not confirm the exact pause/resume identity");
  }
  return { confirmed: true as const, ...result };
}
