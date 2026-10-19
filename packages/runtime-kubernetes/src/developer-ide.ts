import { resolve } from "node:path";
import { z } from "zod";
import { kubernetesCommand } from "./config";
import { createKubernetesClient, type KubernetesClient } from "./client";
import { renderDeveloperIDEResources, type DeveloperIDEResources } from "./developer-ide-manifest";

const metadata = z.object({
  uid: z.string().min(1),
  labels: z.record(z.string(), z.string()).default({}),
});
const podSchema = z.object({
  metadata,
  spec: z.object({ containers: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
  status: z
    .object({
      phase: z.string(),
      conditions: z.array(z.object({ type: z.string(), status: z.string() })).default([]),
    })
    .optional(),
});
export interface DeveloperIDEObservation {
  readonly namespaceUID: string;
  readonly podUID: string;
  readonly ready: boolean;
  readonly failed: boolean;
}
export interface DeveloperIDEClient {
  prepare(input: DeveloperIDEResources): Promise<DeveloperIDEObservation>;
  observe(input: DeveloperIDEResources): Promise<DeveloperIDEObservation | null>;
  endpoint(input: DeveloperIDEResources): Promise<string>;
  stop(input: DeveloperIDEResources): Promise<void>;
  close(): void;
}

function intendedFields(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => intendedFields(actual[index], item))
    );
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) return false;
    return Object.entries(expected).every(([key, value]) =>
      key in actual ? intendedFields(Reflect.get(actual, key), value) : value === false,
    );
  }
  return actual === expected;
}
export class DeveloperIDEIntentConflict extends Error {}

function namespaceOwner(
  input: DeveloperIDEResources,
  namespace: { uid: string; labels: Record<string, string> },
) {
  if (
    namespace.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    namespace.labels["factory.dev/runtime-owner"] !== input.identity.userID ||
    (input.namespaceUID && input.namespaceUID !== namespace.uid)
  )
    throw new DeveloperIDEIntentConflict("Developer IDE namespace ownership differs from intent");
}
export function validateDeveloperIDEObservation(
  input: DeveloperIDEResources,
  namespace: { uid: string; labels: Record<string, string> },
  raw: unknown,
): DeveloperIDEObservation {
  namespaceOwner(input, namespace);
  const pod = podSchema.parse(raw);
  const intended = renderDeveloperIDEResources(input).find((item) => item.kind === "Pod");
  if (
    !intended ||
    !intendedFields(pod.metadata.labels, intended.metadata.labels) ||
    !intendedFields(pod.spec, intended.spec) ||
    (input.podUID && pod.metadata.uid !== input.podUID) ||
    (Array.isArray(pod.spec["initContainers"]) && pod.spec["initContainers"].length !== 0) ||
    pod.spec.containers.some((container) =>
      ["command", "args", "env", "envFrom"].some(
        (key) =>
          container[key] !== undefined &&
          (!Array.isArray(container[key]) || container[key].length !== 0),
      ),
    )
  )
    throw new DeveloperIDEIntentConflict("Developer IDE Pod differs from persisted intent");
  return {
    namespaceUID: namespace.uid,
    podUID: pod.metadata.uid,
    ready:
      pod.status?.conditions.some((item) => item.type === "Ready" && item.status === "True") ??
      false,
    failed: pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded",
  };
}

async function command(args: string[], input?: unknown) {
  const {
    stdout: output,
    stderr: error,
    exitCode: status,
  } = await runCommand(
    kubernetesCommand(["--request-timeout=10s", ...args]),
    input === undefined ? undefined : JSON.stringify(input),
  );
  if (status !== 0) {
    if (error.includes("NotFound") || error.includes("not found")) return null;
    throw new Error("Developer IDE infrastructure command failed");
  }
  return output;
}

