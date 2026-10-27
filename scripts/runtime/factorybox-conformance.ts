import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import {
  factoryboxAssignmentSecret,
  factoryboxLocation,
  factoryboxSharedLabels,
} from "../../packages/runtime-kubernetes/src/factorybox-location";
import {
  createFactoryboxMetrics,
  readFactoryboxSandboxSample,
} from "../../packages/runtime-kubernetes/src/factorybox-metrics";
import {
  factoryboxObsoleteCheckpoints,
  factoryboxObsoleteResumeImages,
} from "../../packages/runtime-kubernetes/src/factorybox-retention";
import {
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
  factoryboxSandboxID,
  prepareFactoryboxRuntime,
  releaseFactoryboxRuntime,
  renderFactoryboxRuntime,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  executeFactoryboxOperation,
  type FactoryboxOperation,
  type FactoryboxWorkerIdentity,
  inspectFactoryboxWorker,
} from "../../packages/runtime-kubernetes/src/factorybox-worker";

export const conformanceLabel = "factory.dev/conformance-owner";

export function conformanceResources(
  owner: string,
  image: string,
  profile: FactoryboxRuntimeProfile,
  certificate: string,
) {
  const input = {
    ...factoryboxLocation(owner),
    attemptID: owner,
    sandboxID: factoryboxSandboxID(owner),
    reserve: true,
    runtimeOwnerID: owner,
    runtimeHostImage: image,
    profile,
    sharedSource: false,
    labels: {
      "app.kubernetes.io/managed-by": "open-software-factory",
      "factory.dev/runtime-owner": owner,
      "factory.dev/execution-slot": owner,
    },
  };
  const declaration = renderFactoryboxRuntime(input);
  const items = [
    declaration.namespace,
    declaration.claim,
    declaration.sourceClaim,
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "registry-ca",
        namespace: input.namespace,
        labels: factoryboxSharedLabels(input.workerID),
      },
      stringData: { "ca.crt": certificate },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: factoryboxAssignmentSecret(owner),
        namespace: input.namespace,
        labels: input.labels,
      },
      stringData: {
        "slot.json": JSON.stringify({
          version: 1,
          id: owner,
          role: "staging",
          images: [],
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
      },
    },
    declaration.pod,
  ].map((resource) => ({
    ...resource,
    metadata: {
      ...resource.metadata,
      labels: {
        ...("labels" in resource.metadata ? resource.metadata.labels : {}),
        [conformanceLabel]: owner,
      },
    },
  }));
  return { input, declaration, items };
}

export function ownedConformanceNamespace(value: unknown, owner: string) {
  const { namespace } = factoryboxLocation(owner);
  return z
    .object({
      metadata: z.object({
        name: z.literal(namespace),
        uid: z.string().min(1),
        labels: z.object({ [conformanceLabel]: z.literal(owner) }),
      }),
    })
    .parse(value).metadata;
}

export function conformanceNamespaceRemoved(
  value: unknown | undefined,
  owner: string,
  originalUID: string,
) {
  if (value === undefined) return true;
  const namespace = ownedConformanceNamespace(value, owner);
  if (namespace.uid !== originalUID)
    throw new Error("Conformance namespace UID changed during cleanup");
  return false;
}

