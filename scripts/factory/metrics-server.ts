import { resolve } from "node:path";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";

type Command = (args: string[], options?: { quiet?: boolean }) => Promise<unknown>;
export async function ensureLocalMetricsServer(command: Command) {
  const result = Bun.spawn(
    kubernetesCommand(["get", "apiservice", "v1beta1.metrics.k8s.io", "-o", "json"]),
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, error, status] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  if (status === 0) return; // Existing cluster monitoring is not Factory-owned.
  if (!error.includes("NotFound")) throw new Error("Cannot inspect cluster metrics service");
  await command(
    kubernetesCommand([
      "apply",
      "-f",
      resolve(import.meta.dir, "../../deploy/metrics-server/components.yaml"),
    ]),
    { quiet: true },
  );
}
