import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import pins from "../../../deploy/substrate/pins.json";
import { runEnvironmentCommand } from "./command";
import { kubernetesCommand, kubernetesConnectionEnvironment } from "./config";
import {
  type NativeArchitecture,
  nativeArchitecture,
  pinnedNativeSandboxSpec,
} from "./substrate-profile";
import { kubernetesResourceQuantity, selectWorkerNodeResources } from "./worker-resource-admission";

const metadata = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  uid: z.uuid(),
  creationTimestamp: z.iso.datetime(),
  deletionTimestamp: z.string().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
});
const image = z.string().regex(/^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/);
const nativeCPUSchedulingQuantum = 250;
export const nativeCapacityPool = z.object({
  metadata,
  spec: z.strictObject({
    replicas: z.number().int().min(0),
    workerImage: image,
    sandboxClasses: z.tuple([
      z.strictObject({
        name: z.literal("gvisor"),
        configRef: z.strictObject({ name: z.literal(pins.gvisor.version) }),
      }),
    ]),
    template: z.strictObject({
      nodeSelector: z.record(z.string(), z.string()),
      labels: z.record(z.string(), z.string()).optional(),
      resources: z.object({
        requests: z.record(z.string(), z.string()),
        limits: z.record(z.string(), z.string()),
      }),
    }),
  }),
  status: z
    .object({ readyReplicas: z.number().int().optional(), replicas: z.number().int().optional() })
    .optional(),
});
export type NativeCapacityPool = z.infer<typeof nativeCapacityPool>;
export type NativeCapacityNode = {
  name: string;
  uid: string;
  bootID: string;
  hostname: string;
  architecture: NativeArchitecture;
  resources: { cpuMilli: number; memoryMiB: number };
};

export function nativeCapacityReadyReplicas(pool: NativeCapacityPool) {
  if (pool.spec.replicas <= 0) return 0;
  return Math.max(0, Math.min(pool.spec.replicas, pool.status?.readyReplicas ?? 0));
}

export function nativeCapacityReservedPoolResources(pool: NativeCapacityPool) {
  const { requests, limits } = pool.spec.template.resources;
  const cpuMilli = kubernetesResourceQuantity(requests["cpu"], "cpu");
  const memoryBytes = kubernetesResourceQuantity(requests["memory"], "memory");
  if (
    cpuMilli <= 0 ||
    memoryBytes <= 0 ||
    cpuMilli !== kubernetesResourceQuantity(limits["cpu"], "cpu") ||
    memoryBytes !== kubernetesResourceQuantity(limits["memory"], "memory")
  )
    return null;
  // Only fully reserved budgets are usable for admission. A bootstrap pool's
  // larger limit is not a reservation, and fractional MiB cannot be rounded up.
  return { cpuMilli, memoryMiB: Math.floor(memoryBytes / (1024 * 1024)) };
}

function capacityNodeReady(
  nodesInput: unknown,
  original: NativeCapacityNode,
  requireOriginalBoot: boolean,
) {
  const nodes = z
    .object({
      items: z.array(
        z.object({
          metadata: z.object({
            name: z.string(),
            uid: z.string(),
            deletionTimestamp: z.string().optional(),
            labels: z.record(z.string(), z.string()),
          }),
          spec: z
            .object({
              unschedulable: z.boolean().optional(),
              taints: z.array(z.unknown()).optional(),
            })
            .optional(),
          status: z.object({
            nodeInfo: z.object({
              bootID: z.string(),
              architecture: z.string(),
              operatingSystem: z.string(),
            }),
            conditions: z.array(z.object({ type: z.string(), status: z.string() })),
          }),
        }),
      ),
    })
    .parse(nodesInput).items;
  const node = nodes.find((value) => value.metadata.uid === original.uid);
  return Boolean(
    node &&
      node.metadata.name === original.name &&
      !node.metadata.deletionTimestamp &&
      node.metadata.labels["kubernetes.io/hostname"] === original.hostname &&
      node.metadata.labels["kubernetes.io/arch"] === original.architecture &&
      node.metadata.labels["kubernetes.io/os"] === "linux" &&
      node.status.nodeInfo.bootID &&
      (!requireOriginalBoot || node.status.nodeInfo.bootID === original.bootID) &&
      node.status.nodeInfo.architecture === original.architecture &&
      nativeArchitecture.safeParse(original.architecture).success &&
      node.status.nodeInfo.operatingSystem === "linux" &&
      !node.spec?.unschedulable &&
      !node.spec?.taints?.length &&
      node.status.conditions.some((c) => c.type === "Ready" && c.status === "True") &&
      !node.status.conditions.some(
        (c) =>
          ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) &&
          c.status !== "False",
      ),
  );
}

export function nativeCapacityNodeReady(nodesInput: unknown, original: NativeCapacityNode) {
  return capacityNodeReady(nodesInput, original, true);
}

