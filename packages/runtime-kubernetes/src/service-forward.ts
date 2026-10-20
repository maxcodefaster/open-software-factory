import { resolve } from "node:path";
import { z } from "zod";

// Match kubectl's normal Pod-running/forwarding startup window. This covers
// process bootstrap as well as establishing the approved Kubernetes connection.
export const serviceForwardTimeoutMS = 60_000;

export function startServiceForward(role: "source" | "editor", namespace: string, podName: string) {
  const label = role === "source" ? "Source" : "Developer IDE";
  const ready = Promise.withResolvers<string>();
  const cancel = new AbortController();
  // A caller can still be validating its exact resource before awaiting the
  // endpoint. Keep rejection observable there without an unhandled rejection.
  void ready.promise.catch(() => {});
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(
        import.meta.dir,
        role === "source" ? "source-forward.ts" : "developer-ide-forward.ts",
      ),
      namespace,
      podName,
    ],
    {
      env: {
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        KUBECONFIG: process.env["KUBECONFIG"],
        FACTORY_KUBERNETES_CONTEXT: process.env["FACTORY_KUBERNETES_CONTEXT"],
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ipc(message: unknown) {
        const result = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(message);
        if (!result.success) return;
        clearTimeout(timer);
        ready.resolve(`http://127.0.0.1:${result.data.port}`);
      },
    },
  );
  const timer = setTimeout(() => {
    child.kill();
    ready.reject(new Error(`${label} connection exceeded its deadline`));
  }, serviceForwardTimeoutMS);
  void child.exited.then(() => {
    clearTimeout(timer);
    cancel.abort();
    ready.reject(new Error(`${label} connection closed`));
  });
  return { child, endpoint: ready.promise, cancel };
}
