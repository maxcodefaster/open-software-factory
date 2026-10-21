import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { disposeRuntimeStorageCheck, requireWritableRuntimeStorage } from "./storage-readiness";

const image = `registry.invalid/workspace-files@sha256:${"a".repeat(64)}`;
function argument(args: string[], index: number) {
  const value = args[index];
  if (!value) throw new Error("Missing test command argument");
  return value;
}
type Resource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; uid: string; labels: Record<string, string> };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
};

class Cluster {
  resources = new Map<string, Resource>();
  calls: Array<{ args: string[]; body: Record<string, unknown> | undefined }> = [];
  pending = false;
  neverComplete = false;
  foreignVolume = false;
  failFirstPod = false;
  retainedPolicy = false;
  keepVolume = false;
  loseNamespaceResponse = false;
  loseClaimDeletionResponse = false;
  mutatePod = false;
  replaceNamespace = false;
  foreignSecret = false;
  helper = false;
  podCreates = 0;
  beforeCreate: (() => Promise<void>) | undefined;
  key(kind: string, name: string) {
    return `${kind}/${name}`;
  }
  async invoke(argv: readonly string[], input?: string) {
    if (argv[0] === "docker") {
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          argv[1] === "ps"
            ? "abcdefabcdef\n"
            : JSON.stringify({
                Status: "exited",
                Running: false,
                ExitCode: 1,
                OOMKilled: false,
                StartedAt: "2026-10-21T00:00:00Z",
                FinishedAt: "2026-10-21T00:00:01Z",
                Error: "secret-sentinel",
              }),
      };
    }
    const first = argv.findIndex((arg) => ["get", "create", "delete", "patch"].includes(arg));
    const args = [...argv.slice(first)];
    const body = input ? (JSON.parse(input) as Record<string, unknown>) : undefined;
    this.calls.push({ args, body });
    const ok = (value?: unknown) => ({
      exitCode: 0,
      stderr: "",
      stdout: value ? JSON.stringify(value) : "",
    });
    if (args[0] === "create") {
      await this.beforeCreate?.();
      const item = structuredClone(body) as unknown as Resource;
      item.metadata.uid = `uid-${this.calls.length}`;
      item.spec ??= {};
      item.status = {};
      if (item.kind === "PersistentVolumeClaim") item.status["phase"] = "Pending";
      if (item.kind === "Pod") {
        this.podCreates++;
        if (this.mutatePod)
          item.spec["containers"] = [
            {
              name: "storage-check",
              image,
              command: ["/bin/sh", "-c", "exit 0"],
            },
          ];
        item.status["phase"] = this.failFirstPod && this.podCreates === 1 ? "Failed" : "Pending";
      }
      this.resources.set(this.key(item.kind, item.metadata.name), item);
      if (item.kind === "Namespace" && this.loseNamespaceResponse) {
        this.loseNamespaceResponse = false;
        throw new Error("Infrastructure command timed out; outcome is unconfirmed");
      }
      return ok(item);
    }
    if (args[0] === "get" && args[1] === "pods" && args.includes("--all-namespaces")) {
      if (!this.helper) return ok({ items: [] });
      return ok({
        items: [
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: { name: "helper", namespace: "kube-system", uid: "helper-uid", labels: {} },
            spec: { env: [{ name: "API_KEY", value: "secret-sentinel" }] },
            status: {
              phase: "Running",
              containerStatuses: [
                {
                  name: "helper-pod",
                  state: { running: { startedAt: "2026-10-21T00:00:00Z" } },
                  lastState: { terminated: { message: "secret-sentinel" } },
                },
              ],
            },
          },
        ],
      });
    }
    if (args[0] === "get" && args[1]?.startsWith("all,")) {
      return ok({
        items: this.foreignSecret
          ? [
              {
                apiVersion: "v1",
                kind: "Secret",
                metadata: { name: "foreign", uid: "foreign", labels: {} },
              },
            ]
          : [],
      });
    }
    if (args[0] === "get") {
      const kind = args[1] === "pv" ? "PersistentVolume" : argument(args, 1);
      const item = this.resources.get(this.key(kind, argument(args, 2)));
      if (!item) return ok();
      if (
        kind === "Namespace" &&
        this.replaceNamespace &&
        [...this.resources.values()].some(
          (value) => value.kind === "Pod" && value.status["phase"] === "Succeeded",
        )
      )
        item.metadata.uid = "replacement";
      if (kind === "PersistentVolumeClaim" && !this.pending) {
        item.status["phase"] = "Bound";
        const name = `pvc-${item.metadata.uid}`;
        item.spec["volumeName"] = name;
        if (!this.resources.has(this.key("PersistentVolume", name)))
          this.resources.set(this.key("PersistentVolume", name), {
            apiVersion: "v1",
            kind: "PersistentVolume",
            metadata: { name, uid: "volume-uid", labels: {} },
            status: {},
            spec: {
              claimRef: {
                uid: this.foreignVolume ? "foreign-claim" : item.metadata.uid,
                name: item.metadata.name,
                namespace: item.metadata.namespace,
              },
              persistentVolumeReclaimPolicy: this.retainedPolicy ? "Retain" : "Delete",
            },
          });
      }
      if (kind === "Pod" && !this.pending && item.status["phase"] !== "Failed") {
        item.status["phase"] = this.neverComplete ? "Running" : "Succeeded";
        item.status["containerStatuses"] = [
          {
            name: "storage-check",
            state: {
              terminated: {
                exitCode: 0,
                reason: "Completed",
                finishedAt: "2026-10-21T00:00:02Z",
              },
            },
          },
        ];
      }
      return ok(item);
    }
    if (args[0] === "patch") {
      const item = this.resources.get(this.key("PersistentVolume", argument(args, 2)));
      if (!item) throw new Error("Missing owned test volume");
      const patch = JSON.parse(argument(args, args.indexOf("-p") + 1)) as Array<{
        path: string;
        value: unknown;
      }>;
      expect(patch[0]).toMatchObject({ path: "/metadata/uid", value: item.metadata.uid });
      expect(patch[1]).toMatchObject({
        path: "/spec/claimRef/uid",
        value: (item.spec["claimRef"] as { uid: string }).uid,
      });
      item.spec["persistentVolumeReclaimPolicy"] = "Delete";
      return ok();
    }
    if (args[0] === "delete") {
      const path = argument(args, args.indexOf("--raw") + 1);
      const parts = path.split("/");
      const plural = parts.at(-2);
      const kind =
        plural === "pods"
          ? "Pod"
          : plural === "persistentvolumeclaims"
            ? "PersistentVolumeClaim"
            : "Namespace";
      const key = this.key(kind, argument(parts, parts.length - 1));
      const item = this.resources.get(key);
      if (!item) throw new Error("Missing owned test resource");
      expect(body?.["preconditions"]).toEqual({ uid: item.metadata.uid });
      this.resources.delete(key);
      if (kind === "PersistentVolumeClaim") {
        if (!this.keepVolume)
          this.resources.delete(this.key("PersistentVolume", String(item.spec["volumeName"])));
        if (this.loseClaimDeletionResponse) {
          this.loseClaimDeletionResponse = false;
          throw new Error("Infrastructure command timed out; outcome is unconfirmed");
        }
      }
      return ok();
    }
    throw new Error(`Unexpected test operation ${args.join(" ")}`);
  }
  run: typeof runCommand = (argv, input) => this.invoke(argv, input);
}

