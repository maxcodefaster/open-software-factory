// Node and cluster preflight for the Factorybox worker.
//   bun scripts/kubernetes/preflight.ts --node NODE --architecture amd64 \
//     --image REGISTRY/factorybox@sha256:... [--kernel '5.15.0-*-azure,6.8.0-*-azure'] \
//     [--storage-class managed-csi] [--namespace factory] [--read-only] [--json]
// --kernel is optional and only restricts the nodes Factory admits. The kernel check otherwise
// reports the node's capabilities and warns when the worker accepts an unverified kernel.
// Without flags it reads the installation's FACTORY_FACTORYBOX_* environment, which the
// Helm test Job (`helm test RELEASE`) supplies. Most checks only read through the API.
// Unless --read-only, one throwaway probe also runs: it creates a labelled
// `factory-preflight-*` Namespace, issues server-side dry runs of the real worker
// declaration, runs one privileged Pod that reads node facts, then deletes that Namespace.
// It never touches an installation's resources.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { factoryboxPodSecurityLabels } from "../../packages/runtime-kubernetes/src/factorybox-location";
import {
  configuredFactoryboxRuntimeProfile,
  type FactoryboxRuntimeProfile,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  factoryboxWorkerRequest,
  renderFactoryboxWorker,
} from "../../packages/runtime-kubernetes/src/factorybox-worker";
import {
  evaluateAdmission,
  evaluateBudget,
  evaluateNode,
  evaluateNodeFacts,
  evaluateReleaseNamespace,
  evaluateStorage,
  nodeProbeProgram,
  type PreflightCheck,
  parseNodeFacts,
  skip,
} from "./preflight-checks";

export type Kubectl = (
  args: readonly string[],
  input?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const placeholderWorkerImage = `registry.invalid/factorybox@sha256:${"0".repeat(64)}`;
const probeLabel = "factory.dev/preflight";

export const kubectl: Kubectl = (args, input) =>
  runCommand(kubernetesCommand(args), input, { timeoutMS: 60_000, outputBytes: 16 * 1024 ** 2 });

export interface PreflightOptions {
  readonly profile: FactoryboxRuntimeProfile;
  readonly storageClass?: string;
  readonly releaseNamespace?: string;
  readonly readOnly: boolean;
  readonly probeTimeoutMS: number;
}

async function readJSON(run: Kubectl, args: string[]) {
  const result = await run([...args, "-o", "json"]);
  if (result.exitCode !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

function workerDeclaration(profile: FactoryboxRuntimeProfile, namespace: string) {
  const { storageAdmission, filesystemLayout, resourceAdmission, retainedStore, ...native } =
    profile;
  void [storageAdmission, filesystemLayout, resourceAdmission, retainedStore];
  const [, claim, pod] = renderFactoryboxWorker(
    factoryboxWorkerRequest.parse({
      version: 1,
      ...native,
      namespace,
      podName: "worker",
      storeID: randomBytes(16).toString("hex"),
      trustDomainID: randomBytes(16).toString("hex"),
    }),
  );
  return { claim, pod };
}

function probePod(profile: FactoryboxRuntimeProfile, namespace: string) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "node-probe", namespace, labels: { [probeLabel]: "true" } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      nodeSelector: {
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": profile.architecture,
        "kubernetes.io/hostname": profile.nodeName,
      },
      containers: [
        {
          name: "probe",
          image: profile.image,
          imagePullPolicy: "IfNotPresent",
          command: ["python3", "-c", nodeProbeProgram()],
          securityContext: { privileged: true, runAsUser: 0, runAsGroup: 0 },
          resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
          volumeMounts: [{ name: "boot", mountPath: "/host/boot", readOnly: true }],
        },
      ],
      // No type check: a node without /boot still runs the probe, which reads its kernel config only if present.
      volumes: [{ name: "boot", hostPath: { path: "/boot", type: "" } }],
    },
  };
}

async function createProbeNamespace(run: Kubectl, id: string, labels: Record<string, string>) {
  const name = `factory-preflight-${id}${Object.keys(labels).length ? "-privileged" : ""}`;
  const created = await run(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, labels: { [probeLabel]: id, ...labels } },
    }),
  );
  if (created.exitCode !== 0)
    throw new Error(`Could not create the probe Namespace: ${created.stderr.trim()}`);
  return name;
}

async function deleteProbeNamespace(run: Kubectl, name: string, id: string) {
  const observed = (await readJSON(run, ["get", "namespace", name])) as
    | { metadata?: { labels?: Record<string, string> } }
    | undefined;
  // Delete only the exact Namespace this run created.
  if (observed?.metadata?.labels?.[probeLabel] !== id) return;
  await run(["delete", "namespace", name, "--wait=false"]);
}

