import { z } from "zod";
import type { runCommand } from "./command";
import type { FactoryboxRuntimeProfile } from "./factorybox-runtime";
import { factoryboxWorkerResources, runFactoryboxKubernetes } from "./factorybox-worker";

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
function quantity(value: string | number | undefined, resource: "cpu" | "memory") {
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

function requestedMemory(item: z.infer<typeof pod>) {
  const allocated = new Map(
    [...(item.status?.containerStatuses ?? []), ...(item.status?.initContainerStatuses ?? [])].map(
      (status) => [status.name, status.allocatedResources?.["memory"]],
    ),
  );
  const memory = (value: z.infer<typeof container>) =>
    Math.max(
      quantity(value.resources?.requests?.["memory"], "memory"),
      quantity(allocated.get(value.name), "memory"),
    );
  let sidecars = 0;
  let peakInit = 0;
  for (const value of item.spec.initContainers ?? []) {
    const request = memory(value);
    if (value.restartPolicy === "Always") sidecars += request;
    peakInit = Math.max(peakInit, sidecars + (value.restartPolicy === "Always" ? 0 : request));
  }
  const containers = item.spec.containers.reduce((sum, value) => sum + memory(value), sidecars);
  // Pod-level requests are also a scheduling reservation. Taking the maximum
  // retains container/resize reservations rather than undercounting them.
  return (
    Math.max(peakInit, containers, quantity(item.spec.resources?.requests?.["memory"], "memory")) +
    quantity(item.spec.overhead?.["memory"], "memory")
  );
}

export function selectFactoryboxWorkerResources(
  profile: FactoryboxRuntimeProfile,
  nodeInput: unknown,
  podsInput: unknown,
) {
  const policy = profile.resourceAdmission;
  if (!policy) throw new Error("Automatic worker resource admission is not configured");
  const node = z
    .object({
      metadata: z.object({ name: z.literal(profile.nodeName), uid: z.string().min(1) }),
      spec: z.object({ unschedulable: z.boolean().optional() }).optional(),
      status: z.object({
        allocatable: quantities,
        nodeInfo: z.object({
          architecture: z.literal(profile.architecture),
          kernelVersion: z.literal(profile.kernel),
          operatingSystem: z.literal("linux"),
        }),
        conditions: z.array(z.object({ type: z.string(), status: z.string() })),
      }),
    })
    .parse(nodeInput);
  if (
    node.spec?.unschedulable ||
    !node.status.conditions.some((item) => item.type === "Ready" && item.status === "True") ||
    node.status.conditions.some(
      (item) =>
        ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(item.type) &&
        item.status !== "False",
    )
  )
    throw new Error("Worker node is not ready for resource admission");
  const pods = z.object({ items: z.array(pod) }).parse(podsInput).items;
  let requested = 0;
  for (const item of pods) {
    if (item.spec.nodeName !== profile.nodeName)
      throw new Error("Worker resource observation includes another node");
    // Terminating Pods still hold resources until they actually exit.
    if (item.status?.phase === "Failed" || item.status?.phase === "Succeeded") continue;
    requested += requestedMemory(item);
    if (!Number.isSafeInteger(requested))
      throw new Error("Node memory requests exceed safe admission accounting");
  }
  const memory = quantity(node.status.allocatable["memory"], "memory");
  const cpuMilli = quantity(node.status.allocatable["cpu"], "cpu");
  const memoryMiB = Math.floor((memory - requested) / 1024 ** 2) - policy.memoryHeadroomMiB;
  if (memoryMiB <= 0 || cpuMilli < (profile.cpuRequestMilli ?? 3000))
    throw new Error("No schedulable worker budget remains after node requests and headroom");
  return factoryboxWorkerResources.parse({ cpuMilli, memoryMiB });
}

export async function admitFactoryboxWorkerResources(
  profile: FactoryboxRuntimeProfile,
  run: typeof runCommand = runFactoryboxKubernetes,
): Promise<FactoryboxRuntimeProfile> {
  if (!profile.resourceAdmission || profile.resources) return profile;
  const [node, pods] = await Promise.all([
    run(["get", "node", profile.nodeName, "-o", "json"]),
    run([
      "get",
      "pods",
      "--all-namespaces",
      "--field-selector",
      `spec.nodeName=${profile.nodeName}`,
      "-o",
      "json",
    ]),
  ]);
  if (node.exitCode !== 0 || pods.exitCode !== 0)
    throw new Error("Worker resource admission requires a current node and Pod observation");
  return {
    ...profile,
    resources: selectFactoryboxWorkerResources(
      profile,
      JSON.parse(node.stdout),
      JSON.parse(pods.stdout),
    ),
  };
}
