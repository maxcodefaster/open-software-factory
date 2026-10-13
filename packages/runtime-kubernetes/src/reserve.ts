import { z } from "zod";
import upstream from "../../../upstream.json";
import type { ExecutionSlot } from "../../runtime-domain/src/reserve";
import { createKubernetesClient, readSmokeRegistryCA } from "./client";
import { renderEnvboxPod } from "./envbox-pod";

export interface SlotObservation {
  readonly namespaceUID: string;
  readonly podUID: string;
  readonly claimUID: string;
  readonly ready: boolean;
  readonly failed: boolean;
}
export interface ReserveClient {
  prepare(slot: ExecutionSlot): Promise<SlotObservation>;
  activate(slot: ExecutionSlot, resources: readonly unknown[]): Promise<SlotObservation>;
  retire(slot: ExecutionSlot): Promise<void>;
  removeAssigned(slot: ExecutionSlot, generation: number): Promise<boolean>;
}
const metadata = z.object({
  name: z.string(),
  uid: z.string(),
  labels: z.record(z.string(), z.string()).default({}),
});
const object = z.object({
  kind: z.string(),
  metadata,
  spec: z.record(z.string(), z.unknown()).optional(),
  data: z.record(z.string(), z.string()).optional(),
  status: z
    .object({
      phase: z.string().optional(),
      conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
    })
    .optional(),
});
type ObservedObject = z.infer<typeof object>;

export function renderReserveResources(slot: ExecutionSlot, registryCA: string) {
  const labels = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/runtime-owner": slot.id,
    "factory.dev/runtime-attempt": slot.id,
    "factory.dev/runtime-generation": "0",
    "factory.dev/execution-slot": slot.id,
  };
  return [
    { apiVersion: "v1", kind: "Namespace" as const, metadata: { name: slot.namespace, labels } },
    {
      apiVersion: "v1",
      kind: "Secret" as const,
      metadata: { name: "runtime-assignment", namespace: slot.namespace, labels },
      stringData: {
        "slot.json": JSON.stringify({
          version: 1,
          id: slot.id,
          role: slot.role,
          images: [upstream.nodeDevelopment.image],
          expiresAt: new Date(slot.expiresAt).toISOString(),
        }),
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret" as const,
      metadata: { name: "registry-ca", namespace: slot.namespace, labels },
      stringData: { "ca.crt": registryCA },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim" as const,
      metadata: { name: "runtime-data", namespace: slot.namespace, labels },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "8Gi" } } },
    },
    renderEnvboxPod({
      namespace: slot.namespace,
      podName: "slot",
      hostname: slot.id,
      labels,
      runtimeHostImage: slot.runtimeHostImage,
      mode: slot.role,
      reserve: true,
    }),
  ];
}

function declaredFields(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => declaredFields(actual[index], value))
    );
  if (typeof expected === "object" && expected !== null)
    return (
      typeof actual === "object" &&
      actual !== null &&
      Object.entries(expected).every(([key, value]) =>
        key in actual ? declaredFields(Reflect.get(actual, key), value) : value === false,
      )
    );
  return actual === expected;
}

function requireDeclaredResource(
  item: ObservedObject,
  resources: ReturnType<typeof renderReserveResources>,
  assignedOwner?: string,
  assignmentData?: Readonly<Record<string, string>>,
) {
  const expected = resources.find(
    (resource) => resource.kind === item.kind && resource.metadata.name === item.metadata.name,
  );
  if (
    !expected ||
    ("spec" in expected && !declaredFields(item.spec, expected.spec)) ||
    ("stringData" in expected &&
      Object.entries(expected.stringData).some(
        ([key, value]) => Buffer.from(item.data?.[key] ?? "", "base64").toString() !== value,
      ))
  )
    throw new Error("Execution slot tools, storage or seed differs from create intent");
  if ("stringData" in expected) {
    const assignedKeys =
      assignedOwner && item.metadata.name === "runtime-assignment"
        ? ["assignment.json", "parent-token", "child-token"]
        : [];
    for (const [key, value] of Object.entries(item.data ?? {})) {
      if (Object.hasOwn(expected.stringData, key)) continue;
      if (
        !assignedKeys.includes(key) ||
        (assignmentData && Buffer.from(value, "base64").toString() !== assignmentData[key])
      )
        throw new Error("Execution slot has undeclared or changed credentials");
    }
  }
  if (item.kind !== "Pod") return;
  for (const key of ["initContainers", "ephemeralContainers"]) {
    const value = item.spec?.[key];
    if (value !== undefined && (!Array.isArray(value) || value.length !== 0))
      throw new Error("Execution slot has undeclared preparation code");
  }
  const containers = item.spec?.["containers"];
  if (
    Array.isArray(containers) &&
    containers.some(
      (container) =>
        typeof container === "object" &&
        container !== null &&
        Reflect.get(container, "envFrom") !== undefined,
    )
  )
    throw new Error("Execution slot has undeclared credentials");
}