function dryRun(run: Kubectl, resource: unknown) {
  return run(["create", "--dry-run=server", "-f", "-"], JSON.stringify(resource));
}

type ProbeState = {
  status?: {
    phase?: string;
    containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }>;
  };
};

async function runNodeProbe(
  run: Kubectl,
  profile: FactoryboxRuntimeProfile,
  namespace: string,
  timeoutMS: number,
  sleep: (ms: number) => Promise<void>,
): Promise<PreflightCheck[]> {
  const created = await run(["create", "-f", "-"], JSON.stringify(probePod(profile, namespace)));
  if (created.exitCode !== 0)
    return [
      skip(
        "node.probe",
        `The node probe Pod was not created: ${created.stderr.trim().split("\n")[0]}`,
        "Rerun as a user who may create privileged Pods with a hostPath in a new Namespace, or use --read-only",
      ),
    ];
  const deadline = Date.now() + timeoutMS;
  let observed: ProbeState | undefined;
  while (Date.now() < deadline) {
    observed = (await readJSON(run, ["get", "pod", "node-probe", "-n", namespace])) as
      | ProbeState
      | undefined;
    if (observed?.status?.phase === "Succeeded" || observed?.status?.phase === "Failed") break;
    await sleep(3_000);
  }
  const logs = await run(["logs", "node-probe", "-n", namespace]);
  const facts = parseNodeFacts(logs.stdout);
  if (facts) return evaluateNodeFacts(facts);
  const waiting = observed?.status?.containerStatuses?.[0]?.state?.waiting;
  return [
    {
      id: "node.probe",
      status: "FAIL",
      message: `The node probe Pod ended ${observed?.status?.phase ?? "unobserved"} without facts${
        waiting ? ` (${waiting.reason}: ${waiting.message ?? ""})` : ""
      }. ${logs.stdout.trim().slice(-300)}`,
      fix: `The node must pull ${profile.image} and run a privileged Pod with a /boot hostPath. Inspect it before cleanup deletes it by rerunning with a longer --probe-timeout-seconds, or run kubectl describe pod node-probe -n ${namespace} while it exists.`,
    },
  ];
}

