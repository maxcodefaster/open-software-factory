import { z } from "zod";
import { runCommand } from "./command";
import { kubernetesCommand } from "./config";
import type { renderDeveloperIDEResources } from "./developer-ide-manifest";

type Resources = readonly ReturnType<typeof renderDeveloperIDEResources>[number][];
export interface DeveloperIDEKubernetesClient {
  apply(
    resources: Resources,
    expectedNamespace?: { ownerID: string; uid: string | null },
  ): Promise<{ namespaceUID: string }>;
  getNamespace(namespace: string): Promise<{ uid: string; labels: Record<string, string> } | null>;
}

export class DeveloperIDEObservationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeveloperIDEObservationUnavailableError";
  }
}

function readFailure(message: string) {
  const unavailable =
    /context deadline exceeded|timed out|i\/o timeout|TLS handshake timeout|Client\.Timeout|connection[^\n]*(?:refused|reset)|ECONNREFUSED|ECONNRESET|network is unreachable|no route to host|ServiceUnavailable|TooManyRequests/i;
  return unavailable.test(message)
    ? new DeveloperIDEObservationUnavailableError(`Developer IDE observation failed: ${message}`)
    : new Error(`Developer IDE observation failed: ${message}`);
}

async function kubectl(args: string[], input?: string) {
  return runCommand(kubernetesCommand(["--request-timeout=10s", ...args]), input);
}
const metadata = z.object({
  metadata: z.object({
    uid: z.string().min(1),
    labels: z.record(z.string(), z.string()).default({}),
  }),
});

// Only the independent editor is a Factory-owned Kubernetes Pod. Project
// execution and retained Source belong to their native Substrate owners.
export function createDeveloperIDEKubernetesClient(
  run: typeof kubectl = kubectl,
): DeveloperIDEKubernetesClient {
  async function getNamespace(namespace: string) {
    const result = await run(["get", "namespace", namespace, "-o", "json"]).catch(
      (cause: unknown) => {
        throw readFailure(cause instanceof Error ? cause.message : "Namespace read failed");
      },
    );
    if (result.exitCode !== 0) {
      if (result.stderr.includes("NotFound") || result.stderr.includes("not found")) return null;
      throw readFailure(result.stderr);
    }
    return metadata.parse(JSON.parse(result.stdout)).metadata;
  }
  return {
    getNamespace,
    async apply(resources, expectedNamespace) {
      const namespace = resources.find((resource) => resource.kind === "Namespace");
      const pod = resources.find((resource) => resource.kind === "Pod");
      if (
        resources.length !== 2 ||
        !namespace ||
        !pod ||
        !/^factory-editor-[a-f0-9]{32}$/.test(namespace.metadata.name) ||
        !/^editor-[1-9][0-9]*$/.test(pod.metadata.name) ||
        pod.metadata.namespace !== namespace.metadata.name ||
        namespace.metadata.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
        !namespace.metadata.labels["factory.dev/runtime-owner"]
      )
        throw new Error("Developer IDE requires its exact Namespace and editor Pod declaration");
      const ownerID = namespace.metadata.labels["factory.dev/runtime-owner"];
      const current = await getNamespace(namespace.metadata.name);
      let namespaceUID: string;
      if (current) {
        if (
          !expectedNamespace?.uid ||
          current.uid !== expectedNamespace.uid ||
          expectedNamespace.ownerID !== ownerID ||
          current.labels["factory.dev/runtime-owner"] !== ownerID ||
          current.labels["app.kubernetes.io/managed-by"] !== "open-software-factory"
        )
          throw new Error("Refusing to adopt a changed or unowned Developer IDE Namespace");
        namespaceUID = current.uid;
      } else {
        if (expectedNamespace?.uid)
          throw new Error("Recorded Developer IDE Namespace disappeared; refusing replacement");
        const created = await run(["create", "-f", "-", "-o", "json"], JSON.stringify(namespace));
        if (created.exitCode !== 0)
          throw new Error(`Developer IDE Namespace create failed: ${created.stderr}`);
        namespaceUID = metadata.parse(JSON.parse(created.stdout)).metadata.uid;
      }
      // The service observes and validates an existing Pod before calling here.
      // A concurrent/unknown Create is not permission to apply over another Pod.
      const created = await run(["create", "-f", "-", "-o", "json"], JSON.stringify(pod));
      if (created.exitCode !== 0)
        throw new Error(`Developer IDE Pod create outcome is unconfirmed: ${created.stderr}`);
      metadata.parse(JSON.parse(created.stdout));
      return { namespaceUID };
    },
  };
}
