import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  retiredFactoryboxExportOwner,
  retireFactoryboxExports,
} from "../../../../packages/runtime-kubernetes/src/factorybox-export-retention";
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
  cancelFactoryboxPreparation,
  type FactoryboxRuntimeInput,
  factoryboxOriginalWorkerRetired,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
  factoryboxSandboxID,
  prepareFactoryboxRuntime,
  releaseFactoryboxRuntime,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  executeFactoryboxOperation,
  type FactoryboxOperation,
  type FactoryboxWorkerIdentity,
  factoryboxOperation,
  factoryboxOperationFailure,
  factoryboxWorkerDeclaration,
  factoryboxWorkerIdentity,
  inspectFactoryboxWorker,
  runFactoryboxKubernetes,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import { rejectedFactoryboxPause } from "./factorybox-pause";
import type { RuntimeHub } from "./hub";
import {
  factoryboxAllocation,
  rememberFactoryboxIdentity,
  withFactoryboxWorkerLock,
} from "./worker";

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
      timeoutMS: Math.min(remaining, limits?.timeoutMS ?? remaining),
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
      return await withFactoryboxWorkerLock(
        connection,
        () => deadlines.run(deadline, () => action(connection)),
        deadline,
      );
    } finally {
      try {
        await connection`SELECT pg_advisory_unlock(hashtext(${`factorybox:${attemptID}`}))`;
      } finally {
        await connection.end({ timeout: 1 });
      }
    }
  }
  async function retained(connection: SQL, attemptID: string) {
    const [saved] = await connection<
      Array<Retained & { workerDeclaration: unknown | null }>
    >`SELECT runtime.request,runtime.identity,runtime.inputs_released_at IS NOT NULL AS released,
      admission.declaration AS "workerDeclaration"
      FROM factory.factorybox_runtime runtime
      JOIN factory.runtime_attempt attempt ON attempt.id=runtime.runtime_attempt_id
      JOIN factory.factorybox_worker_admission admission ON admission.id=attempt.factorybox_admission_id
      WHERE runtime.runtime_attempt_id=${attemptID}`;
    if (!saved) return undefined;
    return {
      ...saved,
      request: {
        ...saved.request,
        ...(saved.workerDeclaration
          ? { workerDeclaration: factoryboxWorkerDeclaration.parse(saved.workerDeclaration) }
          : {}),
      },
    };
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
  async function completed(
    connection: SQL | postgres.TransactionSql,
    operation: Operation,
    observation: unknown,
  ) {
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
    // Lost Start/Pause/Resume output remains observation-only. Explicit Stop
    // may continue Delete only after the exact original native runtime is
    // confirmed stopped, never by assuming a failed command had no effect.
    if (observeOnly && !record.attempted) await attempted(connection, record);
    let observation =
      record.attempted || observeOnly
        ? await executeFactoryboxOperation(
            request,
            identity,
            { action: "state", sandboxID: saved.request.sandboxID },
            run,
            declaration,
          )
        : await executeFactoryboxOperation(request, identity, op, run, declaration, () =>
            attempted(connection, record),
          );
    if (!observation.confirmed && op.action === "pause") {
      const current = await executeFactoryboxOperation(
        request,
        identity,
        { action: "state", sandboxID: saved.request.sandboxID },
        run,
        declaration,
      );
      if (current.confirmed) observation = current;
    }
    if (!observation.confirmed) throw factoryboxOperationFailure(op.action, observation.stderr);
    const raw = JSON.parse(observation.stdout);
    if (op.action === "pause") {
      const [started] = await connection<{ observation: unknown }[]>`
        SELECT observation FROM factory.factorybox_lifecycle_operation
        WHERE runtime_attempt_id=${attemptID} AND action='start' AND completed_at IS NOT NULL`;
      const rejection = rejectedFactoryboxPause(
        raw,
        saved.request.sandboxID,
        op.snapshotID,
        started?.observation,
      );
      if (rejection) {
        await connection.begin(async (sql) => {
          await completed(sql, record, rejection);
          await sql`UPDATE factory.runtime_attempt SET state='starting',
            failure='child connector reconnecting',updated_at=now()
            WHERE id=${attemptID} AND state='pausing' AND stop_intended_at IS NULL`;
        });
        return rejection;
      }
    }
    const nativeResult = z.object({
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
    });
    let result = nativeResult.parse(raw);
    if (
      op.action === "delete" &&
      record.attempted &&
      !observeOnly &&
      ["running", "paused", "deleting"].includes(result.record.phase) &&
      result.runtime?.status === "stopped"
    ) {
      // Failed startup also records compensating cleanup before Native Delete.
      // Continue that exact intent without inventing a human Stop or clearing
      // its failure. Native owner/input and process-exit checks still apply.
      const [closing] = await connection`SELECT id FROM factory.runtime_attempt
        WHERE id=${attemptID} AND (stop_intended_at IS NOT NULL OR failure IS NOT NULL)
          AND state IN ('stopping','cleanup-failed')`;
      if (!closing)
        throw new Error("Native Delete continuation requires the original recorded cleanup");
      const [started] = await connection<{ observation: unknown }[]>`
        SELECT observation FROM factory.factorybox_lifecycle_operation
        WHERE runtime_attempt_id=${attemptID} AND action='start' AND completed_at IS NOT NULL`;
      z.object({
        id: z.literal(saved.request.sandboxID),
        owner: z.literal(result.record.owner),
        inputSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      })
        .refine((value) => value.inputSHA256 === result.record.input_sha256, {
          message: "Native Delete owner/input differs from the original Start",
        })
        .parse(started?.observation);
      // The pinned native Delete revalidates its own original process/cgroup
      // identity and is idempotent. Keep the existing intent and first attempt.
      // No new Start, prompt, source write or native identity is admitted.
      const continued = await executeFactoryboxOperation(request, identity, op, run, declaration);
      if (!continued.confirmed) throw new Error("Factorybox delete outcome is unconfirmed");
      result = nativeResult.parse(JSON.parse(continued.stdout));
    }
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
    if (op.action === "pause")
      await connection.begin(async (sql) => {
        await completed(sql, record, compact);
        await sql`UPDATE factory.runtime_attempt SET state='paused',failure=NULL,updated_at=now()
          WHERE id=${attemptID} AND state='pausing' AND stop_intended_at IS NULL`;
      });
    else await completed(connection, record, compact);
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
      if (result.exitCode !== 0) {
        const [attempt] = await connection<Array<{ failure: string | null }>>`
          SELECT failure FROM factory.runtime_attempt WHERE id=${attemptID}`;
        // A missing receipt is not a new cause. Keep the original diagnostic
        // rather than hiding it on every read-only reconciliation.
        throw new Error(
          attempt?.failure ??
            "Factorybox preparation remains unconfirmed; its inputs were retained",
        );
      }
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
    if (!saved.identity) throw new Error("Factorybox preparation identity is missing");
    const result = await prepareFactoryboxRuntime(saved.request, saved.identity, run, 420_000, () =>
      attempted(connection, operation),
    );
    await completed(connection, operation, result);
    return result;
  }
  return {
    async hasExited(attemptID: string) {
      return locked(attemptID, async (connection) => {
        const saved = await retained(connection, attemptID);
        if (!saved) return false;
        if (saved.released) return true;
        if (!saved.identity) return false;
        const [started] = await connection<{ observation: unknown }[]>`
          SELECT observation FROM factory.factorybox_lifecycle_operation
          WHERE runtime_attempt_id=${attemptID} AND action='start' AND completed_at IS NOT NULL`;
        if (!started) return false;
        const original = z
          .object({
            id: z.literal(saved.request.sandboxID),
            owner: z.string().regex(/^[a-f0-9]{32}$/),
            inputSHA256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(started.observation);
        const observed = await executeFactoryboxOperation(
          factoryboxRuntimeRequest(saved.request),
          saved.identity,
          { action: "state", sandboxID: saved.request.sandboxID },
          run,
          factoryboxRuntimeDeclaration(saved.request),
        );
        if (!observed.confirmed)
          throw new Error("Original Factorybox Sandbox observation is unavailable");
        const current = z
          .object({
            record: z.object({
              id: z.literal(original.id),
              owner: z.literal(original.owner),
              input_sha256: z.literal(original.inputSHA256),
              runtime_id: z.literal(`fbx-${original.owner}`),
              phase: z.string(),
            }),
            runtime: z
              .object({ status: z.string(), pid: z.number().int().nonnegative() })
              .optional(),
          })
          .parse(JSON.parse(observed.stdout));
        // A shared worker can outlive its consumers. Only exact, completed
        // execution or deletion can establish exit. Pause and in-flight native
        // transitions retain their authority even when they have no live PID.
        return (
          (current.record.phase === "running" &&
            current.runtime?.status === "stopped" &&
            current.runtime.pid === 0) ||
          (current.record.phase === "deleted" &&
            (!current.runtime ||
              (current.runtime.status === "stopped" && current.runtime.pid === 0)))
        );
      });
    },
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
      if (saved) return [factoryboxRuntimeDeclaration(saved.request).pod];
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
          workerRuntimeHostImage: string;
          workerDeclaration: unknown | null;
        }>
      >`SELECT attempt.kubernetes_namespace AS namespace,attempt.kubernetes_pod_name AS "podName",
        attempt.project_id AS "projectID",coalesce(attempt.workspace_id,attempt.id) AS "ownerID",
        attempt.generation,attempt.workspace_id IS NOT NULL AS "sharedSource",slot.id AS "slotID",
        artifact.factorybox_profile AS profile,artifact.runtime_host_image AS "runtimeHostImage",
        attempt.factorybox_worker_id AS "workerID",
        admission.runtime_host_image AS "workerRuntimeHostImage",admission.declaration AS "workerDeclaration"
        FROM factory.runtime_attempt attempt JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
        JOIN factory.factorybox_worker_admission admission ON admission.id=attempt.factorybox_admission_id
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
        workerRuntimeHostImage: attempt.workerRuntimeHostImage,
        ...(attempt.workerDeclaration
          ? { workerDeclaration: factoryboxWorkerDeclaration.parse(attempt.workerDeclaration) }
          : {}),
        sharedSource: attempt.sharedSource,
        ...(attempt.slotID ? { reserve: true } : {}),
      };
      return [factoryboxRuntimeDeclaration(input).pod];
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
        if (!prepared?.completed) {
          if (start?.attempted)
            throw new Error("Incomplete Factorybox preparation was retained for inspection");
          await cancelFactoryboxPreparation(saved.request, saved.identity, run);
          await connection`UPDATE factory.factorybox_runtime SET inputs_released_at=now() WHERE runtime_attempt_id=${attemptID} AND inputs_released_at IS NULL`;
          return;
        }
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
            resources = [factoryboxRuntimeDeclaration(saved.request).pod];
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
          const worker = await factoryboxAllocation(connection);
          if (worker.workerID !== attempt.workerID || worker.podName !== attempt.podName)
            throw new Error("Runtime Attempt belongs to another Factory worker admission");
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
            ...(worker.runtimeHostImage && worker.runtimeHostImage !== attempt.runtimeHostImage
              ? { workerRuntimeHostImage: worker.runtimeHostImage }
              : {}),
            ...(worker.declaration
              ? { workerDeclaration: factoryboxWorkerDeclaration.parse(worker.declaration) }
              : {}),
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
          if (request.profile.retainedStore) {
            const previous = await connection`SELECT
              replace(id::text,'-','') AS "admissionID",pod_uid AS "podUID",
              identity->>'epoch' AS epoch,runtime_host_image AS image,
              CASE WHEN profile ? 'retainedStore' THEN replace(id::text,'-','') ELSE NULL END AS "seedNamespace",
              json_build_object('podUID',retirement_observation->>'podUID',
                'phase',retirement_observation->>'phase') AS terminal
              FROM factory.factorybox_worker_admission
              WHERE worker_id=${request.workerID} AND retired_at IS NOT NULL
                AND retirement_observation->>'kind'='operator-recovery'
                AND coalesce(profile->'retainedStore'->>'storeID',identity->>'storeID')=${identity.storeID}
              ORDER BY created_at,id`;
            await retireFactoryboxExports(
              request,
              identity,
              z.array(retiredFactoryboxExportOwner).parse([...previous]),
              run,
            );
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
        const outcome = await perform(connection, attemptID, saved, {
          action: "pause",
          sandboxID: saved.request.sandboxID,
          snapshotID: snapshot,
        });
        if ("rejected" in outcome && outcome.rejected === true) {
          await connection.begin(async (sql) => {
            const [current] = await sql<
              {
                generation: string;
                parent: string;
                child: string;
              }[]
            >`SELECT generation,parent_connector_token_hash AS parent,child_connector_token_hash AS child
              FROM factory.runtime_attempt WHERE id=${attemptID} AND state='starting'
                AND stop_intended_at IS NULL FOR UPDATE`;
            if (current)
              hub.allow(attemptID, Number(current.generation), current.parent, current.child);
          });
          return;
        }
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
          WHERE runtime_attempt_id=${attemptID} AND action='pause' AND completed_at IS NOT NULL
            AND observation->>'phase'='paused' AND observation ? 'checkpointSHA256'
          ORDER BY intended_at DESC LIMIT 1`;
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
