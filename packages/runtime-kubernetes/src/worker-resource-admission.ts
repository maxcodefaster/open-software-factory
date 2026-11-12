import { z } from "zod";

const quantities = z.record(z.string(), z.union([z.string(), z.number()]));
const container = z.object({
  name: z.string(),
  restartPolicy: z.string().optional(),
  resources: z.object({ requests: quantities.optional() }).optional(),
});
const pod = z.object({
  metadata: z.object({ deletionTimestamp: z.string().optional() }).optional(),
  spec: z.object({
    nodeName: z.string().optional(),
    containers: z.array(container),
    initContainers: z.array(container).optional(),
    overhead: quantities.optional(),
    resources: z.object({ requests: quantities.optional() }).optional(),
  }),
  status: z
    .object({
      phase: z.string().optional(),
      allocatedResources: quantities.optional(),
      containerStatuses: z
        .array(z.object({ name: z.string(), allocatedResources: quantities.optional() }))
        .optional(),
      initContainerStatuses: z
        .array(z.object({ name: z.string(), allocatedResources: quantities.optional() }))
        .optional(),
    })
    .optional(),
});

// CPU is counted in millicores and memory in bytes. Round fractional requests
// upward, as the scheduler does, instead of treating absent usage as capacity.
export function kubernetesResourceQuantity(
  value: string | number | undefined,
  resource: "cpu" | "memory",
) {
  if (value === undefined) return 0;
  if (String(value).length > 128)
    throw new Error("Kubernetes resource quantity exceeds admission input bounds");
  const match = /^(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+|[numkMGTPE]|[KMGTPE]i)?$/.exec(String(value));
  if (!match) throw new Error(`Invalid Kubernetes ${resource} resource quantity`);
  const suffix = match[2] ?? "";
  const exponents: Record<string, number> = {
    "": 0,
    n: -9,
    u: -6,
    m: -3,
    k: 3,
    M: 6,
    G: 9,
    T: 12,
    P: 15,
    E: 18,
  };
  const binary = suffix.endsWith("i") ? "KMGTPE".indexOf(suffix[0] ?? "") + 1 : 0;
  const exponent = binary
    ? 0
    : /^[eE][+-]?\d+$/.test(suffix)
      ? Number(suffix.slice(1))
      : exponents[suffix];
  if (exponent === undefined || Math.abs(exponent) > 1024)
    throw new Error("Kubernetes resource exponent exceeds admission input bounds");
  const [whole = "", fraction = ""] = (match[1] ?? "").split(".");
  // Decimal fractions must not disappear through floating-point rounding.
  let numerator = BigInt(whole + fraction) * 1024n ** BigInt(binary);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator *= 10n ** BigInt(-exponent);
  if (resource === "cpu") numerator *= 1000n;
  const result = (numerator + denominator - 1n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`Kubernetes ${resource} quantity exceeds safe admission accounting`);
  return Number(result);
}

function requestedResource(item: z.infer<typeof pod>, resource: "cpu" | "memory") {
  const allocated = new Map(
    [...(item.status?.containerStatuses ?? []), ...(item.status?.initContainerStatuses ?? [])].map(
      (status) => [status.name, status.allocatedResources?.[resource]],
    ),
  );
  const request = (value: z.infer<typeof container>) =>
    Math.max(
      kubernetesResourceQuantity(value.resources?.requests?.[resource], resource),
      kubernetesResourceQuantity(allocated.get(value.name), resource),
    );
  let sidecars = 0;
  let peakInit = 0;
  for (const value of item.spec.initContainers ?? []) {
    const amount = request(value);
    if (value.restartPolicy === "Always") sidecars += amount;
    peakInit = Math.max(peakInit, sidecars + (value.restartPolicy === "Always" ? 0 : amount));
  }
  const containers = item.spec.containers.reduce((sum, value) => sum + request(value), sidecars);
  // Pod-level requests are also a scheduling reservation. Taking the maximum
  // retains container/resize reservations rather than undercounting them.
  return (
    Math.max(
      peakInit,
      containers,
      kubernetesResourceQuantity(item.spec.resources?.requests?.[resource], resource),
      kubernetesResourceQuantity(item.status?.allocatedResources?.[resource], resource),
    ) + kubernetesResourceQuantity(item.spec.overhead?.[resource], resource)
  );
}

export function selectWorkerNodeResources(
  policy: {
    nodeName: string;
    architecture: "amd64" | "arm64";
    memoryHeadroomMiB: number;
    cpuRequestMilli: number;
  },
  nodeInput: unknown,
  podsInput: unknown,
) {
  if (
    !Number.isSafeInteger(policy.memoryHeadroomMiB) ||
    policy.memoryHeadroomMiB < 0 ||
    !Number.isSafeInteger(policy.cpuRequestMilli) ||
    policy.cpuRequestMilli <= 0
  )
    throw new Error("Worker resource admission requires finite headroom and CPU reservation");
  const node = z
    .object({
      metadata: z.object({
        name: z.literal(policy.nodeName),
        uid: z.string().min(1),
        deletionTimestamp: z.string().optional(),
      }),
      spec: z
        .object({
          unschedulable: z.boolean().optional(),
          taints: z.array(z.object({ key: z.string(), effect: z.string() })).optional(),
        })
        .optional(),
      status: z.object({
        allocatable: quantities,
        nodeInfo: z.object({
          architecture: z.literal(policy.architecture),
          operatingSystem: z.literal("linux"),
        }),
        conditions: z.array(z.object({ type: z.string(), status: z.string() })),
      }),
    })
    .parse(nodeInput);
  if (
    node.metadata.deletionTimestamp ||
    node.spec?.unschedulable ||
    !node.status.conditions.some((item) => item.type === "Ready" && item.status === "True") ||
    node.status.conditions.some(
      (item) =>
        ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(item.type) &&
        item.status !== "False",
    )
  )
    throw new Error("Worker node is not ready for resource admission");
  // The worker declares no scheduling tolerations. In particular, cluster
  // membership does not authorize taking a reserved or maintenance node.
  // Respect soft reservations too rather than filling them via node selection.
  const taint = node.spec?.taints?.[0];
  if (taint) throw new Error(`Worker node is reserved by taint ${taint.key} (${taint.effect})`);
  const pods = z.object({ items: z.array(pod) }).parse(podsInput).items;
  let requested = 0;
  let requestedCPU = 0;
  for (const item of pods) {
    if (item.spec.nodeName !== policy.nodeName)
      throw new Error("Worker resource observation includes another node");
    // Terminating Pods still hold resources until they actually exit.
    if (item.status?.phase === "Failed" || item.status?.phase === "Succeeded") continue;
    requested += requestedResource(item, "memory");
    requestedCPU += requestedResource(item, "cpu");
    if (!Number.isSafeInteger(requested) || !Number.isSafeInteger(requestedCPU))
      throw new Error("Node resource requests exceed safe admission accounting");
  }
  const memory = kubernetesResourceQuantity(node.status.allocatable["memory"], "memory");
  const cpuMilli = kubernetesResourceQuantity(node.status.allocatable["cpu"], "cpu") - requestedCPU;
  const memoryMiB = Math.floor((memory - requested) / 1024 ** 2) - policy.memoryHeadroomMiB;
  if (memoryMiB <= 0 || cpuMilli < policy.cpuRequestMilli)
    throw new Error("No schedulable worker budget remains after node requests and headroom");
  return z
    .strictObject({
      cpuMilli: z.number().int().positive().safe(),
      memoryMiB: z
        .number()
        .int()
        .positive()
        .safe()
        .max(Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2)),
    })
    .parse({ cpuMilli, memoryMiB });
}
