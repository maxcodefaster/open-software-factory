import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { runCommand } from "./command";
import { kubernetesCommand } from "./config";
import {
  readFactoryboxBackingRetirement,
  readFactoryboxCheckpointRetirement,
} from "./factorybox-retention";

const token = z.string().regex(/^[a-f0-9]{32}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const uid = z.string().min(1).max(128);
const storeRoot = "/var/lib/sysbox/fixed-store/data/store";
const binary = "/opt/factorybox/factorybox";
export const factoryboxCPURequestMilli = z.number().int().min(10).max(3000);
export const factoryboxWorkerResources = z.strictObject({
  cpuMilli: z.number().int().positive().safe(),
  memoryMiB: z
    .number()
    .int()
    .positive()
    .safe()
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2)),
});
export function factoryboxCPUQuantity(milli: number) {
  return milli % 1000 === 0 ? String(milli / 1000) : `${milli}m`;
}

function factoryboxMemoryQuantity(mib: number) {
  // Match Kubernetes Quantity serialization. Immutable declaration checks
  // must not mistake the API's 12288Mi -> 12Gi normalization for drift.
  for (const [power, unit] of [
    [3, "Pi"],
    [2, "Ti"],
    [1, "Gi"],
  ] as const) {
    const divisor = 1024 ** power;
    if (mib % divisor === 0) return `${mib / divisor}${unit}`;
  }
  return `${mib}Mi`;
}

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
    // Absent means the original fully reserved profile. Never rewrite a
    // retained worker's scheduling inputs during an application upgrade.
    cpuRequestMilli: factoryboxCPURequestMilli.optional(),
    // Absent retains the original 3 CPU / 3 GiB worker declaration.
    resources: factoryboxWorkerResources.optional(),
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
    minimumBoundedBytes: z
      .number()
      .int()
      .min(1024 ** 3)
      .max(32 * 1024 ** 3)
      .multipleOf(1024 ** 3)
      .optional(),
    // Leave at least the worker's 12 GiB host reserve + 4 GiB admission headroom.
    claimGiB: z.number().int().min(20).max(1024),
    storageClass: z
      .string()
      .max(253)
      .regex(/^[a-z0-9][a-z0-9.-]*$/)
      .optional(),
  })
  .refine((value) => (value.cpuRequestMilli ?? 3000) <= (value.resources?.cpuMilli ?? 3000), {
    message: "Worker CPU scheduling reserve exceeds its selected CPU ceiling",
  })
  .refine((value) => value.claimGiB * 1024 ** 3 >= value.boundedBytes + 17 * 1024 ** 3, {
    message: "Worker PVC must cover the bounded image, 16 GiB host admission floor and metadata",
  })
  .refine(
    (value) =>
      value.minimumBoundedBytes === undefined ||
      (value.minimumBoundedBytes <= value.boundedBytes && value.boundedBytes % 1024 ** 3 === 0),
    {
      message: "Automatic worker capacity requires whole-GiB bounds within the requested maximum",
    },
  );
export type FactoryboxWorkerRequest = z.infer<typeof factoryboxWorkerRequest>;

export const factoryboxWorkerIdentity = z.strictObject({
  version: z.literal(1),
  namespaceUID: uid,
  podUID: uid,
  claimUID: uid,
  storeID: token,
  epoch: token,
  bootID: uid,
  nodeBootID: uid,
  executableSHA256: digest,
  controllerRoot: z.string(),
  boundedBytes: z
    .number()
    .int()
    .min(1024 ** 3)
    .max(32 * 1024 ** 3)
    .multipleOf(1024 ** 3)
    .optional(),
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
  z
    .strictObject({
      action: z.literal("fork"),
      sandboxID: sandbox,
      sourceSandboxID: sandbox,
      snapshotID: token,
      sourceOwner: token,
      checkpointSHA256: digest,
    })
    .refine((value) => value.sandboxID !== value.sourceSandboxID, {
      message: "Fork source and target must be distinct",
    }),
  z.strictObject({
    action: z.enum(["retire-checkpoint", "retire-resume"]),
    sandboxID: sandbox,
    snapshotID: token,
    sourceOwner: token,
    checkpointSHA256: digest,
  }),
  z.strictObject({
    action: z.literal("retire-sandbox"),
    sandboxID: sandbox,
    sandboxOwner: token,
    inputSHA256: digest,
  }),
]);
export type FactoryboxOperation = z.infer<typeof factoryboxOperation>;

