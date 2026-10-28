import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { runCommand } from "./command";
import { factoryboxSharedLabels } from "./factorybox-location";
import type { FactoryboxRuntimeInput } from "./factorybox-runtime";
import type { FactoryboxWorkerIdentity } from "./factorybox-worker";

const program = readFileSync(new URL("./factorybox/consumer.py", import.meta.url), "utf8");
const exportProgram = readFileSync(
  new URL("./factorybox/export-rootfs.sh", import.meta.url),
  "utf8",
);

export function factoryboxConsumerIntent(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
) {
  const key = createHash("sha256").update(input.runtimeHostImage).digest("hex");
  return {
    version: 1 as const,
    storeID: identity.storeID,
    epoch: identity.epoch,
    podUID: identity.podUID,
    image: input.runtimeHostImage,
    exporterName: `consumer-${key.slice(0, 48)}`,
  };
}

export function renderFactoryboxConsumer(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  subPath: string,
) {
  const intent = factoryboxConsumerIntent(input, identity);
  const key = createHash("sha256").update(intent.image).digest("hex");
  if (subPath !== `consumer-seeds/${key}`)
    throw new Error("Consumer export path differs from its immutable image");
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: intent.exporterName,
      namespace: input.namespace,
      labels: {
        ...factoryboxSharedLabels(input.workerID),
        "factory.dev/consumer-export": key.slice(0, 48),
      },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      nodeSelector: {
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": input.profile.architecture,
        "kubernetes.io/hostname": input.profile.nodeName,
      },
      containers: [
        {
          name: "export",
          image: intent.image,
          imagePullPolicy: "IfNotPresent",
          command: [
            "/bin/sh",
            "-ec",
            `set -eu\numask 077\ntest ! -e /factory-seed/exporter-uid\nprintf '%s' "$FACTORY_EXPORT_UID" > /factory-seed/exporter-uid\n${exportProgram}`,
          ],
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "500m", memory: "256Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
          env: [
            { name: "FACTORY_POD_UID", value: identity.podUID },
            { name: "FACTORY_STORE_ID", value: identity.storeID },
            { name: "FACTORY_RUNTIME_IMAGE", value: intent.image },
            { name: "FACTORY_EXPORT_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
          ],
          volumeMounts: [{ name: "store", mountPath: "/factory-seed", subPath }],
        },
      ],
      volumes: [
        {
          name: "store",
          persistentVolumeClaim: { claimName: `store-${identity.storeID}` },
        },
      ],
    },
  };
}

function matches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => matches(value, actual[index]))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        value === false &&
        ["hostNetwork", "hostPID", "hostIPC"].includes(key) &&
        !Object.hasOwn(actual, key)
          ? true
          : matches(value, Reflect.get(actual, key)),
      )
    );
  return expected === actual;
}

// Called only after exact worker/epoch admission. The worker persists export
// intent and the one create attempt before Kubernetes can see the exporter.
export async function ensureFactoryboxConsumer(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  run: typeof runCommand,
  deadline: number,
) {
  if (!input.workerRuntimeHostImage || input.workerRuntimeHostImage === input.runtimeHostImage)
    return;
  const intent = factoryboxConsumerIntent(input, identity);
  const receipt = z.object({
    create: z.boolean(),
    complete: z.boolean(),
    exporterUID: z.string().optional(),
    subPath: z.string(),
  });
  async function command(action: string, extra: Record<string, unknown> = {}) {
    const result = await run(
      [
        "exec",
        "-i",
        input.podName,
        "-n",
        input.namespace,
        "-c",
        "worker",
        "--",
        "python3",
        "-c",
        program,
      ],
      JSON.stringify({ action, intent, ...extra }),
      { timeoutMS: Math.max(1, deadline - performance.now()), outputBytes: 16_384 },
    );
    if (result.exitCode !== 0)
      throw new Error(`Consumer image admission is unconfirmed: ${result.stderr}`);
    return receipt.parse(JSON.parse(result.stdout));
  }
  async function read() {
    const result = await run([
      "get",
      "pod",
      intent.exporterName,
      "-n",
      input.namespace,
      "-o",
      "json",
    ]);
    if (result.exitCode === 0) return JSON.parse(result.stdout) as unknown;
    if (/^Error from server \(NotFound\):/.test(result.stderr.trim())) return null;
    throw new Error("Consumer exporter observation is unavailable");
  }
  const pod = z
    .object({
      metadata: z
        .object({ uid: z.string().min(1), deletionTimestamp: z.string().optional() })
        .passthrough(),
      spec: z
        .object({
          containers: z.array(z.object({ envFrom: z.unknown().optional() }).passthrough()),
          initContainers: z.array(z.unknown()).optional(),
          ephemeralContainers: z.array(z.unknown()).optional(),
        })
        .passthrough(),
      status: z
        .object({
          phase: z.string(),
          containerStatuses: z
            .array(
              z.object({
                state: z.object({ terminated: z.object({ exitCode: z.number() }).optional() }),
                restartCount: z.literal(0),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .passthrough();
  let observed = await read();
  let saved = await command("begin", {
    existingUID: observed ? pod.parse(observed).metadata.uid : null,
  });
  const declared = renderFactoryboxConsumer(input, identity, saved.subPath);
  if (!saved.complete) {
    if (saved.create) {
      const created = await run(["create", "-f", "-", "-o", "json"], JSON.stringify(declared));
      if (created.exitCode !== 0) {
        // Never repeat create, including after a lost response.
        observed = await read();
        if (!observed) throw new Error("Consumer exporter create remains unconfirmed");
      } else observed = JSON.parse(created.stdout) as unknown;
    }
    if (!observed) throw new Error("Original consumer exporter disappeared; refusing replacement");
    const uid = pod.parse(observed).metadata.uid;
    for (;;) {
      const current = pod.parse(observed);
      if (
        current.metadata.uid !== uid ||
        current.metadata.deletionTimestamp ||
        !matches(declared.metadata, current.metadata) ||
        !matches(declared.spec, current.spec) ||
        current.spec.containers.some((container) => container.envFrom !== undefined) ||
        current.spec.initContainers?.length ||
        current.spec.ephemeralContainers?.length
      )
        throw new Error("Consumer exporter differs from its original declaration or UID");
      await command("observe", { exporterUID: uid });
      if (current.status?.phase === "Failed")
        throw new Error("Consumer image export failed; its original inputs remain retained");
      if (current.status?.phase === "Succeeded") {
        if (
          current.status.containerStatuses?.length !== 1 ||
          current.status.containerStatuses[0]?.state.terminated?.exitCode !== 0
        )
          throw new Error("Consumer image export has no confirmed successful exit");
        saved = await command("complete", { exporterUID: uid });
        break;
      }
      if (performance.now() >= deadline)
        throw new Error("Consumer image export remains unconfirmed");
      await Bun.sleep(250);
      observed = await read();
      if (!observed)
        throw new Error("Original consumer exporter disappeared; refusing replacement");
    }
  }
  if (!saved.complete || !saved.exporterUID)
    throw new Error("Consumer image export has no immutable completion receipt");
  const current = await read();
  if (current) {
    if (pod.parse(current).metadata.uid !== saved.exporterUID)
      throw new Error("Consumer exporter cleanup refuses a replacement Pod");
    const removed = await run(
      [
        "delete",
        "--raw",
        `/api/v1/namespaces/${input.namespace}/pods/${intent.exporterName}`,
        "-f",
        "-",
      ],
      JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: saved.exporterUID },
      }),
    );
    if (removed.exitCode !== 0)
      throw new Error("Exact consumer exporter cleanup remains unconfirmed");
  }
}
