import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { runtimeVolumeClaimSpec } from "../../packages/runtime-kubernetes/src/storage";
import { requirePinnedImage } from "./preflight";

const intentSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    image: z.string(),
    storageClass: z.string().optional(),
    namespaceUID: z.string().nullable(),
    claimUID: z.string().nullable(),
    podUID: z.string().nullable(),
    volume: z.object({ name: z.string(), uid: z.string() }).nullable(),
    cleanupIntended: z.boolean(),
    podDeleteIntended: z.boolean().default(false),
    writeVerified: z.boolean().default(false),
  })
  .refine(
    (intent) =>
      !intent.writeVerified ||
      Boolean(
        intent.cleanupIntended &&
          intent.namespaceUID &&
          intent.claimUID &&
          intent.podUID &&
          intent.volume,
      ),
    "Verified storage check is missing its original resource identities",
  );
type Intent = z.infer<typeof intentSchema>;
const metadata = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  uid: z.string(),
  labels: z.record(z.string(), z.string()).default({}),
});
const resource = z.object({
  kind: z.string(),
  metadata,
  spec: z.record(z.string(), z.unknown()).default({}),
  status: z.record(z.string(), z.unknown()).default({}),
});
type Resource = z.infer<typeof resource>;
const containerState = z.object({
  name: z.string(),
  state: z.object({
    waiting: z.object({ reason: z.string().optional() }).optional(),
    running: z.object({ startedAt: z.string().optional() }).optional(),
    terminated: z
      .object({
        exitCode: z.number(),
        reason: z.string().optional(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
      })
      .optional(),
  }),
});
function podState(pod: Resource) {
  return {
    uid: pod.metadata.uid,
    phase: pod.status["phase"] ?? "Unknown",
    containers: z.array(containerState).parse(pod.status["containerStatuses"] ?? []),
  };
}
const probeName = "storage-check";
const claimName = "runtime-data";
const storageObservationTimeoutMS = 20 * 60_000;
type StorageCheckInput = {
  stateDirectory: string;
  image: string;
  timeoutMS?: number;
  cleanupTimeoutMS?: number;
  intervalMS?: number;
};
type StorageCheckEvidence = {
  checkID: string;
  namespace: string;
  elapsedMS: number;
  diagnosticFile: string;
};
class StorageObservationUnavailable extends Error {}
const transient =
  /timed out|timeout|context deadline|connection[^\n]*(?:refused|reset)|ServiceUnavailable|TooManyRequests|network is unreachable/i;
function matchesProbe(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesProbe(actual[index], item))
    );
  if (typeof expected === "object" && expected !== null)
    return (
      typeof actual === "object" &&
      actual !== null &&
      Object.entries(expected).every(
        ([key, value]) => key in actual && matchesProbe(Reflect.get(actual, key), value),
      )
    );
  return actual === expected;
}

// The caller's installation-operation lock serializes this retained intent. A lost
// create response or interrupted startup reobserves the same disposable check.
export async function requireWritableRuntimeStorage(
  input: StorageCheckInput,
  command: typeof runCommand = runCommand,
): Promise<StorageCheckEvidence> {
  const evidence = await storageCheck(input, command, false);
  if (!evidence) throw new Error("Runtime storage readiness was not confirmed");
  return evidence;
}

export async function disposeRuntimeStorageCheck(
  stateDirectory: string,
  command: typeof runCommand = runCommand,
) {
  const path = resolve(stateDirectory, "storage-readiness.json");
  const current = await lstat(path).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (!current) return;
  if (!current.isFile()) throw new Error("Invalid storage-check intent file");
  const intent = intentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return storageCheck({ stateDirectory, image: intent.image }, command, true);
}