export function validateReserveObservation(
  slot: ExecutionSlot,
  resources: ReturnType<typeof renderReserveResources>,
  observed: readonly unknown[],
  assignedOwner?: string,
  assignmentData?: Readonly<Record<string, string>>,
): SlotObservation {
  if (assignedOwner && (slot.state !== "assigned" || assignedOwner !== slot.assignedAttemptID))
    throw new Error("Execution slot observation requires its durable assignment owner");
  const actual = observed.map((value) => object.parse(value));
  const pod = actual.find((value) => value.kind === "Pod" && value.metadata.name === "slot");
  const namespace = actual.find(
    (value) => value.kind === "Namespace" && value.metadata.name === slot.namespace,
  );
  const claim = actual.find(
    (value) => value.kind === "PersistentVolumeClaim" && value.metadata.name === "runtime-data",
  );
  if (!pod || !namespace || !claim) throw new Error("Execution slot resources are incomplete");
  for (const item of actual) {
    requireDeclaredResource(item, resources, assignedOwner, assignmentData);
    const labels = item.metadata.labels;
    if (
      labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
      labels["factory.dev/execution-slot"] !== slot.id ||
      (labels["factory.dev/runtime-owner"] !== slot.id &&
        (!assignedOwner || labels["factory.dev/runtime-owner"] !== assignedOwner))
    )
      throw new Error("Execution slot ownership changed");
  }
  for (const resource of resources) {
    const item = actual.find(
      (value) => value.kind === resource.kind && value.metadata.name === resource.metadata.name,
    );
    if (!item) throw new Error("Execution slot resources are incomplete");
  }
  if (
    (slot.namespaceUID && namespace.metadata.uid !== slot.namespaceUID) ||
    (slot.podUID && pod.metadata.uid !== slot.podUID) ||
    (slot.claimUID && claim.metadata.uid !== slot.claimUID)
  )
    throw new Error("Execution slot resource UID changed");
  return {
    namespaceUID: namespace.metadata.uid,
    podUID: pod.metadata.uid,
    claimUID: claim.metadata.uid,
    ready:
      pod.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ) ?? false,
    failed: pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded",
  };
}

