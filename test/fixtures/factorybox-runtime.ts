import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../packages/db/src/client";
import {
  factoryboxLocation,
  factoryboxSharedLabels,
} from "../../packages/runtime-kubernetes/src/factorybox-location";
import {
  type FactoryboxRuntimeInput,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
  factoryboxSandboxID,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  executeFactoryboxOperation,
  factoryboxWorkerIdentity,
  runFactoryboxKubernetes,
} from "../../packages/runtime-kubernetes/src/factorybox-worker";

const retainedInput = z.strictObject({
  attemptID: z.uuid(),
  sandboxID: z.string(),
  workerID: z.uuid(),
  reserve: z.boolean().optional(),
  namespace: z.string(),
  podName: z.string(),
  runtimeOwnerID: z.uuid(),
  labels: z.record(z.string(), z.string()),
  runtimeHostImage: z.string(),
  workerRuntimeHostImage: z.string().optional(),
  profile: factoryboxRuntimeProfile,
  sharedSource: z.boolean(),
  storageNode: z.string().optional(),
});
const rowSchema = z.object({
  id: z.uuid(),
  projectID: z.uuid(),
  workspaceID: z.uuid().nullable(),
  slotID: z.uuid().nullable(),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  workerID: z.uuid(),
  namespace: z.string(),
  namespaceUID: z.string().min(1),
  podName: z.string(),
  podUID: z.string().min(1),
  runtimeHostImage: z.string(),
  profile: factoryboxRuntimeProfile,
  request: retainedInput,
  identity: factoryboxWorkerIdentity,
  released: z.literal(false),
});

// A worker Pod is shared. Its label cannot prove which Runtime Attempt owns
// an exec. Bind the retained native Sandbox, assignment and worker epoch first.
export function factoryboxFixtureTarget(value: unknown) {
  const row = rowSchema.parse(value);
  const { reserve, storageNode, workerRuntimeHostImage, ...required } = row.request;
  const input: FactoryboxRuntimeInput = {
    ...required,
    ...(reserve === undefined ? {} : { reserve }),
    ...(storageNode === undefined ? {} : { storageNode }),
    ...(workerRuntimeHostImage === undefined ? {} : { workerRuntimeHostImage }),
  };
  const { identity } = row;
  const location = factoryboxLocation(row.workerID);
  const owner = row.slotID ?? row.workspaceID ?? row.id;
  if (
    input.attemptID !== row.id ||
    input.workerID !== row.workerID ||
    input.sandboxID !== factoryboxSandboxID(row.slotID ?? row.id) ||
    input.runtimeOwnerID !== owner ||
    input.sharedSource !== Boolean(row.workspaceID) ||
    Boolean(input.reserve) !== Boolean(row.slotID) ||
    (row.slotID && row.workspaceID) ||
    input.namespace !== row.namespace ||
    row.namespace !== location.namespace ||
    input.podName !== row.podName ||
    row.podName !== location.podName ||
    input.runtimeHostImage !== row.runtimeHostImage ||
    !isDeepStrictEqual(input.profile, row.profile) ||
    identity.namespaceUID !== row.namespaceUID ||
    identity.podUID !== row.podUID ||
    identity.storeID !== row.workerID.replaceAll("-", "") ||
    identity.executableSHA256 !== input.profile.executableSHA256 ||
    input.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    input.labels["factory.dev/runtime-attempt"] !== row.id ||
    input.labels["factory.dev/runtime-owner"] !== owner ||
    input.labels["factory.dev/runtime-generation"] !== row.generation ||
    input.labels["factory.dev/project"] !== row.projectID ||
    input.labels["factory.dev/execution-slot"] !== (row.slotID ?? undefined)
  )
    throw new Error("Fixture execution differs from its retained Factorybox Sandbox or worker");
  factoryboxRuntimeRequest(input);
  return { input, identity };
}
export type FactoryboxFixtureTarget = ReturnType<typeof factoryboxFixtureTarget>;

const execProgram = `import json,os,subprocess,sys
expected=json.loads(sys.argv[1])
status=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=10))
if (status['store_id']!=expected['storeID'] or status['epoch']!=expected['epoch'] or
    status['lifecycle']['root']!=expected['controllerRoot'] or
    status['supervisor_sha256']!=expected['executableSHA256']):
 raise ValueError('Fixture worker changed before native Sandbox exec')
binary='/opt/factorybox/components/sysbox-runc'
os.execv(binary,[binary,'--root',expected['controllerRoot']+'/runtime','exec',expected['runtimeID'],*sys.argv[2:]])
`;