export function factoryboxOperationFailure(action: FactoryboxOperation["action"], stderr: string) {
  const detail = stripVTControlCharacters(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^command terminated with exit code \d+$/.test(line))
    .slice(0, 4)
    .join(" ")
    .slice(0, 2000);
  return new Error(`Factorybox ${action} outcome is unconfirmed${detail ? `: ${detail}` : ""}`);
}

export function requireFactoryboxWriteCapacity(
  identity: FactoryboxWorkerIdentity,
  action: "Start" | "Fork" | "preparation",
  value: unknown,
) {
  const counters = z.object({
    filesystem_available_bytes: z.number().int().nonnegative().safe(),
    min_free_bytes: z.number().int().nonnegative().safe(),
    write_reserve_bytes: z.number().int().nonnegative().safe(),
  });
  const parsed = z
    .object({
      version: z.literal(1),
      root: z.literal(identity.controllerRoot),
      new_write_admitted: z.boolean(),
      host: counters.optional(),
    })
    .safeParse(value);
  if (!parsed.success)
    throw new Error("Factorybox capacity decision is unverified before dispatch");
  if (!parsed.data.new_write_admitted) {
    const host = parsed.data.host;
    throw new Error(
      `Factorybox capacity refused ${action} before dispatch${
        host
          ? `: host available=${host.filesystem_available_bytes} bytes, free floor=${host.min_free_bytes}, write reserve=${host.write_reserve_bytes}`
          : ""
      }`,
    );
  }
}

