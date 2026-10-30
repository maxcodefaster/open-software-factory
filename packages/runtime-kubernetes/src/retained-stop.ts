import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { runCommand } from "./command";
import { kubernetesCommand, runtimeNodeSelector } from "./config";
import { factoryboxLocation, factoryboxSharedLabels } from "./factorybox-location";
import { workspaceSourceKey } from "./source-manifest";

export interface RetainedStopDeclaration {
  stopID: string;
  recoveryID?: string;
  attemptID: string;
  workspaceID: string;
  projectID: string;
  workerID: string;
  namespace: string;
  namespaceUID: string;
  claimUID: string;
  sourcePodName: string;
  sourcePodUID: string;
  storageNode: string;
  sourceDirectory: string;
  image: string;
  runnerSHA256: string;
  input: Record<string, string>;
}
export type RetainedStopPod = {
  uid: string;
  phase: string;
  result?: unknown;
  terminal?: "exited" | "not-started";
};
export interface RetainedStopClient {
  observe(input: RetainedStopDeclaration, signal?: AbortSignal): Promise<RetainedStopPod | null>;
  create(input: RetainedStopDeclaration, runner: string): Promise<RetainedStopPod>;
  remove(input: RetainedStopDeclaration, uid: string): Promise<void>;
}

export function retainedStopPodName(stopID: string) {
  return `native-stop-${z.uuid().parse(stopID).replaceAll("-", "")}`;
}

const nativeLoader = [
  'const path="/tmp/retained-stop-runner.mjs";',
  'await Bun.write(path,Bun.gunzipSync(Buffer.from(process.argv[1],"base64")));',
  'const child=Bun.spawn([process.execPath,path],{stdin:"ignore",stdout:"inherit",stderr:"inherit",env:process.env});',
  "process.exit(await child.exited);",
].join("");

export function renderRetainedStopPod(input: RetainedStopDeclaration, runner: string) {
  if (
    input.namespace !== factoryboxLocation(input.workerID).namespace ||
    input.sourceDirectory !== `workspaces/${workspaceSourceKey(input.workspaceID)}/home` ||
    !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(input.image) ||
    createHash("sha256").update(runner).digest("hex") !== input.runnerSHA256
  )
    throw new Error("Retained Stop declaration differs from its immutable inputs");
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: retainedStopPodName(input.recoveryID ?? input.stopID),
      namespace: input.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "open-software-factory",
        "factory.dev/runtime-owner": input.workspaceID,
        "factory.dev/retained-stop": input.stopID,
        "factory.dev/stop-origin-attempt": input.attemptID,
        ...(input.recoveryID ? { "factory.dev/stop-recovery": input.recoveryID } : {}),
      },
      annotations: { "factory.dev/runner-sha256": input.runnerSHA256 },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: 420,
      terminationGracePeriodSeconds: 10,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      nodeSelector: runtimeNodeSelector(input.storageNode),
      securityContext: {
        runAsUser: 101000,
        runAsGroup: 101000,
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" },
      },
      initContainers: [],
      containers: [
        {
          name: "settle",
          image: input.image,
          imagePullPolicy: "IfNotPresent",
          command: [
            "/opt/factory/opencode/musl/bun",
            "--eval",
            nativeLoader,
            gzipSync(runner).toString("base64"),
          ],
          workingDir: "/workspace/project",
          env: [{ name: "FACTORY_RETAINED_STOP", value: JSON.stringify(input.input) }],
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { cpu: "1", memory: "1Gi" },
          },
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            {
              name: "native",
              mountPath: "/native-session",
              subPath: `${input.sourceDirectory}/project/.git`,
            },
            { name: "location", mountPath: "/workspace/project", readOnly: true },
            { name: "temporary", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        { name: "native", persistentVolumeClaim: { claimName: "runtime-data" } },
        { name: "location", emptyDir: { sizeLimit: "1Mi" } },
        { name: "temporary", emptyDir: { sizeLimit: "256Mi" } },
      ],
    },
  };
}

function declaredFields(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => declaredFields(actual[index], value))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        key in actual
          ? declaredFields(Reflect.get(actual, key), value)
          : value === false || (Array.isArray(value) && value.length === 0),
      )
    );
  return actual === expected;
}

const resource = z
  .object({
    metadata: z
      .object({
        uid: z.string().min(1),
        labels: z.record(z.string(), z.string()).default({}),
      })
      .passthrough(),
  })
  .passthrough();