export function createDeveloperIDEClient(
  kubernetes: KubernetesClient = createKubernetesClient(),
  execute: typeof command = command,
): DeveloperIDEClient {
  const forwards = new Map<
    string,
    { child: ReturnType<typeof Bun.spawn>; endpoint: Promise<string> }
  >();
  async function observe(input: DeveloperIDEResources) {
    const [namespace, raw] = await Promise.all([
      kubernetes.getNamespace(input.identity.namespace),
      execute(["get", "pod", input.identity.podName, "-n", input.identity.namespace, "-o", "json"]),
    ]);
    if (namespace) namespaceOwner(input, namespace);
    if (!raw || !namespace) return null;
    return validateDeveloperIDEObservation(input, namespace, JSON.parse(raw));
  }
  function disconnect(input: DeveloperIDEResources) {
    const key = input.identity.serviceID;
    const retained = forwards.get(key);
    if (retained) {
      retained.child.kill();
      forwards.delete(key);
    }
  }
  return {
    observe,
    async prepare(input) {
      const namespace = await kubernetes.getNamespace(input.identity.namespace);
      if (namespace) namespaceOwner(input, namespace);
      const existing = await observe(input);
      if (existing) return existing;
      // Never apply over an observed Pod. Recover only the deterministic, fully validated identity.
      await kubernetes.apply(
        renderDeveloperIDEResources(input),
        namespace ? { ownerID: input.identity.userID, uid: namespace.uid } : undefined,
      );
      const created = await observe(input);
      if (!created) throw new Error("Developer IDE create outcome is not yet observed");
      return created;
    },
    async endpoint(input) {
      if (!input.podUID) throw new Error("Developer IDE Pod outcome has not been recorded");
      const key = input.identity.serviceID;
      const retained = forwards.get(key);
      if (retained) return retained.endpoint;
      if (!(await observe(input))?.ready) throw new Error("Developer IDE is not ready");
      const ready = Promise.withResolvers<string>();
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "developer-ide-forward.ts"),
          input.identity.namespace,
          input.identity.podName,
        ],
        {
          env: {
            PATH: process.env["PATH"],
            HOME: process.env["HOME"],
            KUBECONFIG: process.env["KUBECONFIG"],
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          ipc(message: unknown) {
            const result = z
              .object({ port: z.number().int().min(1).max(65535) })
              .safeParse(message);
            if (result.success) {
              clearTimeout(timer);
              ready.resolve(`http://127.0.0.1:${result.data.port}`);
            }
          },
        },
      );
      const timer = setTimeout(() => {
        child.kill();
        ready.reject(new Error("Developer IDE connection exceeded its deadline"));
      }, 10_000);
      const pending = { child, endpoint: ready.promise };
      forwards.set(key, pending);
      void child.exited.then(() => {
        clearTimeout(timer);
        ready.reject(new Error("Developer IDE connection closed"));
        if (forwards.get(key) === pending) forwards.delete(key);
      });
      return ready.promise;
    },
    async stop(input) {
      disconnect(input);
      const existing = await observe(input).catch((cause: unknown) => {
        // An incompatible resource at this name cannot be the unrecorded create.
        // Confirm only our intent is absent; never delete or adopt the other Pod.
        if (cause instanceof DeveloperIDEIntentConflict && !input.podUID) return null;
        throw cause;
      });
      if (!existing) return;
      await execute(
        [
          "delete",
          "--raw",
          `/api/v1/namespaces/${input.identity.namespace}/pods/${input.identity.podName}`,
          "-f",
          "-",
        ],
        {
          apiVersion: "v1",
          kind: "DeleteOptions",
          gracePeriodSeconds: 0,
          preconditions: { uid: existing.podUID },
        },
      );
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        if (!(await observe(input))) return;
        await Bun.sleep(100);
      }
      throw new Error("Developer IDE Pod deletion remains pending");
    },
    close() {
      for (const forward of forwards.values()) forward.child.kill();
      forwards.clear();
    },
  };
}
import { runCommand } from "./command";