export async function readFactoryboxFixtureTarget(
  database: ReturnType<typeof createDatabase>,
  attemptID: string,
) {
  z.uuid().parse(attemptID);
  const [row] = await database.client`SELECT attempt.id,attempt.project_id AS "projectID",
    attempt.workspace_id AS "workspaceID",slot.id AS "slotID",attempt.generation::text,
    attempt.factorybox_worker_id AS "workerID",attempt.kubernetes_namespace AS namespace,
    attempt.kubernetes_namespace_uid AS "namespaceUID",attempt.kubernetes_pod_name AS "podName",
    attempt.kubernetes_uid AS "podUID",artifact.runtime_host_image AS "runtimeHostImage",
    artifact.factorybox_profile AS profile,saved.request,saved.identity,
    saved.inputs_released_at IS NOT NULL AS released
    FROM factory.runtime_attempt attempt
    JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
    JOIN factory.factorybox_runtime saved ON saved.runtime_attempt_id=attempt.id
    LEFT JOIN factory.execution_slot slot ON slot.assigned_attempt_id=attempt.id
    WHERE attempt.id=${attemptID}`;
  if (!row) throw new Error("Fixture has no retained Factorybox execution");
  return factoryboxFixtureTarget(row);
}

export async function observeFactoryboxFixture(
  target: FactoryboxFixtureTarget,
  run = runFactoryboxKubernetes,
) {
  const { input, identity } = target;
  const result = await executeFactoryboxOperation(
    factoryboxRuntimeRequest(input),
    identity,
    { action: "state", sandboxID: input.sandboxID },
    run,
    factoryboxRuntimeDeclaration(input),
  );
  if (!result.confirmed)
    throw new Error(
      `Fixture native Sandbox observation is unavailable: ${result.stderr.slice(-2000)}`,
    );
  const view = z
    .object({
      record: z
        .object({
          id: z.literal(input.sandboxID),
          owner: z.string().regex(/^[a-f0-9]{32}$/),
          runtime_id: z.string(),
          phase: z.enum(["running", "paused"]),
        })
        .passthrough(),
      runtime: z.object({ status: z.string() }).nullable().optional(),
    })
    .parse(JSON.parse(result.stdout));
  if (view.record.runtime_id !== `fbx-${view.record.owner}`)
    throw new Error("Fixture native exec owner differs from its Sandbox record");
  return view;
}

export async function factoryboxFixtureCommand(
  target: FactoryboxFixtureTarget,
  args: string[],
  timeoutMS = 30_000,
  run = runFactoryboxKubernetes,
  inputBody?: string,
) {
  if (!args.length || !Number.isInteger(timeoutMS) || timeoutMS < 1000 || timeoutMS > 300_000)
    throw new Error("Fixture Sandbox command is outside its bounds");
  if (inputBody !== undefined && Buffer.byteLength(inputBody) > 1024 ** 2)
    throw new Error("Fixture Sandbox private input exceeds its bound");
  const view = await observeFactoryboxFixture(target, run);
  if (view.record.phase !== "running" || view.runtime?.status !== "running")
    throw new Error("Fixture exec requires its running Sandbox, not a paused standby");
  const { input, identity } = target;
  const result = await run(
    [
      "exec",
      ...(inputBody === undefined ? [] : ["-i"]),
      "-n",
      input.namespace,
      input.podName,
      "-c",
      "worker",
      "--",
      "python3",
      "-c",
      execProgram,
      JSON.stringify({
        storeID: identity.storeID,
        epoch: identity.epoch,
        controllerRoot: identity.controllerRoot,
        executableSHA256: identity.executableSHA256,
        runtimeID: view.record.runtime_id,
      }),
      ...args,
    ],
    inputBody,
    { timeoutMS, outputBytes: 4 * 1024 ** 2 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Owned Factorybox Sandbox command failed: ${result.stderr.slice(-2000)}`);
  return result.stdout;
}

export function requireFixtureWorkerPod(value: unknown, target: FactoryboxFixtureTarget) {
  const pod = z
    .object({
      metadata: z.object({
        uid: z.string(),
        creationTimestamp: z.string(),
        labels: z.record(z.string(), z.string()),
      }),
      spec: z.object({
        nodeName: z.string(),
        nodeSelector: z.record(z.string(), z.string()),
        containers: z.array(
          z.object({
            name: z.string(),
            resources: z.object({
              requests: z.record(z.string(), z.string()),
              limits: z.record(z.string(), z.string()),
            }),
          }),
        ),
      }),
      status: z
        .object({
          startTime: z.string(),
          conditions: z.array(
            z.object({ type: z.string(), status: z.string(), lastTransitionTime: z.string() }),
          ),
          containerStatuses: z.array(
            z.object({
              name: z.string(),
              imageID: z.string(),
              state: z.object({ running: z.object({ startedAt: z.string() }).optional() }),
            }),
          ),
        })
        .passthrough(),
    })
    .parse(value);
  if (
    pod.metadata.uid !== target.identity.podUID ||
    pod.spec.nodeName !== target.input.profile.nodeName ||
    !Object.entries(factoryboxSharedLabels(target.input.workerID)).every(
      ([key, expected]) => pod.metadata.labels[key] === expected,
    )
  )
    throw new Error("Fixture observation does not own the original shared Factorybox worker");
  return pod;
}