async function storageCheck(
  input: StorageCheckInput,
  command: typeof runCommand,
  cleanupOnly: boolean,
): Promise<StorageCheckEvidence | undefined> {
  requirePinnedImage(input.image);
  await mkdir(input.stateDirectory, { recursive: true });
  const intentFile = resolve(input.stateDirectory, "storage-readiness.json");
  const diagnosticFile = resolve(input.stateDirectory, "storage-readiness-diagnostic.json");
  const failureFile = resolve(input.stateDirectory, "storage-readiness-failure.json");
  const existing = await lstat(intentFile).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (existing && !existing.isFile()) throw new Error("Invalid storage-check intent file");
  const intent: Intent = existing
    ? intentSchema.parse(JSON.parse(await readFile(intentFile, "utf8")))
    : {
        version: 1,
        id: crypto.randomUUID(),
        image: input.image,
        ...(process.env["FACTORY_STORAGE_CLASS"]
          ? { storageClass: process.env["FACTORY_STORAGE_CLASS"] }
          : {}),
        namespaceUID: null,
        claimUID: null,
        podUID: null,
        volume: null,
        cleanupIntended: false,
        podDeleteIntended: false,
        writeVerified: false,
      };
  requirePinnedImage(intent.image);
  const namespace = `factory-storage-check-${intent.id.replaceAll("-", "")}`;
  const labels = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/runtime-owner": intent.id,
    "factory.dev/storage-check": intent.id,
  };
  let deadline = Date.now() + (input.timeoutMS ?? storageObservationTimeoutMS);
  const snapshots: unknown[] = [];
  let fingerprint = "";
  let verified = intent.writeVerified;
  const started = performance.now();
  let retryFailedPod = Boolean(existing);
  async function protectedWrite(path: string, value: unknown) {
    const temporary = `${path}.${crypto.randomUUID()}`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
  const persist = () => protectedWrite(intentFile, intent);
  await persist();
  async function run(args: string[], body?: unknown) {
    const result = await command(
      kubernetesCommand(["--request-timeout=10s", ...args]),
      body === undefined ? undefined : JSON.stringify(body),
      { timeoutMS: Math.max(1, Math.min(15_000, deadline - Date.now())), outputBytes: 256 * 1024 },
    ).catch((cause: unknown) => {
      if (cause instanceof Error && transient.test(cause.message))
        throw new StorageObservationUnavailable("Storage observation is temporarily unavailable");
      throw new Error(
        "Kubernetes storage operation was not confirmed; retained intent was preserved",
      );
    });
    if (result.exitCode !== 0) {
      if (transient.test(result.stderr))
        throw new StorageObservationUnavailable("Storage observation is temporarily unavailable");
      throw new Error(
        "Kubernetes storage operation was not confirmed; retained intent was preserved",
      );
    }
    return result.stdout.trim();
  }
  async function get(kind: string, name: string, namespaced = true) {
    const text = await run([
      "get",
      kind,
      name,
      ...(namespaced ? ["-n", namespace] : []),
      "--ignore-not-found",
      "-o",
      "json",
    ]);
    return text ? resource.parse(JSON.parse(text)) : null;
  }
  function requireOwner(value: Resource, uid: string | null) {
    if (
      (uid && value.metadata.uid !== uid) ||
      Object.entries(labels).some(([key, expected]) => value.metadata.labels[key] !== expected)
    )
      throw new Error(
        "Storage-check resource identity or ownership changed; refusing adoption or cleanup",
      );
  }
  async function ensure(kind: string, name: string, spec?: Record<string, unknown>) {
    const key =
      kind === "Namespace"
        ? "namespaceUID"
        : kind === "PersistentVolumeClaim"
          ? "claimUID"
          : "podUID";
    let current = await get(kind, name, kind !== "Namespace");
    if (!current) {
      if (intent[key]) throw new Error("Recorded storage-check resource disappeared");
      const text = await run(["create", "-f", "-", "-o", "json"], {
        apiVersion: "v1",
        kind,
        metadata: { name, ...(kind === "Namespace" ? {} : { namespace }), labels },
        ...(spec ? { spec } : {}),
      });
      current = resource.parse(JSON.parse(text));
    }
    requireOwner(current, intent[key]);
    if (spec && !matchesProbe(current.spec, spec))
      throw new Error("Storage-check resource differs from its retained intent");
    if (intent[key] !== current.metadata.uid) {
      intent[key] = current.metadata.uid;
      await persist();
    }
    return current;
  }
  async function capture(claim: Resource, pod: Resource) {
    const helpers: unknown[] = [];
    if (claim.status["phase"] !== "Bound") {
      const text = await run([
        "get",
        "pods",
        "--all-namespaces",
        "--field-selector",
        `metadata.name=helper-pod-create-pvc-${claim.metadata.uid}`,
        "-o",
        "json",
      ]).catch(() => null);
      const listing = text
        ? z.object({ items: z.array(resource) }).parse(JSON.parse(text))
        : { items: [] };
      for (const helper of listing.items.slice(0, 4)) {
        let actual: unknown = null;
        try {
          const listed = await command(
            [
              "docker",
              "ps",
              "-a",
              "--filter",
              `label=io.kubernetes.pod.uid=${helper.metadata.uid}`,
              "--filter",
              "label=io.kubernetes.container.name=helper-pod",
              "--format",
              "{{.ID}}",
            ],
            undefined,
            { timeoutMS: 2_000, outputBytes: 8_192 },
          );
          const ids = listed.stdout
            .trim()
            .split(/\s+/)
            .filter((id) => /^[a-f0-9]{12,64}$/.test(id));
          const id = ids[0];
          if (listed.exitCode === 0 && ids.length === 1 && id) {
            const inspected = await command(
              ["docker", "inspect", "--format", "{{json .State}}", id],
              undefined,
              { timeoutMS: 2_000, outputBytes: 8_192 },
            );
            if (inspected.exitCode === 0)
              actual = z
                .object({
                  Status: z.string(),
                  Running: z.boolean(),
                  ExitCode: z.number(),
                  OOMKilled: z.boolean(),
                  StartedAt: z.string(),
                  FinishedAt: z.string(),
                })
                .parse(JSON.parse(inspected.stdout));
          }
        } catch {
          /* Native Docker inspection is optional; Kubernetes remains authoritative. */
        }
        helpers.push({ namespace: helper.metadata.namespace, ...podState(helper), actual });
      }
    }
    const snapshot = {
      claim: { uid: claim.metadata.uid, phase: claim.status["phase"] ?? "Unknown" },
      pod: podState(pod),
      helpers,
    };
    const next = JSON.stringify(snapshot);
    if (next !== fingerprint) {
      fingerprint = next;
      snapshots.push(snapshot);
      if (snapshots.length > 16) snapshots.shift();
      await diagnostic();
    }
    return snapshot;
  }
  async function diagnostic(error?: string) {
    const evidence = {
      checkID: intent.id,
      namespace,
      namespaceUID: intent.namespaceUID,
      claimUID: intent.claimUID,
      podUID: intent.podUID,
      verified,
      elapsedMS: Math.round(performance.now() - started),
      snapshots,
      cleanupConfirmed: verified && !(await lstat(intentFile).catch(() => undefined)),
      ...(error ? { error } : {}),
    };
    await protectedWrite(diagnosticFile, evidence);
    if (error) await protectedWrite(failureFile, evidence);
  }
  async function remove(kind: string, plural: string, name: string, uid: string | null) {
    let current = await get(kind, name);
    if (!current) return;
    requireOwner(current, uid);
    if (!uid) {
      uid = current.metadata.uid;
      if (kind === "Pod") intent.podUID = uid;
      else intent.claimUID = uid;
      await persist();
    }
    await run(["delete", "--raw", `/api/v1/namespaces/${namespace}/${plural}/${name}`, "-f", "-"], {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid },
      gracePeriodSeconds: 1,
    });
    while (Date.now() < deadline) {
      current = await get(kind, name);
      if (!current) return;
      requireOwner(current, uid);
      await Bun.sleep(input.intervalMS ?? 1_000);
    }
    throw new Error("Storage-check cleanup is not confirmed");
  }
  async function cleanup() {
    // Each serial Kubernetes operation gets its own bounded convergence window.
    // A slow Pod or reclaimer must not leave the next operation a spent deadline.
    const phaseTimeoutMS = input.cleanupTimeoutMS ?? storageObservationTimeoutMS;
    deadline = Date.now() + phaseTimeoutMS;
    const currentNamespace = await get("Namespace", namespace, false);
    if (currentNamespace) {
      requireOwner(currentNamespace, intent.namespaceUID);
      if (!intent.namespaceUID) {
        intent.namespaceUID = currentNamespace.metadata.uid;
        await persist();
      }
      await remove("Pod", "pods", probeName, intent.podUID);
      deadline = Date.now() + phaseTimeoutMS;
      const claim = await get("PersistentVolumeClaim", claimName);
      if (claim) {
        requireOwner(claim, intent.claimUID);
        if (!intent.claimUID) {
          intent.claimUID = claim.metadata.uid;
          await persist();
        }
        if (claim.status["phase"] !== "Bound")
          throw new Error("Pending storage-check create must settle before cleanup");
        const volumeName = z.string().min(1).parse(claim.spec["volumeName"]);
        const volume = await get("PersistentVolume", volumeName, false);
        if (
          !volume ||
          z.object({ uid: z.string() }).parse(volume.spec["claimRef"]).uid !== intent.claimUID
        )
          throw new Error("Storage-check volume identity differs from the owned claim");
        if (
          intent.volume &&
          (intent.volume.name !== volumeName || intent.volume.uid !== volume.metadata.uid)
        )
          throw new Error("Storage-check volume was replaced");
        intent.volume = { name: volumeName, uid: volume.metadata.uid };
        await persist();
        // This fresh check contains only its own marker. Retain policies must not
        // leak test disks, and the guarded patch can never target a Project volume.
        if (volume.spec["persistentVolumeReclaimPolicy"] !== "Delete")
          await run([
            "patch",
            "pv",
            volumeName,
            "--type=json",
            "-p",
            JSON.stringify([
              { op: "test", path: "/metadata/uid", value: volume.metadata.uid },
              { op: "test", path: "/spec/claimRef/uid", value: intent.claimUID },
              { op: "replace", path: "/spec/persistentVolumeReclaimPolicy", value: "Delete" },
            ]),
          ]);
        await remove("PersistentVolumeClaim", "persistentvolumeclaims", claimName, intent.claimUID);
      }
    }
    if (intent.volume) {
      deadline = Date.now() + phaseTimeoutMS;
      let volumePresent = true;
      while (Date.now() < deadline) {
        const volume = await get("PersistentVolume", intent.volume.name, false);
        if (!volume) {
          volumePresent = false;
          break;
        }
        if (volume.metadata.uid !== intent.volume.uid)
          throw new Error("Storage-check volume identity changed during cleanup");
        await Bun.sleep(input.intervalMS ?? 1_000);
      }
      if (volumePresent) throw new Error("Storage-check volume cleanup is not confirmed");
    }
    if (currentNamespace) {
      deadline = Date.now() + phaseTimeoutMS;
      const listing = z
        .object({ items: z.array(resource) })
        .parse(
          JSON.parse(
            await run([
              "get",
              "pods,pvc,secrets,configmaps,serviceaccounts,networkpolicies,services,deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs,replicationcontrollers",
              "-n",
              namespace,
              "-o",
              "json",
            ]),
          ),
        );
      if (
        listing.items.some(
          (item) =>
            !(item.kind === "ConfigMap" && item.metadata.name === "kube-root-ca.crt") &&
            !(item.kind === "ServiceAccount" && item.metadata.name === "default"),
        )
      )
        throw new Error("Storage-check Namespace contains unexpected resources");
      const current = await get("Namespace", namespace, false);
      if (current) {
        requireOwner(current, intent.namespaceUID);
        await run(["delete", "--raw", `/api/v1/namespaces/${namespace}`, "-f", "-"], {
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: intent.namespaceUID },
        });
      }
      let namespacePresent = true;
      while (Date.now() < deadline) {
        const remaining = await get("Namespace", namespace, false);
        if (!remaining) {
          namespacePresent = false;
          break;
        }
        requireOwner(remaining, intent.namespaceUID);
        await Bun.sleep(input.intervalMS ?? 1_000);
      }
      if (namespacePresent) throw new Error("Storage-check Namespace cleanup is not confirmed");
    }
    await rm(intentFile);
  }
  try {
    if (intent.cleanupIntended || cleanupOnly) {
      intent.cleanupIntended = true;
      await persist();
      await cleanup();
      if (cleanupOnly) return;
      // Complete this same checked operation after a delayed reclaimer or lost
      // deletion reply. Starting another probe here can trap a slow cluster in
      // endless successful checks whose cleanup never fits one startup.
      if (
        verified &&
        intent.image === input.image &&
        (intent.storageClass ?? "") === (process.env["FACTORY_STORAGE_CLASS"] ?? "")
      ) {
        await diagnostic();
        return {
          checkID: intent.id,
          namespace,
          elapsedMS: Math.round(performance.now() - started),
          diagnosticFile,
        };
      }
      return requireWritableRuntimeStorage(input, command);
    }
    if (intent.podDeleteIntended) {
      await remove("Pod", "pods", probeName, intent.podUID);
      intent.podUID = null;
      intent.podDeleteIntended = false;
      await persist();
      retryFailedPod = false;
    }
    while (Date.now() < deadline) {
      try {
        await ensure("Namespace", namespace);
        const claim = await ensure(
          "PersistentVolumeClaim",
          claimName,
          runtimeVolumeClaimSpec("8Gi", { FACTORY_STORAGE_CLASS: intent.storageClass ?? "" }),
        );
        const pod = await ensure("Pod", probeName, {
          nodeSelector: { "kubernetes.io/os": "linux" },
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 1,
          securityContext: {
            runAsUser: 101000,
            runAsGroup: 101000,
            runAsNonRoot: true,
            fsGroup: 101000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [{ name: "data", persistentVolumeClaim: { claimName } }],
          containers: [
            {
              name: probeName,
              image: intent.image,
              imagePullPolicy: "IfNotPresent",
              command: [
                "/bin/sh",
                "-c",
                `set -eu; printf '%s' '${intent.id}' > /data/factory-storage-check; sync -d /data/factory-storage-check; test "$(cat /data/factory-storage-check)" = '${intent.id}'`,
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: { requests: { cpu: "5m", memory: "8Mi" }, limits: { memory: "32Mi" } },
              volumeMounts: [{ name: "data", mountPath: "/data" }],
            },
          ],
        });
        const snapshot = await capture(claim, pod);
        if (snapshot.pod.phase === "Failed" && retryFailedPod) {
          intent.podDeleteIntended = true;
          await persist();
          await remove("Pod", "pods", probeName, intent.podUID);
          intent.podUID = null;
          intent.podDeleteIntended = false;
          retryFailedPod = false;
          await persist();
          continue;
        }
        if (snapshot.pod.phase === "Failed")
          throw new Error("Runtime storage write/read check failed");
        if (
          claim.status["phase"] === "Bound" &&
          snapshot.pod.phase === "Succeeded" &&
          snapshot.pod.containers.length === 1 &&
          snapshot.pod.containers[0]?.name === probeName &&
          snapshot.pod.containers[0]?.state.terminated?.exitCode === 0
        ) {
          const volumeName = z.string().min(1).parse(claim.spec["volumeName"]);
          const volume = await get("PersistentVolume", volumeName, false);
          if (
            !volume ||
            z.object({ uid: z.string() }).parse(volume.spec["claimRef"]).uid !== intent.claimUID
          )
            throw new Error("Storage-check volume identity differs from the owned claim");
          intent.volume = { name: volumeName, uid: volume.metadata.uid };
          verified = true;
          intent.writeVerified = true;
          intent.cleanupIntended = true;
          await persist();
          await diagnostic();
          await cleanup();
          await diagnostic();
          return {
            checkID: intent.id,
            namespace,
            elapsedMS: Math.round(performance.now() - started),
            diagnosticFile,
          };
        }
      } catch (cause) {
        if (!(cause instanceof StorageObservationUnavailable) || intent.cleanupIntended)
          throw cause;
      }
      await Bun.sleep(input.intervalMS ?? 1_000);
    }
    throw new Error("Runtime storage did not establish a successful write/read check");
  } catch (cause) {
    // Do not discard an unconfirmed create, replace its identity or delete a
    // Pending claim while its provisioner may still be creating external storage.
    const error = cause instanceof Error ? cause.message : "Runtime storage check failed";
    await diagnostic(error);
    throw new Error(`${error}. Storage readiness was not confirmed. Diagnostics: ${failureFile}`);
  }
}