async function fixture(run: (directory: string, cluster: Cluster) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "factory-storage-readiness-"));
  try {
    await run(directory, new Cluster());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const options = (stateDirectory: string) => ({
  stateDirectory,
  image,
  timeoutMS: 100,
  cleanupTimeoutMS: 100,
  intervalMS: 1,
});

test("storage readiness requires a real owned RWO write/read check and confirms volume cleanup", () =>
  fixture(async (directory, cluster) => {
    cluster.beforeCreate = async () => {
      const intent = JSON.parse(await readFile(join(directory, "storage-readiness.json"), "utf8"));
      expect(intent.id).toBeTruthy();
    };
    const result = await requireWritableRuntimeStorage(options(directory), cluster.run);
    const diagnostic = JSON.parse(await readFile(result.diagnosticFile, "utf8"));
    expect(diagnostic).toMatchObject({ verified: true, cleanupConfirmed: true });
    expect(cluster.resources.size).toBe(0);
    const pod = cluster.calls.find((call) => call.body?.["kind"] === "Pod")?.body;
    expect(pod?.["spec"]).toMatchObject({
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 101000, fsGroup: 101000 },
      volumes: [{ persistentVolumeClaim: { claimName: "runtime-data" } }],
      containers: [{ image, securityContext: { readOnlyRootFilesystem: true } }],
    });
    expect(JSON.stringify(pod)).toContain("sync -d /data/factory-storage-check; test");
    await expect(readFile(join(directory, "storage-readiness.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }));

test("a bound volume and zero exit code do not bypass a still-Running Pod", () =>
  fixture(async (directory, cluster) => {
    cluster.neverComplete = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "readiness was not confirmed",
    );
    expect(cluster.calls.some((call) => call.args[0] === "delete")).toBe(false);
  }));

test("a backing volume bound to another claim is never patched or deleted", () =>
  fixture(async (directory, cluster) => {
    cluster.foreignVolume = true;
    cluster.retainedPolicy = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "volume identity differs",
    );
    expect(cluster.calls.some((call) => ["patch", "delete"].includes(call.args[0] ?? ""))).toBe(
      false,
    );
  }));

test("reachable Kubernetes with an unbound claim cannot pass readiness or discard the in-flight create", () =>
  fixture(async (directory, cluster) => {
    cluster.pending = true;
    cluster.helper = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "readiness was not confirmed",
    );
    const intent = JSON.parse(await readFile(join(directory, "storage-readiness.json"), "utf8"));
    const diagnostic = JSON.parse(
      await readFile(join(directory, "storage-readiness-diagnostic.json"), "utf8"),
    );
    expect(intent).toMatchObject({ cleanupIntended: false });
    expect(cluster.calls.some((call) => call.args[0] === "delete")).toBe(false);
    expect(diagnostic.snapshots[0]).toMatchObject({
      claim: { phase: "Pending" },
      helpers: [{ phase: "Running", actual: { Status: "exited", ExitCode: 1 } }],
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret-sentinel");
    cluster.pending = false;
    const result = await requireWritableRuntimeStorage(options(directory), cluster.run);
    expect(result.checkID).toBe(intent.id);
    expect(cluster.calls.filter((call) => call.args[0] === "create")).toHaveLength(3);
    const failure = JSON.parse(
      await readFile(join(directory, "storage-readiness-failure.json"), "utf8"),
    );
    expect(failure).toMatchObject({ checkID: intent.id, verified: false });
    expect(failure.snapshots[0].helpers[0].actual.ExitCode).toBe(1);
    expect(JSON.stringify(failure)).not.toContain("secret-sentinel");
  }));

test("a lost Namespace-create response reobserves the same persisted identity without duplicate creates", () =>
  fixture(async (directory, cluster) => {
    cluster.loseNamespaceResponse = true;
    const result = await requireWritableRuntimeStorage(options(directory), cluster.run);
    expect(result.checkID).toBeTruthy();
    expect(cluster.calls.filter((call) => call.args[0] === "create")).toHaveLength(3);
    expect(cluster.resources.size).toBe(0);
  }));

test("a replaced Namespace prevents cleanup and preserves its exact retained intent", () =>
  fixture(async (directory, cluster) => {
    cluster.replaceNamespace = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "identity or ownership changed",
    );
    expect(cluster.calls.some((call) => call.args[0] === "delete")).toBe(false);
    expect(cluster.resources.size).toBe(4);
  }));

test("an adopted Pod cannot replace the actual write/read command with a successful no-op", () =>
  fixture(async (directory, cluster) => {
    cluster.mutatePod = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "differs from its retained intent",
    );
    expect(cluster.calls.some((call) => call.args[0] === "delete")).toBe(false);
  }));

test("retained storage policy is changed only for the exact probe volume and claim", () =>
  fixture(async (directory, cluster) => {
    cluster.retainedPolicy = true;
    await requireWritableRuntimeStorage(options(directory), cluster.run);
    expect(cluster.calls.filter((call) => call.args[0] === "patch")).toHaveLength(1);
    expect(cluster.resources.size).toBe(0);
  }));

test("an unconfirmed claim deletion resumes cleanup before admitting another probe", () =>
  fixture(async (directory, cluster) => {
    cluster.loseClaimDeletionResponse = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "readiness was not confirmed",
    );
    const previous = JSON.parse(await readFile(join(directory, "storage-readiness.json"), "utf8"));
    expect(previous.cleanupIntended).toBe(true);
    const result = await requireWritableRuntimeStorage(options(directory), cluster.run);
    expect(result.checkID).not.toBe(previous.id);
    expect(cluster.resources.size).toBe(0);
  }));

test("a successful probe cannot announce readiness while its volume still exists", () =>
  fixture(async (directory, cluster) => {
    cluster.keepVolume = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "volume cleanup is not confirmed",
    );
    const intent = JSON.parse(await readFile(join(directory, "storage-readiness.json"), "utf8"));
    expect(intent).toMatchObject({ cleanupIntended: true, volume: { uid: "volume-uid" } });
  }));

test("unexpected resources prevent Namespace deletion instead of deleting someone else's data", () =>
  fixture(async (directory, cluster) => {
    cluster.foreignSecret = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "unexpected resources",
    );
    expect(
      cluster.calls.some(
        (call) => call.args[0] === "delete" && call.args[2]?.endsWith("/namespaces"),
      ),
    ).toBe(false);
    expect([...cluster.resources.values()].some((item) => item.kind === "Namespace")).toBe(true);
  }));