async function command(args: string[], input?: string) {
  const child = Bun.spawn(["kubectl", "--context", "orbstack", ...args], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  timer.unref();
  if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (status !== 0) {
    if (error.includes("NotFound") || error.includes("not found")) return null;
    throw new Error("Execution slot infrastructure command failed");
  }
  if (output.length > 2 * 1024 * 1024)
    throw new Error("Execution slot observation exceeds its bound");
  return output;
}

// Only Factory's provisioning code can deliver this bounded data file. The browser has no exec API.
// A replacement Pod with the same name fails the downward-API UID check before any write.
export const slotActivationCommand =
  'set -eu\nIFS= read -r expected_uid\ntest "$FACTORY_POD_UID" = "$expected_uid"\ntest -d /home/coder/.factory-reserve\ntest ! -L /home/coder/.factory-reserve\nfile=$(mktemp /home/coder/.factory-reserve/.activation-XXXXXX)\ntrap \'rm -f "$file"\' EXIT\nhead -c 1048577 > "$file"\ntest "$(wc -c < "$file")" -le 1048576\nchmod 0400 "$file"\nchown 100000:100000 "$file"\nsync "$file"\nif test -f /home/coder/.factory-reserve/activation.json; then cmp -s "$file" /home/coder/.factory-reserve/activation.json; else ln "$file" /home/coder/.factory-reserve/activation.json; sync /home/coder/.factory-reserve; fi\n';

export function createReserveClient(): ReserveClient {
  const kubernetes = createKubernetesClient();
  async function read(slot: ExecutionSlot) {
    const resources: ObservedObject[] = [];
    const namespace = await command(["get", "namespace", slot.namespace, "-o", "json"]);
    if (namespace) resources.push(object.parse(JSON.parse(namespace)));
    const listing = await command(["get", "pods,pvc,secrets", "-n", slot.namespace, "-o", "json"]);
    if (listing)
      resources.push(...z.object({ items: z.array(object) }).parse(JSON.parse(listing)).items);
    return resources;
  }
  return {
    async prepare(slot) {
      const resources = renderReserveResources(slot, await readSmokeRegistryCA());
      const current = await read(slot);
      if (current.length) {
        // Partial creates may resume only under this persisted unpredictable slot identity.
        for (const item of current) {
          if (
            item.metadata.labels["factory.dev/runtime-owner"] !== slot.id ||
            item.metadata.labels["factory.dev/execution-slot"] !== slot.id ||
            item.metadata.labels["app.kubernetes.io/managed-by"] !== "open-software-factory"
          )
            throw new Error("Refusing to adopt another execution slot");
          requireDeclaredResource(item, resources);
        }
      }
      const namespace = current.find((item) => item.kind === "Namespace");
      if (slot.namespaceUID && namespace?.metadata.uid !== slot.namespaceUID)
        throw new Error("Execution slot Namespace UID changed");
      await kubernetes.apply(
        resources,
        namespace ? { ownerID: slot.id, uid: namespace.metadata.uid } : undefined,
      );
      return validateReserveObservation(slot, resources, await read(slot));
    },
    async activate(slot, resources) {
      if (
        slot.state !== "assigned" ||
        !slot.assignedAttemptID ||
        !slot.namespaceUID ||
        !slot.podUID ||
        !slot.claimUID
      )
        throw new Error("Execution slot activation requires complete durable assignment");
      const seed = renderReserveResources(slot, await readSmokeRegistryCA());
      const current = await read(slot);
      const assignment = resources.find(
        (resource) =>
          typeof resource === "object" &&
          resource !== null &&
          Reflect.get(resource, "kind") === "Secret" &&
          Reflect.get(Reflect.get(resource, "metadata"), "name") === "runtime-assignment",
      ) as
        | { metadata: { labels: Record<string, string> }; stringData: Record<string, string> }
        | undefined;
      if (!assignment) throw new Error("Assigned runtime has no exact assignment");
      const parsed = JSON.parse(assignment.stringData["assignment.json"] ?? "") as {
        runtimeAttemptId?: string;
        generation?: number;
      };
      if (parsed.runtimeAttemptId !== slot.assignedAttemptID || !parsed.generation)
        throw new Error("Execution slot assignment differs from Runtime Attempt intent");
      const observed = validateReserveObservation(
        slot,
        seed,
        current,
        slot.assignedAttemptID,
        assignment.stringData,
      );
      const labels = { ...assignment.metadata.labels, "factory.dev/execution-slot": slot.id };
      for (const item of current) {
        await command([
          "patch",
          item.kind,
          item.metadata.name,
          ...(item.kind === "Namespace" ? [] : ["-n", slot.namespace]),
          "--type=json",
          "-p",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: item.metadata.uid },
            { op: "replace", path: "/metadata/labels", value: labels },
          ]),
        ]);
      }
      // Keep the immutable slot seed for process restart. Never replace the running Pod or its PVC.
      const seedAssignment = seed
        .filter((value) => value.kind === "Secret")
        .find((value) => value.metadata.name === "runtime-assignment");
      for (const resource of resources) {
        const candidate = resource as {
          kind: string;
          metadata: { name: string };
          stringData?: Record<string, string>;
        };
        if (candidate.kind !== "Secret") continue;
        const seeded =
          candidate.metadata.name === "runtime-assignment"
            ? {
                ...candidate,
                stringData: {
                  ...seedAssignment?.stringData,
                  ...candidate.stringData,
                },
              }
            : candidate;
        await command(
          ["apply", "--server-side", "--field-manager", "open-software-factory", "-f", "-"],
          JSON.stringify({ ...seeded, metadata: { ...candidate.metadata, labels } }),
        );
      }
      const bundle = JSON.stringify({
        slotId: slot.id,
        podUID: slot.podUID,
        assignment: parsed,
        parentToken: assignment.stringData["parent-token"],
        childToken: assignment.stringData["child-token"],
      });
      await command(
        ["exec", "-i", "slot", "-n", slot.namespace, "--", "sh", "-c", slotActivationCommand],
        `${slot.podUID}\n${bundle}`,
      );
      return observed;
    },
    async removeAssigned(slot, generation) {
      if (
        !slot.assignedAttemptID ||
        !slot.namespaceUID ||
        !slot.podUID ||
        !slot.claimUID ||
        !Number.isSafeInteger(generation) ||
        generation < 1
      )
        throw new Error("Assigned slot cleanup requires immutable owner outcomes");
      const current = await read(slot);
      if (!current.length) return true;
      const namespace = current.find((item) => item.kind === "Namespace");
      const pod = current.find((item) => item.kind === "Pod");
      const claim = current.find((item) => item.kind === "PersistentVolumeClaim");
      if (pod && pod.metadata.uid !== slot.podUID) return false;
      if (
        namespace?.metadata.uid !== slot.namespaceUID ||
        (claim && claim.metadata.uid !== slot.claimUID)
      )
        throw new Error("Assigned execution slot cleanup UID changed");
      const listing = await command([
        "get",
        "pods,pvc,secrets",
        "-n",
        slot.namespace,
        "-o",
        "json",
      ]);
      for (const item of z.object({ items: z.array(object) }).parse(JSON.parse(listing ?? "{}"))
        .items) {
        if (
          !current.some(
            (expected) =>
              expected.kind === item.kind && expected.metadata.uid === item.metadata.uid,
          )
        )
          throw new Error("Assigned execution slot cleanup found unrelated data");
      }
      for (const item of current) {
        const labels = item.metadata.labels;
        if (
          labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
          labels["factory.dev/execution-slot"] !== slot.id ||
          ![slot.id, slot.assignedAttemptID].includes(labels["factory.dev/runtime-owner"] ?? "")
        )
          throw new Error("Assigned execution slot cleanup ownership changed");
        await command([
          "patch",
          item.kind,
          item.metadata.name,
          ...(item.kind === "Namespace" ? [] : ["-n", slot.namespace]),
          "--type=json",
          "-p",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: item.metadata.uid },
            {
              op: "replace",
              path: "/metadata/labels",
              value: {
                ...labels,
                "factory.dev/runtime-owner": slot.assignedAttemptID,
                "factory.dev/runtime-attempt": slot.assignedAttemptID,
                "factory.dev/runtime-generation": String(generation),
              },
            },
          ]),
        ]);
      }
      await kubernetes.deleteNamespace({
        namespace: slot.namespace,
        podName: "slot",
        attemptID: slot.assignedAttemptID,
        generation,
        namespaceUID: slot.namespaceUID,
        uid: pod?.metadata.uid ?? null,
        ownerID: slot.assignedAttemptID,
      });
      return true;
    },
    async retire(slot) {
      if (slot.assignedAttemptID)
        throw new Error("Assigned slots use their Runtime Attempt cleanup");
      const current = await read(slot);
      if (!current.length) return;
      const namespace = current.find((item) => item.kind === "Namespace");
      if (!namespace) throw new Error("Execution slot has resources without its Namespace");
      const listing = await command([
        "get",
        "pods,pvc,secrets",
        "-n",
        slot.namespace,
        "-o",
        "json",
      ]);
      for (const item of z.object({ items: z.array(object) }).parse(JSON.parse(listing ?? "{}"))
        .items) {
        if (
          !current.some(
            (expected) =>
              expected.kind === item.kind && expected.metadata.uid === item.metadata.uid,
          ) ||
          item.metadata.labels["factory.dev/runtime-owner"] !== slot.id ||
          item.metadata.labels["factory.dev/execution-slot"] !== slot.id
        )
          throw new Error("Execution slot cleanup found unrelated data");
      }
      for (const item of current) {
        if (
          item.metadata.labels["factory.dev/runtime-owner"] !== slot.id ||
          item.metadata.labels["factory.dev/execution-slot"] !== slot.id
        )
          throw new Error("Execution slot cleanup ownership changed");
      }
      const pod = current.find((item) => item.kind === "Pod");
      const claim = current.find((item) => item.kind === "PersistentVolumeClaim");
      if (
        (slot.namespaceUID && namespace.metadata.uid !== slot.namespaceUID) ||
        (slot.podUID && pod && slot.podUID !== pod.metadata.uid) ||
        (slot.claimUID && claim && slot.claimUID !== claim.metadata.uid)
      )
        throw new Error("Execution slot cleanup UID changed");
      await kubernetes.deleteNamespace({
        namespace: slot.namespace,
        podName: "slot",
        attemptID: slot.id,
        generation: 0,
        namespaceUID: namespace.metadata.uid,
        uid: pod?.metadata.uid ?? null,
        ownerID: slot.id,
      });
    },
  };
}
