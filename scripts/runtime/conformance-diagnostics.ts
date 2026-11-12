import { z } from "zod";

const podMetadata = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string(),
    uid: z.string().min(1),
    labels: z.record(z.string(), z.string()),
  }),
});

export async function preparationFailureDiagnostics(
  owner: string,
  namespace: string,
  podName: string,
  pod: unknown,
  run: (
    args: readonly string[],
    limits: { timeoutMS: number; outputBytes: number },
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>,
) {
  const original = podMetadata.parse(pod).metadata;
  if (
    original.name !== podName ||
    original.namespace !== namespace ||
    original.labels["factory.dev/conformance-owner"] !== owner
  )
    throw new Error("Preparation diagnostics refuse an unowned Pod");
  let logs: { stdout: string; stderr: string; exitCode: number } | { unavailable: true };
  try {
    logs = await run(["logs", podName, "-n", namespace, "-c", "worker", "--tail=100"], {
      timeoutMS: 2000,
      outputBytes: 32_768,
    });
    const current = await run(["get", "pod", podName, "-n", namespace, "-o", "json"], {
      timeoutMS: 2000,
      outputBytes: 256 * 1024,
    });
    if (
      current.exitCode !== 0 ||
      podMetadata.parse(JSON.parse(current.stdout)).metadata.uid !== original.uid
    )
      logs = { unavailable: true };
  } catch {
    logs = { unavailable: true };
  }
  return {
    owner,
    pod,
    logs,
    scope: "Owned preparation failure; original error/deadline unchanged",
  };
}