// This fixture uses the actual configured API server and the product's exact
// manifests and preparation/lifecycle adapters. No fixture Kubernetes replies.
export function createConformanceRuntime(
  owner: string,
  image: string,
  profile: FactoryboxRuntimeProfile,
  certificate: string,
  artifacts: string,
) {
  const resources = conformanceResources(owner, image, profile, certificate);
  const { input, declaration } = resources;
  const request = factoryboxRuntimeRequest(input);
  const deadline = performance.now() + 420_000;
  let identity: FactoryboxWorkerIdentity | undefined;
  let record: { id: string; owner: string; input_sha256: string; runtime_id: string } | undefined;
  let started = false,
    succeeded = false;
  let sequence = 0;
  const run = async (
    args: readonly string[],
    body?: string,
    limits?: { timeoutMS?: number; outputBytes?: number },
  ) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Factorybox conformance lifecycle exceeded 420 seconds");
    return runCommand(kubernetesCommand(args), body, {
      timeoutMS: Math.min(remaining, limits?.timeoutMS ?? 15_000),
      outputBytes: limits?.outputBytes ?? 4 * 1024 ** 2,
    });
  };
  const command = async (args: string[], body?: string) => {
    const result = await run(args, body);
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "Factorybox cluster command failed");
    return result.stdout;
  };
  const save = (name: string, value: unknown) =>
    writeFile(resolve(artifacts, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  const metrics = createFactoryboxMetrics((target) => readFactoryboxSandboxSample(target, run));
  const operation = async (value: FactoryboxOperation) => {
    if (!identity) throw new Error("Worker has no admitted cluster identity");
    const name = `${++sequence}-${value.action}`;
    await save(`${name}-intent.json`, { request, identity, operation: value });
    const result = await executeFactoryboxOperation(request, identity, value, run, declaration);
    await save(`${name}-result.json`, result);
    if (!result.confirmed)
      throw new Error(`Native ${value.action} remains unconfirmed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return {
    namespace: input.namespace,
    pod: input.podName,
    architecture: profile.architecture,
    async prepare() {
      await save("intent.json", { owner, input, resources: resources.items });
      await command(
        ["create", "-f", "-"],
        JSON.stringify({ apiVersion: "v1", kind: "List", items: resources.items }),
      );
      for (;;) {
        const pod = JSON.parse(
          await command(["get", "pod", input.podName, "-n", input.namespace, "-o", "json"]),
        );
        if (
          pod.status?.conditions?.some(
            (condition: { type: string; status: string }) =>
              condition.type === "Ready" && condition.status === "True",
          )
        )
          break;
        if (
          ["Failed", "Succeeded"].includes(pod.status?.phase) ||
          [
            ...(pod.status?.initContainerStatuses ?? []),
            ...(pod.status?.containerStatuses ?? []),
          ].some((container) => container.state?.terminated?.exitCode > 0)
        )
          throw new Error("Original Factorybox cluster worker terminated before HTTP readiness");
        if (deadline - performance.now() < 120_000)
          throw new Error(
            "Factorybox cluster worker did not become ready within its preparation window",
          );
        await Bun.sleep(1000);
      }
      identity = await inspectFactoryboxWorker(request, undefined, run, declaration);
      await save("worker-identity.json", identity);
      const prepared = await prepareFactoryboxRuntime(
        input,
        identity,
        run,
        deadline - performance.now(),
      );
      await save("preparation.json", prepared);
      started = true;
      const view = await operation({
        action: "start",
        sandboxID: input.sandboxID,
        bundle: prepared.bundle,
      });
      record = z
        .object({
          id: z.literal(input.sandboxID),
          owner: z.string(),
          input_sha256: z.string(),
          runtime_id: z.string(),
        })
        .parse(view.record);
      await save("started.json", view);
    },
    execArgs(args: string[], interactive = false, user?: string) {
      if (!identity || !record) throw new Error("Factorybox conformance Sandbox is not running");
      return kubernetesCommand([
        "exec",
        ...(interactive ? ["-i"] : []),
        "-n",
        input.namespace,
        input.podName,
        "-c",
        "worker",
        "--",
        "/opt/factorybox/components/sysbox-runc",
        "--root",
        `${identity.controllerRoot}/runtime`,
        "exec",
        ...(user ? ["--user", user] : []),
        record.runtime_id,
        ...args,
      ]);
    },
    async boundary() {
      if (!record) throw new Error("Conformance has no original Sandbox");
      const view = await operation({ action: "state", sandboxID: input.sandboxID });
      if (
        view.record.runtime_id !== record?.runtime_id ||
        view.runtime?.status !== "running" ||
        view.record.owner !== record.owner
      )
        throw new Error("Factorybox cluster Sandbox identity changed");
      await command([
        "exec",
        "-n",
        input.namespace,
        input.podName,
        "-c",
        "worker",
        "--",
        "sh",
        "-ec",
        "test ! -S /var/run/docker.sock; test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token",
      ]);
      return view;
    },
    async metrics() {
      if (!identity) throw new Error("Metrics require the original admitted worker");
      return metrics({ input, identity });
    },
    async pauseResume() {
      const snapshotID = crypto.randomUUID().replaceAll("-", "");
      const paused = await operation({ action: "pause", sandboxID: input.sandboxID, snapshotID });
      if (
        paused.record.pause?.after?.anon !== 0 ||
        paused.record.pause?.snapshot?.resident_bytes_after !== 0
      )
        throw new Error("Cluster Pause did not release its Sandbox RAM and snapshot pages");
      await operation({ action: "resume", sandboxID: input.sandboxID, snapshotID });
      return { snapshotID, paused };
    },
    async passed() {
      if (performance.now() > deadline)
        throw new Error("Conformance workload exceeded its 420-second deadline");
      await save("workload-complete.json", {
        owner,
        passed: true,
        elapsedMS: performance.now() - (deadline - 420_000),
      });
      succeeded = true;
    },
    async cleanup() {
      if (started && !succeeded) {
        await save("retained-failure.json", {
          owner,
          namespace: input.namespace,
          reason:
            "Unresolved native evidence and private store are retained. The uniquely owned Pod is fenced to release fixture RAM; the PVCs must not be deleted.",
        });
        const observed = await runCommand(
          kubernetesCommand(["get", "pod", input.podName, "-n", input.namespace, "-o", "json"]),
          undefined,
          { timeoutMS: 15_000, outputBytes: 1024 ** 2 },
        );
        if (
          observed.exitCode !== 0 ||
          !identity ||
          JSON.parse(observed.stdout).metadata?.uid !== identity.podUID
        )
          throw new Error("Cannot fence a changed or unobserved failed conformance worker");
        const marked = await runCommand(
          kubernetesCommand([
            "patch",
            "namespace",
            input.namespace,
            "--type=merge",
            "-p",
            JSON.stringify({
              metadata: {
                uid: identity.namespaceUID,
                annotations: { "factory.dev/conformance-evidence": "retained" },
              },
            }),
          ]),
          undefined,
          { timeoutMS: 15_000, outputBytes: 1024 ** 2 },
        );
        if (marked.exitCode !== 0)
          throw new Error("Cannot preserve the failed fixture's storage ownership");
        const fenced = await runCommand(
          kubernetesCommand([
            "delete",
            "--raw",
            `/api/v1/namespaces/${input.namespace}/pods/${input.podName}`,
            "-f",
            "-",
          ]),
          JSON.stringify({
            apiVersion: "v1",
            kind: "DeleteOptions",
            preconditions: { uid: identity.podUID },
            gracePeriodSeconds: 45,
          }),
          { timeoutMS: 15_000, outputBytes: 1024 ** 2 },
        );
        if (fenced.exitCode !== 0)
          throw new Error("Failed fixture worker fencing remains unconfirmed");
        const absent = await runCommand(
          kubernetesCommand([
            "wait",
            "--for=delete",
            `pod/${input.podName}`,
            "-n",
            input.namespace,
            "--timeout=60s",
          ]),
          undefined,
          { timeoutMS: 65_000, outputBytes: 1024 ** 2 },
        );
        if (absent.exitCode !== 0)
          throw new Error("Failed fixture worker has not released its Pod yet");
        await save("worker-fenced.json", { podUID: identity.podUID, privateStoreRetained: true });
        return;
      }
      if (identity && record) {
        const deleted = await operation({ action: "delete", sandboxID: input.sandboxID });
        for (const [action, generations] of [
          ["retire-checkpoint", factoryboxObsoleteCheckpoints(input.sandboxID, deleted.record)],
          ["retire-resume", factoryboxObsoleteResumeImages(input.sandboxID, deleted.record)],
        ] as const)
          for (const generation of generations)
            await operation({
              action,
              sandboxID: input.sandboxID,
              snapshotID: generation.snapshot_id,
              sourceOwner: generation.source_owner,
              checkpointSHA256: generation.checkpoint_sha256,
            });
        await releaseFactoryboxRuntime(input, identity, false, run);
        await operation({
          action: "retire-sandbox",
          sandboxID: input.sandboxID,
          sandboxOwner: record.owner,
          inputSHA256: record.input_sha256,
        });
      }
      // Only a uniquely owned namespace can be removed, never the shared
      // Registry or retained installation. The API server checks its UID.
      const observed = await run([
        "get",
        "namespace",
        input.namespace,
        "--ignore-not-found",
        "-o",
        "json",
      ]);
      if (observed.exitCode !== 0)
        throw new Error("Conformance cleanup cannot observe its namespace");
      if (!observed.stdout.trim()) return;
      const namespace = ownedConformanceNamespace(JSON.parse(observed.stdout), owner);
      if (identity && namespace.uid !== identity.namespaceUID)
        throw new Error("Conformance cleanup cannot delete a replacement namespace");
      const deletion = {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: namespace.uid },
      };
      await save("cleanup-intent.json", { owner, namespace, deletion });
      try {
        const response = await run(
          ["delete", "--raw", `/api/v1/namespaces/${namespace.name}`, "-f", "-"],
          JSON.stringify(deletion),
          { timeoutMS: 60_000 },
        );
        await save("cleanup-request.json", {
          exitCode: response.exitCode,
          stderr: response.stderr.slice(-2048),
        });
      } catch (cause) {
        await save("cleanup-request.json", {
          unconfirmed: true,
          error: cause instanceof Error ? cause.message : "Deletion output was lost",
        });
      }
      // Namespace teardown may outlast one response window. Observe that exact
      // original request after lost output, never issue a second Delete.
      for (;;) {
        const current = await run([
          "get",
          "namespace",
          namespace.name,
          "--ignore-not-found",
          "-o",
          "json",
        ]);
        if (current.exitCode !== 0) throw new Error("Namespace cleanup observation is unavailable");
        if (
          conformanceNamespaceRemoved(
            current.stdout.trim() ? JSON.parse(current.stdout) : undefined,
            owner,
            namespace.uid,
          )
        ) {
          await save("cleanup.json", {
            owner,
            namespace,
            deletionRequested: true,
            absenceConfirmed: true,
          });
          return;
        }
        await Bun.sleep(1000);
      }
    },
  };
}
