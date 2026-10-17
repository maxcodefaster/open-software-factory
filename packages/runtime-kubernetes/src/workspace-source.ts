import { z } from "zod";
import { kubernetesCommand } from "./config";
import { resolve } from "node:path";
import { createKubernetesClient, type KubernetesClient } from "./client";
import { renderWorkspaceSourceResources, type WorkspaceSourceManifest } from "./source-manifest";

const metadata = z.object({
  uid: z.string().min(1),
  labels: z.record(z.string(), z.string()).default({}),
});
const sourcePod = z.object({
  metadata,
  spec: z
    .object({
      nodeName: z.string().optional(),
      containers: z.array(z.object({ image: z.string() }).passthrough()),
      initContainers: z.array(z.object({ image: z.string() }).passthrough()).default([]),
    })
    .passthrough(),
  status: z
    .object({
      phase: z.string(),
      conditions: z.array(z.object({ type: z.string(), status: z.string() })).default([]),
      containerStatuses: z
        .array(
          z.object({
            name: z.string(),
            state: z.object({ running: z.object({ startedAt: z.string() }).optional() }),
          }),
        )
        .default([]),
    })
    .optional(),
});
const claim = z.object({ metadata, spec: z.object({ accessModes: z.array(z.string()) }) });

export interface SourceResources extends WorkspaceSourceManifest {
  readonly namespaceUID: string | null;
  readonly claimUID: string | null;
  readonly podUID: string | null;
}
export interface SourceResourceObservation {
  readonly namespaceUID: string;
  readonly claimUID: string;
  readonly podUID: string;
  readonly storageNode: string | null;
  readonly ready: boolean;
  readonly failed: boolean;
}
export interface WorkspaceSourceClient {
  executionNode(input: {
    namespace: string;
    podName: string;
    podUID: string;
    workspaceID: string;
  }): Promise<string>;
  prepare(input: SourceResources): Promise<SourceResourceObservation>;
  observe(input: SourceResources): Promise<SourceResourceObservation | null>;
  connect(input: SourceResources, observation?: SourceResourceObservation): Promise<void>;
  request(
    input: SourceResources,
    operation: string,
    request: Request,
    signal: AbortSignal,
  ): Promise<Response>;
  stop(input: SourceResources): Promise<void>;
  close(): void;
}

export async function boundedSourceBody(
  request: Request,
  signal: AbortSignal = request.signal,
): Promise<Uint8Array<ArrayBuffer>> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  deadline.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  deadline.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      deadline.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 << 20) {
        void reader.cancel().catch(() => {});
        throw new Error("Source request exceeds 4 MiB");
      }
      chunks.push(chunk.value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return content;
  } finally {
    deadline.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function executeCommand(args: string[], input?: unknown) {
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
    throw new Error("Workspace source infrastructure command failed");
  }
  return output;
}