export async function runPreflight(
  options: PreflightOptions,
  run: Kubectl = kubectl,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PreflightCheck[]> {
  const { profile } = options;
  const checks: PreflightCheck[] = [];
  const [node, pods, classes, csiNode, release] = await Promise.all([
    readJSON(run, ["get", "node", profile.nodeName]),
    readJSON(run, [
      "get",
      "pods",
      "--all-namespaces",
      "--field-selector",
      `spec.nodeName=${profile.nodeName}`,
    ]),
    readJSON(run, ["get", "storageclass"]),
    readJSON(run, ["get", "csinode", profile.nodeName]),
    options.releaseNamespace
      ? readJSON(run, ["get", "namespace", options.releaseNamespace])
      : Promise.resolve(undefined),
  ]);
  checks.push(...evaluateNode(profile, node));
  checks.push(
    node && pods
      ? evaluateBudget(profile, node, pods)
      : skip(
          "node.budget",
          "The node or its Pods were not readable",
          "Grant get nodes and list pods",
        ),
  );
  checks.push(...evaluateStorage(options.storageClass, classes, csiNode));
  checks.push(
    release
      ? evaluateReleaseNamespace(release)
      : skip("psa.release-namespace", "No release Namespace was supplied or readable"),
  );
  if (options.readOnly) {
    checks.push(
      skip(
        "admission.worker-pod",
        "Dry-run admission and the node probe were skipped (--read-only)",
        "Rerun without --read-only to prove privileged Pod admission and read the node's kernel facts",
      ),
    );
    return checks;
  }
  const id = randomBytes(4).toString("hex");
  const created: string[] = [];
  try {
    const plain = await createProbeNamespace(run, id, {});
    created.push(plain);
    const declared = workerDeclaration(profile, plain);
    checks.push(
      evaluateAdmission(
        "admission.worker-claim",
        `A ${profile.claimGiB} GiB ReadWriteOnce claim`,
        await dryRun(run, declared.claim),
        false,
      ),
    );
    const podResult = await dryRun(run, declared.pod);
    checks.push(
      evaluateAdmission("admission.worker-pod", "The privileged worker Pod", podResult, false),
    );
    let probeNamespace = podResult.exitCode === 0 ? plain : undefined;
    if (podResult.exitCode !== 0) {
      const labelled = await createProbeNamespace(run, id, factoryboxPodSecurityLabels());
      created.push(labelled);
      const labelledResult = await dryRun(run, workerDeclaration(profile, labelled).pod);
      checks.push(
        labelledResult.exitCode === 0
          ? {
              id: "admission.privileged-label",
              status: "PASS",
              message:
                "A Namespace labelled pod-security.kubernetes.io/enforce=privileged admits the worker Pod, so the cluster's Pod Security default is the cause",
            }
          : evaluateAdmission(
              "admission.privileged-label",
              "The worker Pod in a privileged-labelled Namespace",
              labelledResult,
              true,
            ),
      );
      if (labelledResult.exitCode === 0) probeNamespace = labelled;
    }
    if (profile.image === placeholderWorkerImage)
      checks.push(
        skip(
          "node.probe",
          "No worker image was supplied",
          "Pass --image REGISTRY/factorybox@sha256:...",
        ),
      );
    else if (!probeNamespace)
      checks.push(skip("node.probe", "No Namespace admits a privileged Pod"));
    else
      checks.push(
        ...(await runNodeProbe(run, profile, probeNamespace, options.probeTimeoutMS, sleep)),
      );
  } catch (cause) {
    checks.push({
      id: "admission.probe",
      status: "FAIL",
      message: cause instanceof Error ? cause.message : "Probe failed",
      fix: "Grant create and delete on namespaces and create on pods and persistentvolumeclaims, or use --read-only",
    });
  } finally {
    for (const name of created) await deleteProbeNamespace(run, name, id).catch(() => {});
  }
  return checks;
}

export function formatPreflight(checks: readonly PreflightCheck[]) {
  const lines = checks.flatMap((check) => [
    `${check.status.padEnd(4)}  ${check.id}  ${check.message}`,
    ...(check.fix && check.status !== "PASS" ? [`      fix: ${check.fix}`] : []),
  ]);
  const count = (status: string) => checks.filter((check) => check.status === status).length;
  lines.push(
    "",
    `${count("PASS")} passed, ${count("WARN")} warnings, ${count("FAIL")} failed, ${count("SKIP")} skipped`,
  );
  return lines.join("\n");
}

export function preflightExitCode(checks: readonly PreflightCheck[]) {
  return checks.some((check) => check.status === "FAIL") ? 1 : 0;
}

export function preflightOptionsFromArguments(
  argv: string[],
  env: Record<string, string | undefined>,
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      node: { type: "string" },
      architecture: { type: "string" },
      kernel: { type: "string" },
      image: { type: "string" },
      "storage-class": { type: "string" },
      namespace: { type: "string" },
      "claim-gib": { type: "string" },
      "memory-headroom-mib": { type: "string" },
      "read-only": { type: "boolean" },
      json: { type: "boolean" },
      "probe-timeout-seconds": { type: "string" },
    },
  });
  const merged = {
    ...env,
    FACTORY_FACTORYBOX_NODE: values.node ?? env["FACTORY_FACTORYBOX_NODE"],
    FACTORY_FACTORYBOX_ARCHITECTURE: values.architecture ?? env["FACTORY_FACTORYBOX_ARCHITECTURE"],
    FACTORY_FACTORYBOX_KERNEL: values.kernel ?? env["FACTORY_FACTORYBOX_KERNEL"],
    FACTORY_FACTORYBOX_WORKER_IMAGE:
      values.image ?? env["FACTORY_FACTORYBOX_WORKER_IMAGE"] ?? placeholderWorkerImage,
    FACTORY_FACTORYBOX_EXECUTABLE_SHA256:
      env["FACTORY_FACTORYBOX_EXECUTABLE_SHA256"] ?? "0".repeat(64),
    FACTORY_FACTORYBOX_CLAIM_GIB: values["claim-gib"] ?? env["FACTORY_FACTORYBOX_CLAIM_GIB"],
    FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB:
      values["memory-headroom-mib"] ?? env["FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB"] ?? "2048",
  };
  const storageClass = values["storage-class"] ?? env["FACTORY_STORAGE_CLASS"];
  const releaseNamespace = values.namespace ?? env["FACTORY_PREFLIGHT_NAMESPACE"];
  return {
    profile: configuredFactoryboxRuntimeProfile(merged),
    ...(storageClass ? { storageClass } : {}),
    ...(releaseNamespace ? { releaseNamespace } : {}),
    readOnly: values["read-only"] ?? false,
    probeTimeoutMS: Number(values["probe-timeout-seconds"] ?? 600) * 1000,
    json: values.json ?? false,
  };
}

if (import.meta.main) {
  try {
    const { json, ...options } = preflightOptionsFromArguments(process.argv.slice(2), process.env);
    const checks = await runPreflight(options);
    console.log(json ? JSON.stringify(checks, null, 2) : formatPreflight(checks));
    process.exitCode = preflightExitCode(checks);
  } catch (cause) {
    console.error(
      `Preflight could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    process.exitCode = 2;
  }
}
