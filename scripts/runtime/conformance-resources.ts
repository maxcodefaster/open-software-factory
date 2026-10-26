import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { conformanceLabel, ownedConformanceNamespace } from "./factorybox-conformance";

// Explicit cleanup of completed owned fixtures only. A live or unresolved
// worker/store is evidence, not an invitation to erase a failed acceptance run.
if (import.meta.main) {
  const run = async (args: string[], input?: string) => {
    const result = await runCommand(kubernetesCommand(["--request-timeout=10s", ...args]), input);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout || "{}");
  };
  const namespaces = await run(["get", "namespace", "-l", conformanceLabel, "-o", "json"]);
  for (const namespace of namespaces.items) {
    const owner = namespace.metadata.labels[conformanceLabel];
    const original = ownedConformanceNamespace(namespace, owner);
    if (namespace.metadata.annotations?.["factory.dev/conformance-evidence"] === "retained")
      throw new Error(
        `Retain ${original.name}: its private store contains unresolved native evidence`,
      );
    const pods = await run(["get", "pods", "-n", original.name, "-o", "json"]);
    if (
      pods.items.some((pod: { status?: { phase?: string } }) => pod.status?.phase !== "Succeeded")
    )
      throw new Error(
        `Retain ${original.name}: its original worker has not confirmed clean shutdown`,
      );
    await run(
      ["delete", "--raw", `/api/v1/namespaces/${original.name}`, "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: original.uid },
      }),
    );
  }
}