export function renderFactoryboxWorker(request: FactoryboxWorkerRequest) {
  const input = factoryboxWorkerRequest.parse(request);
  const memory = input.resources ? factoryboxMemoryQuantity(input.resources.memoryMiB) : "3Gi";
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
              ...(input.minimumBoundedBytes === undefined
                ? []
                : ["--bounded-min-bytes", String(input.minimumBoundedBytes)]),
              "--health-listen",
              "0.0.0.0:8081",
            ],
            securityContext: { privileged: true, runAsUser: 0, runAsGroup: 0 },
            resources: {
              requests: {
                cpu:
                  input.cpuRequestMilli === undefined
                    ? "3"
                    : factoryboxCPUQuantity(input.cpuRequestMilli),
                memory,
              },
              limits: {
                cpu: factoryboxCPUQuantity(input.resources?.cpuMilli ?? 3000),
                memory,
              },
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
            volumeMounts: [{ name: "store", mountPath: "/var/lib/sysbox" }],
          },
        ],
        volumes: [{ name: "store", persistentVolumeClaim: { claimName } }],
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
export const factoryboxWorkerDeclaration = z.object({
  namespace: z
    .object({
      metadata: z
        .object({ name: z.string(), labels: z.record(z.string(), z.string()) })
        .passthrough(),
    })
    .passthrough(),
  claim: z
    .object({
      metadata: z
        .object({
          name: z.string(),
          namespace: z.string(),
          labels: z.record(z.string(), z.string()),
        })
        .passthrough(),
      spec: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
  pod: z
    .object({
      metadata: z
        .object({
          name: z.string(),
          namespace: z.string(),
          labels: z.record(z.string(), z.string()),
        })
        .passthrough(),
      spec: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
});
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

// Backfill the original declaration of an already admitted, exact-UID Pod.
// Kubernetes does not permit command/args updates on that Pod. Image and
// resource updates are mutable, so they still have to match the pinned profile.
// Native epoch, executable, node boot and all other declaration checks remain.
export async function observeOriginalFactoryboxDeclaration(
  request: FactoryboxWorkerRequest,
  previous: FactoryboxWorkerIdentity,
  expected: FactoryboxWorkerDeclaration,
  run: Run = runFactoryboxKubernetes,
): Promise<FactoryboxWorkerDeclaration> {
  const pod = resource
    .extend({
      spec: z
        .object({
          initContainers: z.array(
            z.object({
              name: z.string(),
              command: z.array(z.string()),
              args: z.array(z.string()).optional(),
            }),
          ),
        })
        .passthrough(),
    })
    .parse(await read(run, ["pod", request.podName, "-n", request.namespace]));
  if (pod.metadata.uid !== previous.podUID)
    throw new Error("Original worker UID changed before declaration observation");
  const declaration = structuredClone(factoryboxWorkerDeclaration.parse(expected));
  const containers = z
    .array(
      z
        .object({
          name: z.string(),
          command: z.array(z.string()),
          args: z.array(z.string()).optional(),
        })
        .passthrough(),
    )
    .parse(declaration.pod.spec["initContainers"]);
  if (containers.length !== pod.spec.initContainers.length)
    throw new Error("Original worker initialization differs from its admitted declaration");
  for (const [index, container] of containers.entries()) {
    const original = pod.spec.initContainers[index];
    if (!original || original.name !== container.name)
      throw new Error("Original worker initialization order changed");
    container.command = original.command;
    if (original.args) container.args = original.args;
    else delete container.args;
  }
  declaration.pod.spec["initContainers"] = containers;
  await inspectFactoryboxWorker(request, previous, run, declaration);
  return declaration;
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
  if (previous && previous.nodeBootID !== node.status.nodeInfo.bootID)
    throw new Error("Factorybox node boot identity changed; explicit new admission is required");

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
      boot_id: uid,
      supervisor_sha256: z.literal(input.executableSHA256),
      supervisor: z.object({ pid: z.literal(1) }),
      ready_at: z.string().min(1),
      bounded_capacity:
        input.minimumBoundedBytes === undefined
          ? z.undefined().optional()
          : z.strictObject({
              minimum_bytes: z.literal(input.minimumBoundedBytes),
              maximum_bytes: z.literal(input.boundedBytes),
            }),
      lifecycle: z.object({
        root: z.string(),
        manager_root: z.literal(`${storeRoot}/manager`),
        bounded_store: z.object({
          target: z.literal("/var/lib/sysbox/fixed-store/data"),
          direct_io: z.literal(true),
          image: z.object({
            owner: z.literal(input.storeID),
            bytes:
              input.minimumBoundedBytes === undefined
                ? z.literal(input.boundedBytes)
                : z
                    .number()
                    .int()
                    .min(input.minimumBoundedBytes)
                    .max(input.boundedBytes)
                    .multipleOf(1024 ** 3),
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
    nodeBootID: node.status.nodeInfo.bootID,
    executableSHA256: status.supervisor_sha256,
    controllerRoot: status.lifecycle.root,
    ...(input.minimumBoundedBytes === undefined
      ? {}
      : {
          boundedBytes: status.lifecycle.bounded_store.image.bytes,
        }),
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
  beforeDispatch?: () => Promise<void>,
) {
  const deadline = performance.now() + 420_000;
  const input = factoryboxWorkerRequest.parse(request);
  const admitted = factoryboxWorkerIdentity.parse(identity);
  const op = factoryboxOperation.parse(operation);
  await inspectFactoryboxWorker(input, admitted, run, declaration);
  const command = [
    binary,
    "--worker-run-root",
    "/run/factorybox",
    "--worker-store-id",
    admitted.storeID,
    "--worker-epoch",
    admitted.epoch,
  ];
  async function invoke(args: string[], observation: boolean) {
    for (;;) {
      const remainingMS = deadline - performance.now();
      if (remainingMS <= 0) throw new Error("Factorybox lifecycle deadline expired before command");
      if (!observation) await beforeDispatch?.();
      const result = await run(
        ["exec", input.podName, "-n", input.namespace, "-c", "worker", "--", ...args],
        undefined,
        {
          timeoutMS: remainingMS,
          outputBytes: 4 * 1024 ** 2,
        },
      );
      if (
        !observation ||
        result.exitCode !== 1 ||
        result.stdout.trim() !== "" ||
        !/^resource temporarily unavailable(?:\r?\ncommand terminated with exit code 1)?\s*$/.test(
          result.stderr.trim(),
        )
      )
        return result;
      // An old native command can outlive Factory and its PostgreSQL lock.
      // Wait only through read-only observation. Never replay a mutation on
      // this error, and revalidate the original worker before each new read.
      await Bun.sleep(Math.max(0, Math.min(100, deadline - performance.now())));
      await inspectFactoryboxWorker(input, admitted, run, declaration);
    }
  }
  if (op.action === "start" || op.action === "fork") {
    // A native refusal can happen before the Sandbox record is published.
    // Observe capacity before marking Start attempted, so a known disk refusal
    // does not become an abandoned, unconfirmed mutation that cannot be stopped.
    const capacity = await invoke([...command, "capacity"], true);
    if (capacity.exitCode !== 0)
      throw new Error("Factorybox capacity could not be verified before dispatch");
    let value: unknown;
    try {
      value = JSON.parse(capacity.stdout);
    } catch {
      throw new Error("Factorybox capacity decision is invalid before dispatch");
    }
    requireFactoryboxWriteCapacity(admitted, op.action === "start" ? "Start" : "Fork", value);
  }
  if (op.action === "fork") {
    const source = await invoke([...command, "state", op.sourceSandboxID], true);
    if (source.exitCode !== 0)
      throw new Error(`Fork source observation is unconfirmed: ${source.stderr}`);
    const published = z.object({
      snapshot_id: token,
      checkpoint_sha256: digest.optional(),
      completed_at: z.string().optional(),
    });
    const selected = z
      .object({
        record: z.object({
          version: z.literal(1),
          id: z.literal(op.sourceSandboxID),
          owner: token,
          phase: z.enum(["running", "paused"]),
          shared_source: z.unknown().optional(),
          pause: published.optional(),
          pause_history: z.array(published).optional(),
        }),
      })
      .parse(JSON.parse(source.stdout)).record;
    const snapshots = [
      ...(selected.pause_history ?? []),
      ...(selected.pause ? [selected.pause] : []),
    ].filter((pause) => pause.snapshot_id === op.snapshotID);
    if (
      selected.owner !== op.sourceOwner ||
      selected.shared_source != null ||
      !snapshots.length ||
      snapshots.some(
        (pause) => !pause.completed_at || pause.checkpoint_sha256 !== op.checkpointSHA256,
      )
    )
      throw new Error("Fork source differs from its owned published private checkpoint");
  }
  const args = [...command, op.action];
  if (op.action === "start") args.push("--bundle", op.bundle);
  if (op.action === "fork") args.push("--source", op.sourceSandboxID);
  if (
    op.action === "pause" ||
    op.action === "resume" ||
    op.action === "fork" ||
    op.action === "retire-checkpoint" ||
    op.action === "retire-resume"
  )
    args.push("--snapshot-id", op.snapshotID);
  if (op.action === "retire-checkpoint" || op.action === "retire-resume")
    args.push("--source-owner", op.sourceOwner, "--checkpoint-sha256", op.checkpointSHA256);
  if (op.action === "retire-sandbox")
    args.push("--sandbox-owner", op.sandboxOwner, "--input-sha256", op.inputSHA256);
  if (op.action !== "capacity") args.push(op.sandboxID);
  // One invocation only. Lost output, nonzero exits and partial JSON retain the
  // original operation identity; they never authorize another Sandbox/epoch.
  const result = await invoke(args, op.action === "state" || op.action === "capacity");
  if (result.exitCode !== 0) return { confirmed: false as const, ...result };
  const output = JSON.parse(result.stdout) as {
    record?: {
      version?: number;
      id?: string;
      phase?: string;
      owner?: string;
      runtime_id?: string;
      fork?: { source_id?: string; checkpoint_id?: string; checkpoint_sha256?: string };
      pause?: { snapshot_id?: string; completed_at?: string; resume?: { completed_at?: string } };
    };
    root?: string;
  };
  if (op.action === "capacity") {
    if (output.root !== admitted.controllerRoot)
      throw new Error("Capacity response has a different controller");
  } else if (op.action === "retire-checkpoint" || op.action === "retire-resume") {
    readFactoryboxCheckpointRetirement(
      {
        source_id: op.sandboxID,
        snapshot_id: op.snapshotID,
        source_owner: op.sourceOwner,
        checkpoint_sha256: op.checkpointSHA256,
      },
      admitted.controllerRoot,
      output,
      op.action === "retire-resume" ? "resume-images" : undefined,
    );
  } else if (op.action === "retire-sandbox") {
    readFactoryboxBackingRetirement(
      { sandbox_id: op.sandboxID, sandbox_owner: op.sandboxOwner, input_sha256: op.inputSHA256 },
      admitted.controllerRoot,
      output,
    );
  } else {
    const record = output.record;
    const expectedPhase = {
      start: "running",
      fork: "running",
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
      op.action === "fork" &&
      (!record.owner ||
        !token.safeParse(record.owner).success ||
        record.owner === op.sourceOwner ||
        record.runtime_id !== `fbx-${record.owner}` ||
        record.fork?.source_id !== op.sourceSandboxID ||
        record.fork.checkpoint_id !== op.snapshotID ||
        record.fork.checkpoint_sha256 !== op.checkpointSHA256)
    )
      throw new Error("Fork response does not confirm its independent owner and exact checkpoint");
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
