import { z } from "zod";
import type { runCommand } from "./command";
import { factoryboxKernelMatches } from "./factorybox-kernel";
import type { FactoryboxRuntimeProfile } from "./factorybox-runtime";
import { runFactoryboxKubernetes } from "./factorybox-worker";
import { selectWorkerNodeResources } from "./worker-resource-admission";

export function selectFactoryboxWorkerResources(
  profile: FactoryboxRuntimeProfile,
  nodeInput: unknown,
  podsInput: unknown,
) {
  const policy = profile.resourceAdmission;
  if (!policy) throw new Error("Automatic worker resource admission is not configured");
  z.object({
    status: z.object({
      nodeInfo: z.object({
        kernelVersion: z
          .string()
          .refine((value) => factoryboxKernelMatches(profile.kernel, value), {
            message: "Worker node kernel is outside the admitted kernel policy",
          }),
      }),
    }),
  }).parse(nodeInput);
  return selectWorkerNodeResources(
    {
      nodeName: profile.nodeName,
      architecture: profile.architecture,
      memoryHeadroomMiB: policy.memoryHeadroomMiB,
      cpuRequestMilli: profile.cpuRequestMilli ?? 3000,
    },
    nodeInput,
    podsInput,
  );
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