// An acknowledged pool keeps its reservation across a node reboot. Its owner
// must still verify the original pool UID, profile, image and reserved budget.
// Only never-dispatched capacity needs the original boot's headroom observation.
export function nativeCapacityAdmittedNodeReady(nodesInput: unknown, original: NativeCapacityNode) {
  return capacityNodeReady(nodesInput, original, false);
}

export function nativeCapacityOriginalNode(
  nodesInput: unknown,
  pool: NativeCapacityPool,
  architecture: NativeArchitecture,
): NativeCapacityNode | null {
  const resources = nativeCapacityReservedPoolResources(pool);
  const hostname = pool.spec.template.nodeSelector["kubernetes.io/hostname"];
  if (!resources || !hostname) return null;
  const nodes = z
    .object({
      items: z.array(
        z.object({
          metadata: z.object({
            name: z.string(),
            uid: z.uuid(),
            labels: z.record(z.string(), z.string()),
          }),
          status: z.object({ nodeInfo: z.object({ bootID: z.string() }) }),
        }),
      ),
    })
    .parse(nodesInput).items;
  const node = nodes.find((value) => value.metadata.labels["kubernetes.io/hostname"] === hostname);
  if (!node?.status.nodeInfo.bootID) return null;
  const original: NativeCapacityNode = {
    name: node.metadata.name,
    uid: node.metadata.uid,
    hostname,
    bootID: node.status.nodeInfo.bootID,
    architecture,
    resources,
  };
  return nativeCapacityNodeReady(nodesInput, original) ? original : null;
}

export async function runNativeCapacityKubernetes(args: readonly string[], input?: string) {
  return runEnvironmentCommand(
    kubernetesCommand(["--request-timeout=10s", ...args]),
    kubernetesConnectionEnvironment(),
    {
      timeoutMS: 15000,
      outputBytes: 8 * 1024 * 1024,
    },
    input,
  );
}

export function nativeCapacityOwner(selector: Record<string, string>) {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(selector).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex")
    .slice(0, 32);
}

export function requireNativeCapacityBase(
  poolsInput: unknown,
  selector: Record<string, string>,
  architecture: NativeArchitecture,
) {
  const pools = z
    .object({ items: z.array(z.unknown()) })
    .parse(poolsInput)
    .items.map((value) => nativeCapacityPool.parse(value));
  const matching = pools.filter(
    (pool) =>
      !pool.metadata.labels["factory.dev/native-capacity"] &&
      Object.entries(selector).every(([key, value]) => pool.metadata.labels[key] === value),
  );
  const base = matching.length > 1 ? matching.filter((pool) => pool.spec.replicas > 0) : matching;
  if (base.length !== 1 || !base[0]?.metadata.namespace || base[0].metadata.deletionTimestamp)
    throw new Error("Native capacity requires its one original admitted WorkerPool");
  if (
    base[0].spec.template.nodeSelector["kubernetes.io/arch"] !==
      nativeArchitecture.parse(architecture) ||
    base[0].spec.template.nodeSelector["kubernetes.io/os"] !== "linux"
  )
    throw new Error("Original native WorkerPool differs from the installation architecture");
  return base[0];
}

export function requireNativeCapacitySandbox(value: unknown) {
  const config = z
    .object({ metadata: metadata.omit({ namespace: true }), spec: z.unknown() })
    .parse(value);
  const expected = pinnedNativeSandboxSpec();
  if (
    config.metadata.name !== pins.gvisor.version ||
    config.metadata.deletionTimestamp ||
    !isDeepStrictEqual(config.spec, expected)
  )
    throw new Error("Native capacity SandboxConfig differs from the admitted pinned profile");
  return config.metadata.uid;
}

