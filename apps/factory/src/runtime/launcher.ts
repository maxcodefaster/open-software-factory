import {
  requireRuntimePodArtifacts,
  type KubernetesClient,
} from "../../../../packages/runtime-kubernetes/src/client";
import type { FactoryboxRuntimeProfile } from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";

export type RuntimeLaunchInput = {
  resources: readonly unknown[];
  namespace: string;
  podName: string;
  missingPodMessage: string;
  runtimeHostImage: string;
  factoryboxProfile: FactoryboxRuntimeProfile;
  expectedNamespace?: { ownerID: string; uid: string | null };
};

export type RuntimeLaunchPorts = {
  kubernetes: Pick<KubernetesClient, "apply" | "getPod">;
  transitionObserved(podUID: string, namespaceUID: string): Promise<boolean>;
  observe(): Promise<void>;
  fail(phase: "create" | "observe", cause: unknown): Promise<void>;
};

export async function launchRuntimeResources(input: RuntimeLaunchInput, ports: RuntimeLaunchPorts) {
  try {
    const applied = await ports.kubernetes.apply(input.resources, input.expectedNamespace);
    const pod = await ports.kubernetes.getPod(input.namespace, input.podName);
    if (!pod) throw new Error(input.missingPodMessage);
    requireRuntimePodArtifacts(
      pod,
      applied.workerRuntimeHostImage ?? input.runtimeHostImage,
      input.factoryboxProfile.image,
    );
    if (await ports.transitionObserved(pod.uid, applied.namespaceUID)) {
      void ports.observe().catch((cause) => ports.fail("observe", cause));
    }
  } catch (cause) {
    await ports.fail("create", cause);
    throw cause;
  }
}