const pod = resource.extend({
  spec: z
    .object({
      containers: z.array(
        z
          .object({
            command: z.array(z.string()),
            env: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  status: z
    .object({
      phase: z.string(),
      reason: z.string().optional(),
      containerStatuses: z
        .array(
          z.object({
            name: z.string(),
            started: z.boolean().optional(),
            restartCount: z.number().optional(),
            imageID: z.string().optional(),
            state: z.object({
              terminated: z
                .object({
                  exitCode: z.number(),
                  finishedAt: z.string().nullable().optional(),
                  startedAt: z.string().nullable().optional(),
                  reason: z.string().optional(),
                })
                .optional(),
            }),
          }),
        )
        .default([]),
    })
    .optional(),
});

export function createRetainedStopClient(run = runCommand): RetainedStopClient {
  async function command(args: string[], input?: unknown) {
    const result = await run(
      kubernetesCommand(["--request-timeout=10s", ...args]),
      input === undefined ? undefined : JSON.stringify(input),
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Retained Stop infrastructure observation failed: ${result.stderr.slice(-1000)}`,
      );
    return result.stdout;
  }
  async function read(kind: string, name: string, namespace?: string) {
    const result = await command([
      "get",
      kind,
      name,
      ...(namespace ? ["-n", namespace] : []),
      "--ignore-not-found",
      "-o",
      "json",
    ]);
    return result.trim() ? resource.parse(JSON.parse(result)) : null;
  }
  async function source(input: RetainedStopDeclaration) {
    const namespace = await read("namespace", input.namespace);
    const claim = await read("persistentvolumeclaim", "runtime-data", input.namespace);
    const selected = await read("pod", input.sourcePodName, input.namespace);
    if (
      namespace?.metadata.uid !== input.namespaceUID ||
      claim?.metadata.uid !== input.claimUID ||
      selected?.metadata.uid !== input.sourcePodUID ||
      selected.metadata.labels["factory.dev/runtime-owner"] !== input.workspaceID ||
      !declaredFields(namespace.metadata.labels, factoryboxSharedLabels(input.workerID)) ||
      !declaredFields(claim.metadata.labels, factoryboxSharedLabels(input.workerID))
    )
      throw new Error("Retained Stop Source identity changed");
  }
  async function nativePod(input: RetainedStopDeclaration) {
    const observed = await read(
      "pod",
      retainedStopPodName(input.recoveryID ?? input.stopID),
      input.namespace,
    );
    if (!observed) return null;
    const native = pod.parse(observed);
    const nativeCommand = native.spec.containers[0]?.command;
    if (nativeCommand?.[2] !== nativeLoader || nativeCommand.length !== 4)
      throw new Error("Retained Stop Pod changed its native entry");
    const runner = gunzipSync(Buffer.from(nativeCommand[3] ?? "", "base64"), {
      maxOutputLength: 1024 * 1024,
    }).toString("utf8");
    const expected = renderRetainedStopPod(input, runner);
    const container = expected.spec.containers[0];
    const declaredInput = container?.env[0];
    const observedInput = native.spec.containers[0]?.env[0];
    if (!container || !declaredInput || !observedInput)
      throw new Error("Retained Stop declaration has no native process or input");
    if (
      observedInput.name !== declaredInput.name ||
      !isDeepStrictEqual(JSON.parse(observedInput.value), input.input)
    )
      throw new Error("Retained Stop Pod differs from its immutable native input");
    // JSONB may reorder properties without changing the saved native input.
    declaredInput.value = observedInput.value;
    container.command = nativeCommand;
    if (!declaredFields(native, expected))
      throw new Error("Retained Stop Pod differs from its immutable declaration");
    return native;
  }
  async function observation(input: RetainedStopDeclaration) {
    const native = await nativePod(input);
    if (!native) return null;
    const phase = native.status?.phase ?? "Pending";
    if (phase === "Failed") {
      const state = native.status?.containerStatuses.find(
        (container) => container.name === "settle",
      );
      const exited = state?.state.terminated;
      const node = await read("node", input.storageNode);
      const healthy = z
        .object({
          status: z.object({
            conditions: z.array(
              z.object({
                type: z.string(),
                status: z.string(),
              }),
            ),
          }),
        })
        .safeParse(node);
      const nodeReady =
        healthy.success &&
        healthy.data.status.conditions.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        );
      const terminal =
        exited?.finishedAt && exited.reason !== "ContainerStatusUnknown"
          ? ("exited" as const)
          : nodeReady &&
              native.status?.reason === "DeadlineExceeded" &&
              state?.started === false &&
              state.restartCount === 0 &&
              !state.imageID
            ? ("not-started" as const)
            : undefined;
      return { uid: native.metadata.uid, phase, ...(terminal ? { terminal } : {}) };
    }
    if (phase !== "Succeeded") return { uid: native.metadata.uid, phase };
    const exited = native.status?.containerStatuses.find((container) => container.name === "settle")
      ?.state.terminated;
    if (exited?.exitCode !== 0 || !exited.finishedAt)
      throw new Error("Retained Stop has no successful native process exit");
    const output = await command([
      "logs",
      retainedStopPodName(input.recoveryID ?? input.stopID),
      "-n",
      input.namespace,
    ]);
    return { uid: native.metadata.uid, phase, result: JSON.parse(output.trim()) };
  }
  return {
    async observe(input, signal) {
      signal?.throwIfAborted();
      await source(input);
      signal?.throwIfAborted();
      return observation(input);
    },
    async create(input, runner) {
      await source(input);
      const output = await command(
        ["create", "-f", "-", "-o", "json"],
        renderRetainedStopPod(input, runner),
      );
      const created = resource.parse(JSON.parse(output));
      const observed = await observation(input);
      if (!observed || observed.uid !== created.metadata.uid)
        throw new Error("Retained Stop create outcome is unconfirmed");
      return observed;
    },
    async remove(input, uid) {
      const native = await nativePod(input);
      if (!native) return;
      if (native.metadata.uid !== uid)
        throw new Error("Retained Stop Pod UID changed before cleanup");
      await command(
        [
          "delete",
          "--raw",
          `/api/v1/namespaces/${input.namespace}/pods/${retainedStopPodName(input.recoveryID ?? input.stopID)}`,
          "-f",
          "-",
        ],
        { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid } },
      );
    },
  };
}
