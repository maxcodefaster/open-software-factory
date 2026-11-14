// Read-only native installation preflight. No Actors, worker probes or namespaces
// are created. Actual Actor assignment and runtime qualification remain separate.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { substrateResourceReservation } from "../../apps/factory/src/runtime/substrate-resources";
import { runCommand, runEnvironmentCommand } from "../../packages/runtime-kubernetes/src/command";
import {
  kubernetesCommand,
  kubernetesConnectionEnvironment,
} from "../../packages/runtime-kubernetes/src/config";
import { serviceAccountConfiguration } from "../../packages/runtime-kubernetes/src/service-account";
import {
  nativeCapacityNodeReady,
  requireNativeCapacityBase,
  requireNativeCapacitySandbox,
} from "../../packages/runtime-kubernetes/src/substrate-capacity";
import { nativeRuntimeArchitecture } from "../../packages/runtime-kubernetes/src/substrate-profile";
import { kubernetesResourceQuantity } from "../../packages/runtime-kubernetes/src/worker-resource-admission";
import {
  requireNativeForgeOrigin,
  requireNativeInstallation,
} from "../factory/native-installation";

export type Kubectl = (
  args: readonly string[],
  input?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type PreflightCheck = {
  id: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
  fix?: string;
};
export type PreflightOptions = {
  configuration: ReturnType<typeof requireNativeInstallation>;
  storageClass?: string | undefined;
  releaseNamespace: string;
};
export const kubectl: Kubectl = (args, input) =>
  runCommand(kubernetesCommand(["--request-timeout=10s", ...args]), input, {
    timeoutMS: 15_000,
    outputBytes: 8 * 1024 * 1024,
  });

async function runConfiguredPreflight(options: PreflightOptions, serviceAccount: boolean) {
  if (!serviceAccount) return runPreflight(options);
  const directory = await mkdtemp(join(tmpdir(), "factory-preflight-"));
  try {
    const kubeconfig = join(directory, "config.json");
    await writeFile(kubeconfig, JSON.stringify(serviceAccountConfiguration()), {
      flag: "wx",
      mode: 0o600,
    });
    const environment = kubernetesConnectionEnvironment({
      ...process.env,
      KUBECONFIG: kubeconfig,
      FACTORY_KUBERNETES_CONTEXT: "factory",
    });
    return await runPreflight(options, (args, input) =>
      runEnvironmentCommand(
        kubernetesCommand(["--request-timeout=10s", ...args], environment),
        environment,
        { timeoutMS: 15_000, outputBytes: 8 * 1024 * 1024 },
        input,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const nodeSchema = z.object({
  metadata: z.object({
    name: z.string(),
    uid: z.string(),
    labels: z.record(z.string(), z.string()),
  }),
  status: z.object({ nodeInfo: z.object({ bootID: z.string() }) }),
});
const podSchema = z.object({
  metadata: z.object({
    namespace: z.string(),
    deletionTimestamp: z.string().optional(),
    labels: z.record(z.string(), z.string()),
  }),
  spec: z.object({
    nodeName: z.string().optional(),
    containers: z.array(z.object({ image: z.string() })),
  }),
  status: z.object({
    phase: z.string().optional(),
    conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
  }),
});

export async function runPreflight(
  options: PreflightOptions,
  run: Kubectl = kubectl,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const config = options.configuration;
  const architecture = nativeRuntimeArchitecture(config.runtime);
  const selector = Object.entries(config.workerSelector)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  async function observe(id: string, operation: () => Promise<string>, fix: string) {
    try {
      checks.push({ id, status: "PASS", message: await operation() });
    } catch (cause) {
      checks.push({
        id,
        status: "FAIL",
        message: cause instanceof Error ? cause.message : "Native observation is unavailable",
        fix,
      });
    }
  }
  async function json(args: string[]) {
    const result = await run([...args, "-o", "json"]);
    if (result.exitCode !== 0) throw new Error("Kubernetes observation is unavailable");
    return JSON.parse(result.stdout) as unknown;
  }
  await observe(
    "native.sandbox",
    async () => {
      requireNativeCapacitySandbox(await json(["get", "sandboxconfig", config.profile]));
      return "The SandboxConfig matches the exact pinned native ROOTFS profile";
    },
    "Install the pinned Substrate SandboxConfig; do not change its identity to hide a mismatch",
  );
  await observe(
    "native.capacity",
    async () => {
      const base = requireNativeCapacityBase(
        await json(["get", "workerpools", "-A", "-l", selector]),
        config.workerSelector,
        architecture,
      );
      const reservation = substrateResourceReservation(config);
      const cpu = kubernetesResourceQuantity(base.spec.template.resources.limits["cpu"], "cpu");
      const memory = Math.floor(
        kubernetesResourceQuantity(base.spec.template.resources.limits["memory"], "memory") /
          1024 ** 2,
      );
      if (
        !Number.isFinite(cpu) ||
        !Number.isFinite(memory) ||
        cpu < reservation.cpuMilli ||
        memory < reservation.memoryMiB
      )
        throw new Error("The original native WorkerPool cannot admit the configured Actor limits");
      if (base.status?.readyReplicas !== 1)
        throw new Error("The original native WorkerPool has no confirmed Ready replica");
      const nodesInput = await json(["get", "nodes"]);
      const nodes = z.object({ items: z.array(nodeSchema) }).parse(nodesInput).items;
      const readyNodes = nodes.filter(
        (node) =>
          Object.entries(base.spec.template.nodeSelector).every(
            ([key, value]) => node.metadata.labels[key] === value,
          ) &&
          nativeCapacityNodeReady(nodesInput, {
            name: node.metadata.name,
            uid: node.metadata.uid,
            bootID: node.status.nodeInfo.bootID,
            hostname: node.metadata.labels["kubernetes.io/hostname"] ?? "",
            architecture,
            resources: { cpuMilli: cpu, memoryMiB: memory },
          }),
      );
      if (!readyNodes.length)
        throw new Error(
          `The original native WorkerPool has no suitable Ready linux/${architecture} node`,
        );
      const pods = z
        .object({ items: z.array(podSchema) })
        .parse(
          await json(["get", "pods", "-n", base.metadata.namespace ?? "", "-l", selector]),
        ).items;
      if (
        !pods.some(
          (pod) =>
            pod.metadata.namespace === base.metadata.namespace &&
            !pod.metadata.deletionTimestamp &&
            readyNodes.some((node) => node.metadata.name === pod.spec.nodeName) &&
            pod.spec.containers.some((container) => container.image === base.spec.workerImage) &&
            pod.status.phase === "Running" &&
            pod.status.conditions?.some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            ),
        )
      )
        throw new Error(
          "The original native WorkerPool has no observed Ready worker Pod at its pinned image",
        );
      return `The original pinned WorkerPool has a Ready ${architecture} worker and finite Actor capacity`;
    },
    `Install and qualify the original native WorkerPool on a suitable joined ${architecture} node`,
  );
  await observe(
    "storage.class",
    async () => {
      const classes = z
        .object({
          items: z.array(
            z.object({
              metadata: z.object({
                name: z.string(),
                deletionTimestamp: z.string().optional(),
                annotations: z.record(z.string(), z.string()).optional(),
              }),
              provisioner: z.string(),
            }),
          ),
        })
        .parse(await json(["get", "storageclasses"])).items;
      const selected = classes.filter((value) =>
        options.storageClass
          ? value.metadata.name === options.storageClass
          : value.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] ===
              "true" ||
            value.metadata.annotations?.["storageclass.beta.kubernetes.io/is-default-class"] ===
              "true",
      );
      if (
        selected.length !== 1 ||
        !selected[0] ||
        selected[0].metadata.deletionTimestamp ||
        selected[0].provisioner === "kubernetes.io/no-provisioner"
      )
        throw new Error("Factory requires one explicit or default dynamic StorageClass");
      return `StorageClass ${selected[0].metadata.name} is selected; actual POSIX write/read is checked at bootstrap`;
    },
    "Select a dynamic RWO StorageClass that passes Factory's owned write/read check",
  );
  await observe(
    "release.namespace",
    async () => {
      const namespace = z
        .object({
          metadata: z.object({
            name: z.string(),
            labels: z.record(z.string(), z.string()).optional(),
          }),
        })
        .parse(await json(["get", "namespace", options.releaseNamespace]));
      if (namespace.metadata.name !== options.releaseNamespace)
        throw new Error("Release Namespace identity differs");
      if (namespace.metadata.labels?.["ate.dev/api-access"] !== "true")
        throw new Error(
          "The trusted Factory Namespace needs ate.dev/api-access=true for Substrate's official API NetworkPolicy",
        );
      if (namespace.metadata.labels?.["pod-security.kubernetes.io/enforce"] === "restricted")
        throw new Error(
          "The release's volume-ownership init containers require baseline Pod Security admission",
        );
      return "The selected release Namespace admits native API clients and the chart's bounded ownership init containers";
    },
    "Label only the trusted Factory Namespace ate.dev/api-access=true and use baseline Pod Security for this release",
  );
  checks.push({
    id: "native.assignment",
    status: "WARN",
    message:
      "No Actor was created. Runtime asset synchronization, TLS/egress and the actual assigned runtime still require the native live lane",
  });
  return checks;
}

export function formatPreflight(checks: readonly PreflightCheck[]) {
  const lines = checks.flatMap((check) => [
    `${check.status.padEnd(4)}  ${check.id}  ${check.message}`,
    ...(check.fix && check.status !== "PASS" ? [`      fix: ${check.fix}`] : []),
  ]);
  const count = (status: string) => checks.filter((check) => check.status === status).length;
  return [
    ...lines,
    "",
    `${count("PASS")} passed, ${count("WARN")} warnings, ${count("FAIL")} failed`,
  ].join("\n");
}
export function preflightExitCode(checks: readonly PreflightCheck[]) {
  return checks.some((check) => check.status === "FAIL") ? 1 : 0;
}
export function preflightOptionsFromArguments(
  argv: string[],
  environment: Record<string, string | undefined>,
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      configuration: { type: "string" },
      "storage-class": { type: "string" },
      namespace: { type: "string" },
      "service-account": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const env: Record<string, string | undefined> = {
    ...environment,
    FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION:
      values.configuration ?? environment["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"],
  };
  const configuration = requireNativeInstallation(env);
  requireNativeForgeOrigin(env, configuration);
  const releaseNamespace =
    values.namespace ?? env["FACTORY_PREFLIGHT_NAMESPACE"] ?? env["FACTORY_NAMESPACE"];
  if (!releaseNamespace || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(releaseNamespace))
    throw new Error("Native preflight requires the exact Factory release Namespace");
  return {
    configuration,
    releaseNamespace,
    storageClass: values["storage-class"] ?? env["FACTORY_STORAGE_CLASS"],
    json: values.json ?? false,
    serviceAccount: values["service-account"] ?? false,
  };
}

if (import.meta.main) {
  try {
    const { json, serviceAccount, ...options } = preflightOptionsFromArguments(
      process.argv.slice(2),
      process.env,
    );
    const checks = await runConfiguredPreflight(options, serviceAccount);
    console.log(json ? JSON.stringify(checks, null, 2) : formatPreflight(checks));
    process.exitCode = preflightExitCode(checks);
  } catch {
    console.error(
      "Native preflight could not start; verify the installation configuration and credentials",
    );
    process.exitCode = 2;
  }
}
