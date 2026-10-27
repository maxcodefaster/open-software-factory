import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type FactoryboxBackingRequest,
  type FactoryboxCheckpointRequest,
  factoryboxBackingRequest,
  factoryboxCheckpointRequest,
  factoryboxObsoleteCheckpoints,
  factoryboxObsoleteResumeImages,
  readFactoryboxBackingRetirement,
  readFactoryboxCheckpointRetirement,
} from "../../../../packages/runtime-kubernetes/src/factorybox-retention";
import {
  type FactoryboxRuntimeInput,
  factoryboxOriginalWorkerRetired,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
  factoryboxSandboxID,
  prepareFactoryboxRuntime,
  releaseFactoryboxRuntime,
  renderFactoryboxRuntime,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  executeFactoryboxOperation,
  type FactoryboxOperation,
  type FactoryboxWorkerIdentity,
  factoryboxOperation,
  factoryboxWorkerIdentity,
  inspectFactoryboxWorker,
  runFactoryboxKubernetes,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import type { RuntimeHub } from "./hub";
import { factoryboxAllocation, rememberFactoryboxIdentity } from "./worker";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"];
type Operation = {
  id: string;
  action: string;
  snapshotID: string | null;
  attempted: boolean;
  completed: boolean;
  request: unknown;
  observation: unknown;
};
type LifecycleOperation = Extract<
  FactoryboxOperation,
  { action: "start" | "pause" | "resume" | "delete" }
>;
type Retained = {
  request: FactoryboxRuntimeInput;
  identity: FactoryboxWorkerIdentity | null;
  released: boolean;
};

export function createFactoryboxExecution(
  database: Database,
  hub: RuntimeHub,
  transport = runFactoryboxKubernetes,
) {
  let reclaiming: Promise<void> | null = null;
  let reclaimAfter: string | null = null;
  const deadlines = new AsyncLocalStorage<number>();
  const run: typeof transport = (args, input, limits) => {
    const remaining = (deadlines.getStore() ?? performance.now() + 420_000) - performance.now();
    if (remaining <= 0)
      throw new Error("Factorybox lifecycle deadline expired; original intent was retained");
    return transport(args, input, {
      timeoutMS: Math.min(remaining, limits?.timeoutMS ?? 15_000),
      outputBytes: limits?.outputBytes ?? 4 * 1024 ** 2,
    });
  };
  async function locked<T>(
    attemptID: string,
    action: (connection: SQL) => Promise<T>,
    deadline = performance.now() + 420_000,
  ) {
    const connection = database.coordination();
    try {
      await connection`SELECT pg_advisory_lock(hashtext(${`factorybox:${attemptID}`}))`;
      return await deadlines.run(deadline, () => action(connection));
    } finally {
      try {
        await connection`SELECT pg_advisory_unlock(hashtext(${`factorybox:${attemptID}`}))`;
      } finally {
        await connection.end({ timeout: 1 });
      }
    }
  }
  async function retained(connection: SQL, attemptID: string) {
    return (
      await connection<
        Retained[]
      >`SELECT request,identity,inputs_released_at IS NOT NULL AS released FROM factory.factorybox_runtime WHERE runtime_attempt_id=${attemptID}`
    )[0];
  }
  async function intent(
    connection: SQL,
    attemptID: string,
    action: string,
    snapshot: string | null = null,
    request: FactoryboxCheckpointRequest | FactoryboxBackingRequest | null = null,
  ) {
    if (request && "snapshot_id" in request && request.snapshot_id !== snapshot)
      throw new Error("Checkpoint retirement request differs from its retained snapshot");
    await connection`INSERT INTO factory.factorybox_lifecycle_operation(runtime_attempt_id,action,snapshot_id,request)
      VALUES(${attemptID},${action},${snapshot},${request === null ? null : JSON.stringify(request)}::text::jsonb) ON CONFLICT DO NOTHING`;
    const [operation] = await connection<
      Operation[]
    >`SELECT id,action,snapshot_id AS "snapshotID",attempted_at IS NOT NULL AS attempted,
      completed_at IS NOT NULL AS completed,request,observation FROM factory.factorybox_lifecycle_operation
      WHERE runtime_attempt_id=${attemptID} AND action=${action} AND snapshot_id IS NOT DISTINCT FROM ${snapshot}`;
    if (!operation) throw new Error("Factorybox lifecycle intent was not retained");
    if (!isDeepStrictEqual(operation.request, request))
      throw new Error("Factorybox lifecycle request differs from its immutable intent");
    return operation;
  }
  async function attempted(connection: SQL, operation: Operation) {
    const changed =
      await connection`UPDATE factory.factorybox_lifecycle_operation SET attempted_at=now()
      WHERE id=${operation.id} AND attempted_at IS NULL AND completed_at IS NULL`;
    if (changed.count !== 1)
      throw new Error("Factorybox operation was already attempted; observe its original outcome");
  }
  async function completed(connection: SQL, operation: Operation, observation: unknown) {
    await connection`UPDATE factory.factorybox_lifecycle_operation SET completed_at=now(),observation=${JSON.stringify(observation)}::text::jsonb
      WHERE id=${operation.id} AND completed_at IS NULL`;
  }
  async function perform(
    connection: SQL,
    attemptID: string,
    saved: Retained,
    op: LifecycleOperation,
    observeOnly = false,
  ) {
    const identity = saved.identity;
    if (!identity) throw new Error("Factorybox worker has no admitted identity");
    const request = factoryboxRuntimeRequest(saved.request);
    if ("sandboxID" in op && op.sandboxID !== saved.request.sandboxID)
      throw new Error("Factorybox operation belongs to another Sandbox");
    const record = await intent(
      connection,
      attemptID,
      op.action,
      "snapshotID" in op ? op.snapshotID : null,
    );
    if (record.completed)
      return z
        .object({ id: z.literal(saved.request.sandboxID) })
        .passthrough()
        .parse(record.observation);
    const declaration = factoryboxRuntimeDeclaration(saved.request);
    // Once an external command may have run, only observation can settle it.
    // The same native command is never retried after lost output.
    if (observeOnly && !record.attempted) await attempted(connection, record);
    const observation =
      record.attempted || observeOnly
        ? await executeFactoryboxOperation(
            request,
            identity,
            { action: "state", sandboxID: saved.request.sandboxID },
            run,
            declaration,
          )
        : await (async () => {
            await attempted(connection, record);
            return executeFactoryboxOperation(request, identity, op, run, declaration);
          })();
    if (!observation.confirmed) throw new Error(`Factorybox ${op.action} outcome is unconfirmed`);
    const result = z
      .object({
        runtime: z.object({ status: z.string() }).optional(),
        record: z.object({
          id: z.literal(saved.request.sandboxID),
          phase: z.string(),
          input_sha256: z.string().optional(),
          owner: z.string(),
          pause: z
            .object({
              snapshot_id: z.string(),
              checkpoint_sha256: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
              completed_at: z.string().optional(),
              resume: z.object({ completed_at: z.string().optional() }).optional(),
            })
            .optional(),
          pause_history: z.array(z.unknown()).optional(),
        }),
      })
      .parse(JSON.parse(observation.stdout));
    const expected = { start: "running", pause: "paused", resume: "running", delete: "deleted" };
    if (
      !(op.action in expected) ||
      result.record.phase !== expected[op.action as keyof typeof expected] ||
      ((op.action === "start" || op.action === "resume") && result.runtime?.status !== "running") ||
      ((op.action === "pause" || op.action === "resume") &&
        (result.record.pause?.snapshot_id !== op.snapshotID ||
          !result.record.pause.completed_at ||
          !result.record.pause.checkpoint_sha256 ||
          (op.action === "resume" && !result.record.pause.resume?.completed_at)))
    )
      throw new Error(`Factorybox ${op.action} is not confirmed by its original native record`);
    if (op.action === "resume") {
      const [pause] = await connection<
        Array<{ observation: unknown }>
      >`SELECT observation FROM factory.factorybox_lifecycle_operation
        WHERE runtime_attempt_id=${attemptID} AND action='pause' AND snapshot_id=${op.snapshotID}
          AND completed_at IS NOT NULL`;
      z.object({
        owner: z.literal(result.record.owner),
        snapshotID: z.literal(op.snapshotID),
        checkpointSHA256: z.literal(result.record.pause?.checkpoint_sha256),
      }).parse(pause?.observation);
    }
    const compact = {
      version: 1,
      id: result.record.id,
      owner: result.record.owner,
      phase: result.record.phase,
      inputSHA256: result.record.input_sha256,
      ...("snapshotID" in op ? { snapshotID: op.snapshotID } : {}),
      ...(result.record.pause?.checkpoint_sha256
        ? { checkpointSHA256: result.record.pause.checkpoint_sha256 }
        : {}),
    };
    for (const checkpoint of factoryboxObsoleteCheckpoints(saved.request.sandboxID, result.record))
      await intent(connection, attemptID, "retire-checkpoint", checkpoint.snapshot_id, checkpoint);
    for (const checkpoint of factoryboxObsoleteResumeImages(saved.request.sandboxID, result.record))
      await intent(connection, attemptID, "retire-resume", checkpoint.snapshot_id, checkpoint);
    await completed(connection, record, compact);
    return compact;
  }
  async function reclaimAttempt(connection: SQL, attemptID: string, saved: Retained) {
    if (!saved.identity)
      throw new Error("Checkpoint retirement requires its original worker identity");
    const operations = await connection<
      Operation[]
    >`SELECT id,action,snapshot_id AS "snapshotID",attempted_at IS NOT NULL AS attempted,false AS completed,request,observation
      FROM factory.factorybox_lifecycle_operation
      WHERE runtime_attempt_id=${attemptID} AND action IN ('retire-checkpoint','retire-resume') AND completed_at IS NULL
      ORDER BY intended_at,id`;
    for (const operation of operations) {
      const request = factoryboxCheckpointRequest.parse(operation.request);
      if (operation.action !== "retire-checkpoint" && operation.action !== "retire-resume")
        throw new Error("Unknown Factorybox retirement action");
      if (
        request.source_id !== saved.request.sandboxID ||
        request.snapshot_id !== operation.snapshotID
      )
        throw new Error("Checkpoint retirement intent belongs to another Sandbox or snapshot");
      if (!operation.attempted) await attempted(connection, operation);
      // Unlike Start/Resume, native retirement explicitly continues one exact
      // durable deletion inventory after interruption. Reusing this request
      // never selects a fresh checkpoint or removes a successor at its path.
      const result = await executeFactoryboxOperation(
        factoryboxRuntimeRequest(saved.request),
        saved.identity,
        {
          action: operation.action,
          sandboxID: request.source_id,
          snapshotID: request.snapshot_id,
          sourceOwner: request.source_owner,
          checkpointSHA256: request.checkpoint_sha256,
        },
        run,
        factoryboxRuntimeDeclaration(saved.request),
      );
      if (!result.confirmed)
        throw new Error("Factorybox checkpoint retirement remains unconfirmed");
      const receipt = readFactoryboxCheckpointRetirement(
        request,
        saved.identity.controllerRoot,
        JSON.parse(result.stdout),
        operation.action === "retire-resume" ? "resume-images" : undefined,
      );
      await completed(connection, operation, {
        version: 1,
        ...(receipt.payload_kind ? { payloadKind: receipt.payload_kind } : {}),
        request,
        intentSHA256: receipt.intent_sha256,
        completedAt: receipt.completed_at,
        availableBytesBefore: receipt.before.filesystem_available_bytes,
        availableBytesAfter: receipt.after.filesystem_available_bytes,
      });
    }
  }
  async function reclaimBacking(
    connection: SQL,
    attemptID: string,
    saved: Retained,
    deleted: unknown,
  ) {
    if (!saved.identity) throw new Error("Sandbox backing retirement requires its original worker");
    const record = z
      .object({
        id: z.literal(saved.request.sandboxID),
        owner: z.string(),
        inputSHA256: z.string(),
        phase: z.literal("deleted"),
      })
      .parse(deleted);
    const request = factoryboxBackingRequest.parse({
      sandbox_id: record.id,
      sandbox_owner: record.owner,
      input_sha256: record.inputSHA256,
    });
    const operation = await intent(connection, attemptID, "retire-sandbox", null, request);
    if (operation.completed) return;
    // Both unmount release and native retirement continue only their original
    // persisted ownership. A lost reply never selects new paths or credentials.
    const [fork] = await connection`SELECT id FROM factory.execution_slot
      WHERE assigned_attempt_id=${attemptID} AND template_id IS NOT NULL`;
    if (!fork) await releaseFactoryboxRuntime(saved.request, saved.identity, false, run);
    if (!operation.attempted) await attempted(connection, operation);
    const result = await executeFactoryboxOperation(
      factoryboxRuntimeRequest(saved.request),
      saved.identity,
      {
        action: "retire-sandbox",
        sandboxID: request.sandbox_id,
        sandboxOwner: request.sandbox_owner,
        inputSHA256: request.input_sha256,
      },
      run,
      factoryboxRuntimeDeclaration(saved.request),
    );
    if (!result.confirmed)
      throw new Error("Factorybox private backing retirement remains unconfirmed");
    const receipt = readFactoryboxBackingRetirement(
      request,
      saved.identity.controllerRoot,
      JSON.parse(result.stdout),
    );
    await completed(connection, operation, {
      version: 1,
      payloadKind: receipt.payload_kind,
      request,
      intentSHA256: receipt.intent_sha256,
      completedAt: receipt.completed_at,
      availableBytesBefore: receipt.before.filesystem_available_bytes,
      availableBytesAfter: receipt.after.filesystem_available_bytes,
    });
  }
  async function preparation(connection: SQL, attemptID: string, saved: Retained) {
    factoryboxRuntimeRequest(saved.request);
    const path = `/var/lib/sysbox/fixed-store/data/store/input/${saved.request.sandboxID}/prepared.json`;
    const operation = await intent(connection, attemptID, "prepare");
    if (operation.completed)
      return z
        .object({
          version: z.literal(3),
          sandboxID: z.literal(saved.request.sandboxID),
          bundle: z.literal(path.replace("/prepared.json", "/bundle")),
        })
        .parse(operation.observation);
    if (operation.attempted) {
      // Preparation publishes a private commit marker. A missing/incomplete
      // marker requires an explicit Stop; do not repeat extraction or mounts.
      if (!saved.identity) throw new Error("Factorybox preparation identity is missing");
      await inspectFactoryboxWorker(
        factoryboxRuntimeRequest(saved.request),
        saved.identity,
        run,
        factoryboxRuntimeDeclaration(saved.request),
      );
      const result = await run([
        "exec",
        saved.request.podName,
        "-n",
        saved.request.namespace,
        "-c",
        "worker",
        "--",
        "python3",
        "-c",
        "import pathlib,sys;sys.stdout.write(pathlib.Path(sys.argv[1]).read_text())",
        path,
      ]);
      if (result.exitCode !== 0)
        throw new Error("Factorybox preparation remains unconfirmed; its inputs were retained");
      const observed = z
        .object({
          version: z.literal(3),
          sandboxID: z.literal(saved.request.sandboxID),
          storeID: z.literal(saved.identity.storeID),
          epoch: z.literal(saved.identity.epoch),
          podUID: z.literal(saved.identity.podUID),
          bundle: z.literal(path.replace("/prepared.json", "/bundle")),
          configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
          rootfsSHA256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(JSON.parse(result.stdout));
      await completed(connection, operation, observed);
      return observed;
    }
    await attempted(connection, operation);
    if (!saved.identity) throw new Error("Factorybox preparation identity is missing");
    const result = await prepareFactoryboxRuntime(saved.request, saved.identity, run);
    await completed(connection, operation, result);
    return result;
  }
  return {
    reclaimStorage() {
      if (reclaiming) return reclaiming;
      reclaiming = (async () => {
        const attempts = await database.client<
          Array<{ id: string }>
        >`SELECT DISTINCT runtime_attempt_id AS id FROM factory.factorybox_lifecycle_operation
          WHERE action IN ('retire-checkpoint','retire-resume') AND completed_at IS NULL
            AND (${reclaimAfter}::uuid IS NULL OR runtime_attempt_id>${reclaimAfter}::uuid)
          ORDER BY id LIMIT 16`;
        reclaimAfter = attempts.length === 16 ? (attempts.at(-1)?.id ?? null) : null;
        for (const attempt of attempts) {
          try {
            await locked(attempt.id, async (connection) => {
              const saved = await retained(connection, attempt.id);
              if (!saved) throw new Error("Checkpoint retirement lost its retained Sandbox");
              await reclaimAttempt(connection, attempt.id, saved);
            });
          } catch {
            // Execution stays usable. The exact attempted intent remains for
            // the next sweep, including after a Factory process restart.
            console.error("Factorybox checkpoint retirement needs observation", attempt.id);
          }
        }
      })().finally(() => {
        reclaiming = null;
      });
      return reclaiming;
    },
    async startupResources(attemptID: string) {
      const saved = await retained(database.client, attemptID);
      if (saved) return [renderFactoryboxRuntime(saved.request).pod];
      const [attempt] = await database.client<
        Array<{
          namespace: string;
          podName: string;
          projectID: string;
          ownerID: string;
          generation: string;
          sharedSource: boolean;
          slotID: string | null;
          profile: unknown;
          runtimeHostImage: string;
          workerID: string;
        }>
      >`SELECT attempt.kubernetes_namespace AS namespace,attempt.kubernetes_pod_name AS "podName",
        attempt.project_id AS "projectID",coalesce(attempt.workspace_id,attempt.id) AS "ownerID",
        attempt.generation,attempt.workspace_id IS NOT NULL AS "sharedSource",slot.id AS "slotID",
        artifact.factorybox_profile AS profile,artifact.runtime_host_image AS "runtimeHostImage",
        attempt.factorybox_worker_id AS "workerID"
        FROM factory.runtime_attempt attempt JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
        LEFT JOIN factory.execution_slot slot ON slot.assigned_attempt_id=attempt.id
        WHERE attempt.id=${attemptID} AND attempt.state='starting' AND attempt.stop_intended_at IS NULL`;
      if (!attempt?.profile) return null;
      const input: FactoryboxRuntimeInput = {
        attemptID,
        workerID: attempt.workerID,
        sandboxID: factoryboxSandboxID(attempt.slotID ?? attemptID),
        namespace: attempt.namespace,
        podName: attempt.podName,
        runtimeOwnerID: attempt.slotID ?? attempt.ownerID,
        labels: {
          "app.kubernetes.io/managed-by": "open-software-factory",
          "factory.dev/project": attempt.projectID,
          "factory.dev/runtime-owner": attempt.slotID ?? attempt.ownerID,
          "factory.dev/runtime-attempt": attemptID,
          "factory.dev/runtime-generation": String(attempt.generation),
          ...(attempt.slotID ? { "factory.dev/execution-slot": attempt.slotID } : {}),
        },
        profile: factoryboxRuntimeProfile.parse(attempt.profile),
        runtimeHostImage: attempt.runtimeHostImage,
        sharedSource: attempt.sharedSource,
        ...(attempt.slotID ? { reserve: true } : {}),
      };
      return [renderFactoryboxRuntime(input).pod];
    },
    async deleteSandbox(attemptID: string, nativeDeleteObserved = false) {
      return locked(attemptID, async (connection) => {
        const saved = await retained(connection, attemptID);
        if (!saved?.identity) return;
        if (saved.released) return;
        if (await factoryboxOriginalWorkerRetired(saved.request, saved.identity, run)) return;
        const [start] = await connection<
          Array<{ attempted: boolean }>
        >`SELECT attempted_at IS NOT NULL AS attempted
          FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${attemptID} AND action='start'`;
        const [prepared] = await connection<
          Array<{ completed: boolean }>
        >`SELECT completed_at IS NOT NULL AS completed
          FROM factory.factorybox_lifecycle_operation WHERE runtime_attempt_id=${attemptID} AND action='prepare'`;
        if (!prepared?.completed)
          throw new Error("Incomplete Factorybox preparation was retained for inspection");
        let deleted: unknown;
        if (start?.attempted)
          deleted = await perform(
            connection,
            attemptID,
            saved,
            { action: "delete", sandboxID: saved.request.sandboxID },
            nativeDeleteObserved,
          );
        await reclaimAttempt(connection, attemptID, saved);
        if (start?.attempted) await reclaimBacking(connection, attemptID, saved, deleted);
        else await releaseFactoryboxRuntime(saved.request, saved.identity, true, run);
        await connection`UPDATE factory.factorybox_runtime SET inputs_released_at=now() WHERE runtime_attempt_id=${attemptID} AND inputs_released_at IS NULL`;
      });
    },
    async ensureStarted(attemptID: string, resources?: readonly unknown[], deadline?: number) {
      return locked(
        attemptID,
        async (connection) => {
          if (!resources) {
            const saved = await retained(connection, attemptID);
            if (!saved) throw new Error("Factorybox startup has no retained preparation request");
            resources = [renderFactoryboxRuntime(saved.request).pod];
          }
          const [attempt] = await connection<
            Array<{
              state: string;
              namespaceUID: string;
              podUID: string;
              profile: unknown;
              runtimeHostImage: string;
              slotID: string | null;
              slotIdentity: unknown;
              slotForkRequest: unknown;
              slotStandby: unknown;
              workerID: string;
              workspaceID: string | null;
              projectID: string;
              generation: string;
              namespace: string;
              podName: string;
            }>
          >`
          SELECT attempt.state,attempt.kubernetes_namespace_uid AS "namespaceUID",attempt.kubernetes_uid AS "podUID",
            artifact.factorybox_profile AS profile,artifact.runtime_host_image AS "runtimeHostImage",slot.id AS "slotID",slot.factorybox_identity AS "slotIdentity",
            slot.factorybox_fork_request AS "slotForkRequest",slot.factorybox_standby AS "slotStandby",
            attempt.factorybox_worker_id AS "workerID",attempt.workspace_id AS "workspaceID",
            attempt.project_id AS "projectID",attempt.generation,
            attempt.kubernetes_namespace AS namespace,attempt.kubernetes_pod_name AS "podName"
          FROM factory.runtime_attempt attempt JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
          LEFT JOIN factory.execution_slot slot ON slot.assigned_attempt_id=attempt.id
          WHERE attempt.id=${attemptID} AND attempt.stop_intended_at IS NULL`;
          if (attempt?.state !== "starting") return;
          const pod = resources
            .map((value) => z.object({ kind: z.string() }).passthrough().parse(value))
            .find((value) => value.kind === "Pod");
          const parsed = z
            .object({
              metadata: z.object({
                name: z.string(),
                namespace: z.string(),
                labels: z.record(z.string(), z.string()),
              }),
            })
            .parse(pod);
          if (
            parsed.metadata.name !== attempt.podName ||
            parsed.metadata.namespace !== attempt.namespace
          )
            throw new Error("Runtime resources belong to another Factory worker");
          const owner = attempt.slotID ?? attempt.workspaceID ?? attemptID;
          const request: FactoryboxRuntimeInput = {
            attemptID,
            workerID: attempt.workerID,
            sandboxID: factoryboxSandboxID(attempt.slotID ?? attemptID),
            namespace: attempt.namespace,
            podName: attempt.podName,
            runtimeOwnerID: owner,
            labels: {
              "app.kubernetes.io/managed-by": "open-software-factory",
              "factory.dev/runtime-owner": owner,
              "factory.dev/runtime-attempt": attemptID,
              "factory.dev/runtime-generation": String(attempt.generation),
              "factory.dev/project": attempt.projectID,
              ...(attempt.slotID ? { "factory.dev/execution-slot": attempt.slotID } : {}),
            },
            runtimeHostImage: attempt.runtimeHostImage,
            profile: factoryboxRuntimeProfile.parse(attempt.profile),
            sharedSource: Boolean(attempt.workspaceID),
            ...(attempt.slotID ? { reserve: true } : {}),
          };
          if (attempt.slotID) {
            if (request.sharedSource)
              throw new Error("A used reserve cannot adopt canonical Workspace source");
          }
          await connection`INSERT INTO factory.factorybox_runtime(runtime_attempt_id,request) VALUES(${attemptID},${JSON.stringify(request)}::text::jsonb) ON CONFLICT DO NOTHING`;
          const saved = await retained(connection, attemptID);
          if (!saved || !isDeepStrictEqual(saved.request, request)) {
            throw new Error("Factorybox input differs from its immutable preparation intent");
          }
          const worker = await factoryboxAllocation(connection);
          if (worker.workerID !== request.workerID)
            throw new Error("Runtime Attempt belongs to another Factory worker");
          const identity = await inspectFactoryboxWorker(
            factoryboxRuntimeRequest(request),
            saved.identity ??
              worker.identity ??
              (attempt.slotID ? factoryboxWorkerIdentity.parse(attempt.slotIdentity) : undefined),
            run,
            factoryboxRuntimeDeclaration(request),
          );
          if (identity.namespaceUID !== attempt.namespaceUID || identity.podUID !== attempt.podUID)
            throw new Error("Factorybox worker UIDs differ from the Runtime Attempt");
          if (!saved.identity) {
            await rememberFactoryboxIdentity(connection, request.workerID, identity);
            await connection`UPDATE factory.factorybox_runtime SET identity=${JSON.stringify(identity)}::text::jsonb WHERE runtime_attempt_id=${attemptID} AND identity IS NULL`;
            saved.identity = identity;
          }
          let prepared: { bundle: string };
          if (attempt.slotForkRequest) {
            const fork = factoryboxOperation.parse(attempt.slotForkRequest);
            if (fork.action !== "fork" || fork.sandboxID !== request.sandboxID)
              throw new Error("Assigned Fork differs from its retained native intent");
            const target = await executeFactoryboxOperation(
              factoryboxRuntimeRequest(request),
              identity,
              { action: "state", sandboxID: request.sandboxID },
              run,
              factoryboxRuntimeDeclaration(request),
            );
            if (!target.confirmed) throw new Error("Assigned Fork observation is unavailable");
            const captured = z.object({ owner: z.string() }).parse(attempt.slotStandby);
            const record = z
              .object({
                record: z.object({
                  id: z.literal(request.sandboxID),
                  owner: z.literal(captured.owner),
                  input_sha256: z.string(),
                  fork: z.object({
                    source_id: z.literal(fork.sourceSandboxID),
                    checkpoint_id: z.literal(fork.snapshotID),
                    checkpoint_sha256: z.literal(fork.checkpointSHA256),
                  }),
                  start: z.object({ completed_at: z.string().min(1) }),
                }),
              })
              .parse(JSON.parse(target.stdout)).record;
            const adoption = await intent(connection, attemptID, "prepare");
            if (!adoption.completed) {
              if (!adoption.attempted) await attempted(connection, adoption);
              await completed(connection, adoption, {
                version: 1,
                kind: "adopted-fork",
                sandboxID: record.id,
                owner: record.owner,
                inputSHA256: record.input_sha256,
                fork,
              });
            }
            // Fork has a real native Start record, but no private input mount
            // pair. The following Start is observation-only, never extraction
            // or another Start mutation against the copied running processes.
            prepared = {
              bundle: `/var/lib/sysbox/fixed-store/data/store/input/${request.sandboxID}/bundle`,
            };
          } else prepared = await preparation(connection, attemptID, saved);
          await perform(
            connection,
            attemptID,
            saved,
            {
              action: "start",
              sandboxID: request.sandboxID,
              bundle: prepared.bundle,
            },
            Boolean(attempt.slotID),
          );
        },
        deadline,
      );
    },
    async pause(attemptID: string) {
      return locked(attemptID, async (connection) => {
        const saved = await retained(connection, attemptID);
        if (!saved?.identity)
          throw new Error("Runtime Attempt has no admitted Factorybox execution");
        const [current] = await connection<
          Array<{ state: string }>
        >`SELECT state FROM factory.runtime_attempt WHERE id=${attemptID}`;
        if (current?.state === "paused") return;
        if (!current || !["ready", "pausing"].includes(current.state))
          throw new Error("Only idle ready execution can pause");
        const [existing] = await connection<
          Array<{ snapshot: string }>
        >`SELECT snapshot_id AS snapshot FROM factory.factorybox_lifecycle_operation
          WHERE runtime_attempt_id=${attemptID} AND action='pause' AND completed_at IS NULL ORDER BY intended_at LIMIT 1`;
        const snapshot = existing?.snapshot ?? crypto.randomUUID().replaceAll("-", "");
        await intent(connection, attemptID, "pause", snapshot);
        const changed =
          await connection`UPDATE factory.runtime_attempt SET state='pausing',failure=NULL,updated_at=now()
          WHERE id=${attemptID} AND state IN ('ready','pausing') AND stop_intended_at IS NULL`;
        if (changed.count !== 1) throw new Error("Runtime Stop superseded Pause");
        hub.revoke(attemptID);
        await perform(connection, attemptID, saved, {
          action: "pause",
          sandboxID: saved.request.sandboxID,
          snapshotID: snapshot,
        });
        await connection`UPDATE factory.runtime_attempt SET state='paused',failure=NULL,updated_at=now()
          WHERE id=${attemptID} AND state='pausing' AND stop_intended_at IS NULL`;
      });
    },
    async resume(attemptID: string, deadline?: number) {
      return locked(
        attemptID,
        async (connection) => {
          const saved = await retained(connection, attemptID);
          if (!saved?.identity)
            throw new Error("Runtime Attempt has no admitted Factorybox execution");
          const [attempt] = await connection<
            Array<{ state: string; generation: string; parent: string; child: string }>
          >`
          SELECT state,generation,parent_connector_token_hash AS parent,child_connector_token_hash AS child
          FROM factory.runtime_attempt WHERE id=${attemptID} AND stop_intended_at IS NULL`;
          if (!attempt || !["paused", "resuming"].includes(attempt.state))
            throw new Error("Runtime Attempt is not paused");
          const [pause] = await connection<
            Array<{ snapshot: string }>
          >`SELECT snapshot_id AS snapshot FROM factory.factorybox_lifecycle_operation
          WHERE runtime_attempt_id=${attemptID} AND action='pause' AND completed_at IS NOT NULL ORDER BY intended_at DESC LIMIT 1`;
          if (!pause) throw new Error("Runtime Attempt has no committed Pause");
          await intent(connection, attemptID, "resume", pause.snapshot);
          await connection`UPDATE factory.runtime_attempt SET state='resuming',failure=NULL,updated_at=now()
          WHERE id=${attemptID} AND state IN ('paused','resuming') AND stop_intended_at IS NULL`;
          // Check the original live worker before reauthorizing its credentials.
          await inspectFactoryboxWorker(
            factoryboxRuntimeRequest(saved.request),
            saved.identity,
            run,
            factoryboxRuntimeDeclaration(saved.request),
          );
          hub.allow(attemptID, Number(attempt.generation), attempt.parent, attempt.child);
          await perform(connection, attemptID, saved, {
            action: "resume",
            sandboxID: saved.request.sandboxID,
            snapshotID: pause.snapshot,
          });
          await connection`UPDATE factory.runtime_attempt SET state='starting',failure=NULL,updated_at=now()
          WHERE id=${attemptID} AND state='resuming' AND stop_intended_at IS NULL`;
        },
        deadline,
      );
    },
  };
}