function requireSourceOwner(labels: Record<string, string>, input: SourceResources) {
  if (
    labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    labels["factory.dev/runtime-owner"] !== input.identity.workspaceID ||
    labels["factory.dev/source-service"] !== input.identity.serviceID ||
    labels["factory.dev/source-epoch"] !== String(input.identity.epoch)
  )
    throw new Error("Source resource ownership differs from intended identity");
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

export function validateSourceObservation(
  input: SourceResources,
  observed: {
    pod: unknown;
    claim: unknown;
    secret: unknown;
    namespace: { uid: string; labels: Record<string, string> };
  },
): SourceResourceObservation {
  const pod = sourcePod.parse(observed.pod);
  const volume = claim.parse(observed.claim);
  const secret = z
    .object({ metadata, data: z.record(z.string(), z.string()) })
    .parse(observed.secret);
  const { namespace } = observed;
  requireSourceOwner(pod.metadata.labels, input);
  requireSourceOwner(secret.metadata.labels, input);
  const intended = renderWorkspaceSourceResources(input);
  const assignment = intended.find((resource) => resource.kind === "Secret")?.stringData;
  const expectedPod = intended.find((resource) => resource.kind === "Pod")?.spec;
  // A first Pod can acquire its storage node while preparing. That observed node is immutable,
  // but cannot retroactively add a selector to the admitted Pod's spec.
  const expectedPodSpec = expectedPod ? { ...expectedPod } : undefined;
  if (expectedPodSpec) delete expectedPodSpec.nodeSelector;
  if (
    !assignment ||
    !expectedPod ||
    Object.entries(assignment).some(
      ([key, value]) => Buffer.from(secret.data[key] ?? "", "base64").toString() !== value,
    ) ||
    !intendedFields(pod.spec, expectedPodSpec) ||
    ["containers", "initContainers"].some((key) => {
      const containers = Reflect.get(pod.spec, key) as Array<Record<string, unknown>>;
      return containers.some((container) =>
        ["command", "env", "envFrom"].some((field) => {
          const extra = container[field];
          return extra !== undefined && (!Array.isArray(extra) || extra.length !== 0);
        }),
      );
    }) ||
    namespace.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    namespace.labels["factory.dev/runtime-owner"] !== input.identity.workspaceID ||
    volume.metadata.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    volume.metadata.labels["factory.dev/runtime-owner"] !== input.identity.workspaceID ||
    volume.spec.accessModes.join(",") !== "ReadWriteOnce" ||
    (input.namespaceUID && namespace.uid !== input.namespaceUID) ||
    (input.claimUID && volume.metadata.uid !== input.claimUID) ||
    (input.podUID && pod.metadata.uid !== input.podUID) ||
    (input.storageNode && pod.spec.nodeName && input.storageNode !== pod.spec.nodeName)
  )
    throw new Error("Source storage, assignment or Pod identity differs from intended resources");
  return {
    namespaceUID: namespace.uid,
    claimUID: volume.metadata.uid,
    podUID: pod.metadata.uid,
    storageNode: pod.spec.nodeName ?? null,
    // This only permits the authenticated connection probe. The controller
    // records product readiness after consuming a successful source stat.
    ready:
      pod.status?.phase === "Running" &&
      (pod.status.conditions.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ) ||
        (pod.status.conditions.some(
          (condition) => condition.type === "Initialized" && condition.status === "True",
        ) &&
          pod.status.containerStatuses.some(
            (container) => container.name === "source" && container.state.running !== undefined,
          ))),
    failed: pod.status?.phase === "Failed",
  };
}

export function confirmSourceRoot(value: unknown) {
  z.object({ kind: z.literal("directory") }).parse(value);
}