export function nativeCapacityCandidates(
  nodesInput: unknown,
  podsInput: unknown,
  architecture: NativeArchitecture,
) {
  nativeArchitecture.parse(architecture);
  const nodes = z.object({ items: z.array(z.unknown()) }).parse(nodesInput).items;
  const pods = z
    .object({
      items: z.array(
        z
          .object({
            metadata: z.object({ uid: z.string() }).passthrough(),
            spec: z.object({ nodeName: z.string().optional() }).passthrough(),
          })
          .passthrough(),
      ),
    })
    .parse(podsInput).items;
  const candidates: NativeCapacityNode[] = [];
  const refused: Array<{ nodeName: string; reason: string }> = [];
  for (const input of nodes) {
    const node = z
      .object({
        metadata: z.object({
          name: z.string(),
          uid: z.uuid(),
          labels: z.record(z.string(), z.string()),
        }),
        status: z.object({ nodeInfo: z.object({ bootID: z.string().min(1) }) }),
      })
      .parse(input);
    try {
      const hostname = node.metadata.labels["kubernetes.io/hostname"];
      if (!hostname) throw new Error("Node hostname label is unavailable");
      if (
        node.metadata.labels["kubernetes.io/arch"] !== architecture ||
        node.metadata.labels["kubernetes.io/os"] !== "linux"
      )
        throw new Error("Node labels differ from the selected native Linux architecture");
      const resources = selectWorkerNodeResources(
        {
          nodeName: node.metadata.name,
          architecture,
          memoryHeadroomMiB: 2048,
          cpuRequestMilli: nativeCPUSchedulingQuantum,
        },
        input,
        { items: pods.filter((p) => p.spec.nodeName === node.metadata.name) },
      );
      // Unlike the legacy worker's smaller scheduling reservation, a native
      // pool requests its full budget. Leave the existing 250m reservation
      // quantum available for independent access services instead of making
      // even a 50m editor permanently unschedulable on every joined node.
      resources.cpuMilli -= nativeCPUSchedulingQuantum;
      if (resources.cpuMilli < nativeCPUSchedulingQuantum)
        throw new Error("No native worker CPU budget remains after access-service headroom");
      candidates.push({
        name: node.metadata.name,
        uid: node.metadata.uid,
        bootID: node.status.nodeInfo.bootID,
        hostname,
        architecture,
        resources,
      });
    } catch (error) {
      refused.push({
        nodeName: node.metadata.name,
        reason: error instanceof Error ? error.message : "Node observation is unavailable",
      });
    }
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return { candidates, refused };
}

export function renderNativeCapacityPool(
  base: NativeCapacityPool,
  node: NativeCapacityNode,
  selector: Record<string, string>,
  creationID: string,
) {
  z.uuid().parse(creationID);
  const namespace = base.metadata.namespace;
  if (!namespace) throw new Error("Native capacity requires its original WorkerPool namespace");
  if (
    base.spec.template.nodeSelector["kubernetes.io/arch"] !== node.architecture ||
    base.spec.template.nodeSelector["kubernetes.io/os"] !== "linux"
  )
    throw new Error("Native capacity pool cannot substitute another runtime architecture");
  const owner = nativeCapacityOwner(selector);
  const id = createHash("sha256").update(`${owner}:${node.uid}`).digest("hex").slice(0, 32);
  const labels = { ...selector, "factory.dev/native-capacity": owner };
  const cpu =
    node.resources.cpuMilli % 1000 === 0
      ? String(node.resources.cpuMilli / 1000)
      : `${node.resources.cpuMilli}m`;
  const memory =
    node.resources.memoryMiB % 1024 === 0
      ? `${node.resources.memoryMiB / 1024}Gi`
      : `${node.resources.memoryMiB}Mi`;
  return {
    apiVersion: "ate.dev/v1",
    kind: "WorkerPool",
    metadata: {
      name: `factory-native-${id}`,
      namespace,
      labels,
      annotations: { "factory.dev/creation-intent": creationID },
    },
    spec: {
      replicas: 1 as const,
      workerImage: base.spec.workerImage,
      sandboxClasses: base.spec.sandboxClasses,
      template: {
        labels,
        nodeSelector: {
          "kubernetes.io/hostname": node.hostname,
          "kubernetes.io/os": "linux",
          "kubernetes.io/arch": nativeArchitecture.parse(node.architecture),
        },
        resources: { requests: { cpu, memory }, limits: { cpu, memory } },
      },
    },
  };
}

export function requireNativeCapacityPool(
  actualInput: unknown,
  intended: ReturnType<typeof renderNativeCapacityPool>,
  attemptedAt: string,
  originalUID?: string,
) {
  const actual = nativeCapacityPool.parse(actualInput);
  const normalized = (spec: NativeCapacityPool["spec"]) => ({
    ...spec,
    template: {
      ...spec.template,
      resources: Object.fromEntries(
        (["requests", "limits"] as const).map((kind) => [
          kind,
          {
            cpu: kubernetesResourceQuantity(spec.template.resources[kind]?.["cpu"], "cpu"),
            memory: kubernetesResourceQuantity(spec.template.resources[kind]?.["memory"], "memory"),
          },
        ]),
      ),
    },
  });
  if (
    actual.metadata.name !== intended.metadata.name ||
    actual.metadata.namespace !== intended.metadata.namespace ||
    actual.metadata.deletionTimestamp ||
    (originalUID && actual.metadata.uid !== originalUID) ||
    Math.floor(Date.parse(actual.metadata.creationTimestamp) / 1000) <
      Math.floor(Date.parse(attemptedAt) / 1000) ||
    actual.metadata.annotations["factory.dev/creation-intent"] !==
      intended.metadata.annotations["factory.dev/creation-intent"] ||
    !isDeepStrictEqual(actual.metadata.labels, intended.metadata.labels) ||
    !isDeepStrictEqual(normalized(actual.spec), normalized(intended.spec))
  )
    throw new Error("Native capacity WorkerPool differs from its original creation intent");
  return actual;
}
