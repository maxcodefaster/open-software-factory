import { z } from "zod";
import type { runCommand } from "./command";
import { selectFactoryboxWorkerResources } from "./factorybox-resource-admission";
import { type FactoryboxRuntimeProfile, factoryboxRuntimeProfile } from "./factorybox-runtime";
import { runFactoryboxKubernetes } from "./factorybox-worker";

export const factoryboxNodeIdentity = z.strictObject({
  uid: z.string().min(1),
  bootID: z.string().min(1),
  architecture: z.enum(["amd64", "arm64"]),
  operatingSystem: z.literal("linux"),
});

export type FactoryboxNodeCandidate = {
  nodeName: string;
  identity: z.infer<typeof factoryboxNodeIdentity>;
  profile: FactoryboxRuntimeProfile;
  podObservations?: ReadonlyArray<{ uid: string; phase: string; ready: boolean }>;
};

export function discoverFactoryboxNodes(
  configured: FactoryboxRuntimeProfile,
  nodesInput: unknown,
  podsInput: unknown,
  ownedPodUIDs: readonly string[] = [],
) {
  const nodes = z.object({ items: z.array(z.unknown()) }).parse(nodesInput).items;
  const pods = z
    .object({
      items: z.array(
        z
          .object({
            metadata: z.object({ uid: z.string().optional() }).optional(),
            spec: z.object({ nodeName: z.string().optional() }).passthrough(),
          })
          .passthrough(),
      ),
    })
    .parse(podsInput).items;
  const candidates: FactoryboxNodeCandidate[] = [];
  const refused: Array<{ nodeName: string; reason: string }> = [];
  for (const input of nodes) {
    const name = z.object({ metadata: z.object({ name: z.string() }) }).parse(input).metadata.name;
    try {
      const node = z
        .object({
          metadata: z.object({ uid: z.string().min(1) }),
          status: z.object({ nodeInfo: factoryboxNodeIdentity.omit({ uid: true }).strip() }),
        })
        .parse(input);
      if (node.status.nodeInfo.architecture !== configured.architecture)
        throw new Error("No pinned Factorybox bundle for the node architecture");
      const profile = factoryboxRuntimeProfile.parse({
        ...configured,
        nodeName: name,
        retainedStore: undefined,
        resources: undefined,
        resourceAdmission: configured.resourceAdmission ?? { memoryHeadroomMiB: 2048 },
      });
      const resources = selectFactoryboxWorkerResources(profile, input, {
        items: pods.filter(
          (pod) => pod.spec.nodeName === name && !ownedPodUIDs.includes(pod.metadata?.uid ?? ""),
        ),
      });
      // A native worker still checks pages, cgroups, namespaces, mounts, Sysbox
      // and CRIU before any Sandbox Start. Node labels cannot bypass that gate.
      candidates.push({
        nodeName: name,
        identity: { uid: node.metadata.uid, ...node.status.nodeInfo },
        profile: { ...profile, resources },
        podObservations: pods
          .filter((pod) => pod.spec.nodeName === name && pod.metadata?.uid)
          .map((pod) => {
            const status = z
              .object({
                phase: z.string().optional(),
                conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
              })
              .parse(pod["status"] ?? {});
            return {
              uid: pod.metadata?.uid ?? "",
              phase: status.phase ?? "Unknown",
              ready:
                status.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
            };
          }),
      });
    } catch (cause) {
      refused.push({
        nodeName: name,
        reason: cause instanceof Error ? cause.message : "Node observation is invalid",
      });
    }
  }
  candidates.sort((a, b) => a.nodeName.localeCompare(b.nodeName));
  return { candidates, refused };
}

export async function observeFactoryboxNodes(
  configured: FactoryboxRuntimeProfile,
  run: typeof runCommand = runFactoryboxKubernetes,
  ownedPodUIDs: readonly string[] = [],
) {
  const [nodes, pods] = await Promise.all([
    run(["get", "nodes", "-o", "json"]),
    run(["get", "pods", "--all-namespaces", "-o", "json"]),
  ]);
  if (nodes.exitCode !== 0 || pods.exitCode !== 0)
    throw new Error(
      "Verification worker discovery requires current Kubernetes nodes and reservations",
    );
  return discoverFactoryboxNodes(
    configured,
    JSON.parse(nodes.stdout),
    JSON.parse(pods.stdout),
    ownedPodUIDs,
  );
}

export async function requireOriginalFactoryboxNode(
  nodeName: string,
  identityInput: unknown,
  run: typeof runCommand = runFactoryboxKubernetes,
) {
  const identity = factoryboxNodeIdentity.parse(identityInput);
  const result = await run(["get", "node", nodeName, "-o", "json"]);
  if (result.exitCode !== 0) throw new Error("Original Verification worker node is unavailable");
  const node = z
    .object({
      metadata: z.object({ name: z.literal(nodeName), uid: z.literal(identity.uid) }),
      spec: z
        .object({ unschedulable: z.boolean().optional(), taints: z.array(z.unknown()).optional() })
        .optional(),
      status: z.object({
        nodeInfo: factoryboxNodeIdentity.omit({ uid: true }).strip(),
        conditions: z.array(z.object({ type: z.string(), status: z.string() })),
      }),
    })
    .parse(JSON.parse(result.stdout));
  if (
    JSON.stringify(node.status.nodeInfo) !==
    JSON.stringify(factoryboxNodeIdentity.omit({ uid: true }).strip().parse(identity))
  )
    throw new Error("Original Verification worker node boot or architecture changed");
  if (
    node.spec?.unschedulable ||
    node.spec?.taints?.length ||
    !node.status.conditions.some((c) => c.type === "Ready" && c.status === "True") ||
    node.status.conditions.some(
      (c) =>
        ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status !== "False",
    )
  )
    throw new Error("Original Verification worker node is not Ready and schedulable");
}