test("a failed probe process is replaced only on the next explicit startup, retaining the same claim", () =>
  fixture(async (directory, cluster) => {
    cluster.failFirstPod = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "write/read check failed",
    );
    expect(cluster.podCreates).toBe(1);
    const previous = JSON.parse(await readFile(join(directory, "storage-readiness.json"), "utf8"));
    const result = await requireWritableRuntimeStorage(options(directory), cluster.run);
    expect(result.checkID).toBe(previous.id);
    expect(cluster.podCreates).toBe(2);
    expect(
      cluster.calls.filter(
        (call) => call.args[0] === "create" && call.body?.["kind"] === "PersistentVolumeClaim",
      ),
    ).toHaveLength(1);
  }));

test("explicit disposable cleanup neither creates resources nor abandons an unconfirmed Pending volume", () =>
  fixture(async (directory, cluster) => {
    await disposeRuntimeStorageCheck(directory, cluster.run);
    expect(cluster.calls).toHaveLength(0);
    cluster.pending = true;
    await expect(requireWritableRuntimeStorage(options(directory), cluster.run)).rejects.toThrow(
      "readiness was not confirmed",
    );
    const creates = cluster.calls.filter((call) => call.args[0] === "create").length;
    await expect(disposeRuntimeStorageCheck(directory, cluster.run)).rejects.toThrow(
      "must settle before cleanup",
    );
    expect(cluster.calls.filter((call) => call.args[0] === "create")).toHaveLength(creates);
    cluster.pending = false;
    await disposeRuntimeStorageCheck(directory, cluster.run);
    expect(cluster.resources.size).toBe(0);
  }));