export function createWorkspaceSourceClient(
  kubernetes: KubernetesClient = createKubernetesClient(),
  command: typeof executeCommand = executeCommand,
  transport: typeof fetch = fetch,
): WorkspaceSourceClient {
  const connections = new Map<
    string,
    {
      origin: Promise<string>;
      child: ReturnType<typeof Bun.spawn>;
      cancel: AbortController;
    }
  >();
  const observations = new WeakMap<
    SourceResourceObservation,
    {
      resources: ReturnType<typeof sourceResourceInventory>;
      expires: number;
    }
  >();
  async function inventory(input: SourceResources) {
    // One exact-resource read avoids four competing kubectl processes per
    // readiness probe. This is an observation, not an authorization cache.
    const listing = await command([
      "get",
      `pod/${input.identity.podName}`,
      "pvc/runtime-data",
      `secret/${input.identity.secretName}`,
      `namespace/${input.namespace}`,
      "-n",
      input.namespace,
      "--ignore-not-found",
      "-o",
      "json",
    ]);
    return sourceResourceInventory(input, listing ? JSON.parse(listing) : { items: [] });
  }
  async function observe(input: SourceResources) {
    const resources = await inventory(input);
    const result = completeSourceObservation(input, resources);
    if (result?.ready) observations.set(result, { resources, expires: performance.now() + 1_000 });
    return result;
  }
  async function endpoint(input: SourceResources, observation?: SourceResourceObservation) {
    if (!input.podUID) throw new Error("Source Pod outcome has not been recorded");
    const key = `${input.namespace}:${input.podUID}`;
    const retained = connections.get(key);
    if (retained) return retained;
    const recent = observation ? observations.get(observation) : undefined;
    if (observation) observations.delete(observation);
    const resources =
      recent && recent.expires > performance.now() ? recent.resources : await inventory(input);
    const current = completeSourceObservation(input, resources);
    if (!current?.ready) throw new Error("Source Pod is no longer ready");
    const ready = Promise.withResolvers<string>();
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "source-forward.ts"),
        input.namespace,
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
          const result = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(message);
          if (result.success) {
            clearTimeout(timer);
            ready.resolve(`http://127.0.0.1:${result.data.port}`);
          }
        },
      },
    );
    const timer = setTimeout(() => {
      child.kill();
      ready.reject(new Error("Source connection exceeded its deadline"));
    }, 10_000);
    const connection = { origin: ready.promise, child, cancel: new AbortController() };
    connections.set(key, connection);
    void child.exited.then(() => {
      clearTimeout(timer);
      connection.cancel.abort();
      ready.reject(new Error("Source connection closed"));
      if (connections.get(key) === connection) connections.delete(key);
    });
    return connection;
  }
  return {
    async executionNode(input) {
      const raw = await command(["get", "pod", input.podName, "-n", input.namespace, "-o", "json"]);
      if (!raw) throw new Error("Existing execution storage is unavailable");
      const pod = sourcePod.parse(JSON.parse(raw));
      if (
        pod.metadata.uid !== input.podUID ||
        pod.metadata.labels["factory.dev/runtime-owner"] !== input.workspaceID ||
        !pod.spec.nodeName
      )
        throw new Error("Existing execution storage identity differs");
      return pod.spec.nodeName;
    },
    observe,
    async connect(input, observation) {
      const connection = await endpoint(input, observation);
      const response = await transport(
        `${await connection.origin}/v1/workspaces/${input.identity.workspaceID}/stat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.capability}`,
            "X-Factory-Source-Service": input.identity.serviceID,
            "X-Factory-Source-Epoch": String(input.identity.epoch),
          },
          body: JSON.stringify({ path: "" }),
          redirect: "error",
          signal: AbortSignal.any([connection.cancel.signal, AbortSignal.timeout(10_000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Source connection did not confirm authorized file access");
      }
      confirmSourceRoot(await response.json());
    },
    async prepare(input) {
      const items = await inventory(input);
      const namespaceResource = items.find((item) => item.kind === "Namespace");
      const namespace = namespaceResource ? metadata.parse(namespaceResource.metadata) : null;
      if (
        namespace &&
        (namespace.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
          namespace.labels["factory.dev/runtime-owner"] !== input.identity.workspaceID ||
          (input.namespaceUID && input.namespaceUID !== namespace.uid))
      )
        throw new Error("Refusing unrelated source namespace");
      const existing = completeSourceObservation(input, items);
      // A complete observation already validates the exact assignment and all
      // resource identities. Partial creates validate the assignment in the same inventory.
      if (existing) return existing;
      const secretResource = items.find((item) => item.kind === "Secret");
      if (secretResource) {
        const secret = z
          .object({ metadata, data: z.record(z.string(), z.string()) })
          .parse(secretResource);
        requireSourceOwner(secret.metadata.labels, input);
        const expected = renderWorkspaceSourceResources(input).find(
          (resource) => resource.kind === "Secret",
        )?.stringData;
        if (
          !expected ||
          Object.entries(expected).some(
            ([key, value]) => Buffer.from(secret.data[key] ?? "", "base64").toString() !== value,
          )
        )
          throw new Error("Source capability differs from persisted intent");
      }
      await kubernetes.apply(
        renderWorkspaceSourceResources(input),
        namespace ? { ownerID: input.identity.workspaceID, uid: namespace.uid } : undefined,
      );
      const created = await observe(input);
      if (!created) throw new Error("Source resources were not observed after create");
      return created;
    },
    async request(input, operation, request, signal) {
      if (!/^(stat|list|read|write|mkdir|rename|delete|search|events|fence)$/.test(operation))
        throw new Error("Unsupported source operation");
      const connection = await endpoint(input);
      return transport(
        `${await connection.origin}/v1/workspaces/${input.identity.workspaceID}/${operation}`,
        {
          method: operation === "events" ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.capability}`,
            "X-Factory-Source-Service": input.identity.serviceID,
            "X-Factory-Source-Epoch": String(input.identity.epoch),
            ...(request.headers.has("X-Factory-Writer-Epoch")
              ? { "X-Factory-Writer-Epoch": request.headers.get("X-Factory-Writer-Epoch")! }
              : {}),
          },
          ...(operation !== "events" ? { body: await boundedSourceBody(request) } : {}),
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            connection.cancel.signal,
            ...(operation === "events" ? [] : [AbortSignal.timeout(10_000)]),
          ]),
        },
      );
    },
    async stop(input) {
      for (const [key, connection] of connections) {
        if (key.startsWith(`${input.namespace}:`)) {
          connection.cancel.abort();
          connection.child.kill();
          connections.delete(key);
        }
      }
      for (const [plural, name, expectedUID] of [
        ["pods", input.identity.podName, input.podUID],
        ["secrets", input.identity.secretName, null],
      ] as const) {
        const raw = await command(["get", plural, name, "-n", input.namespace, "-o", "json"]);
        if (!raw) continue;
        const resource = z.object({ metadata }).parse(JSON.parse(raw));
        requireSourceOwner(resource.metadata.labels, input);
        if (expectedUID && resource.metadata.uid !== expectedUID)
          throw new Error("Refusing to stop a replaced source Pod");
        await command(
          ["delete", "--raw", `/api/v1/namespaces/${input.namespace}/${plural}/${name}`, "-f", "-"],
          {
            apiVersion: "v1",
            kind: "DeleteOptions",
            gracePeriodSeconds: 0,
            preconditions: { uid: resource.metadata.uid },
          },
        );
      }
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        if (
          !(await command([
            "get",
            "pod",
            input.identity.podName,
            "-n",
            input.namespace,
            "-o",
            "json",
          ]))
        )
          return;
        await Bun.sleep(100);
      }
      throw new Error("Source Pod deletion remains pending");
    },
    close() {
      for (const connection of connections.values()) {
        connection.cancel.abort();
        connection.child.kill();
      }
      connections.clear();
    },
  };
}

export function sourceResourceListObservation(input: SourceResources, raw: unknown) {
  return completeSourceObservation(input, sourceResourceInventory(input, raw));
}

function sourceResourceInventory(input: SourceResources, raw: unknown) {
  const { items } = z
    .object({
      items: z.array(
        z
          .object({
            kind: z.string(),
            metadata: z
              .object({ name: z.string(), namespace: z.string().optional() })
              .passthrough(),
          })
          .passthrough(),
      ),
    })
    .parse(raw);
  const expected = [
    ["Pod", input.identity.podName],
    ["PersistentVolumeClaim", "runtime-data"],
    ["Secret", input.identity.secretName],
    ["Namespace", input.namespace],
  ] as const;
  if (
    items.length > expected.length ||
    items.some(
      (item) =>
        !expected.some(
          ([kind, name]) =>
            item.kind === kind &&
            item.metadata.name === name &&
            (kind === "Namespace" || item.metadata.namespace === input.namespace),
        ),
    )
  )
    throw new Error("Source observation returned unrelated resources");
  const selected = expected.map(([kind, name]) => {
    const matches = items.filter((item) => item.kind === kind && item.metadata.name === name);
    if (matches.length > 1) throw new Error("Source observation returned duplicate resources");
    return matches[0];
  });
  return selected.filter((item) => item !== undefined);
}

function completeSourceObservation(
  input: SourceResources,
  items: ReturnType<typeof sourceResourceInventory>,
) {
  const pod = items.find((item) => item.kind === "Pod");
  const claim = items.find((item) => item.kind === "PersistentVolumeClaim");
  const secret = items.find((item) => item.kind === "Secret");
  const namespace = items.find((item) => item.kind === "Namespace");
  if (!pod || !claim || !secret || !namespace) return null;
  const owner = metadata.parse(namespace.metadata);
  return validateSourceObservation(input, { pod, claim, secret, namespace: owner });
}
import { runCommand } from "./command";
