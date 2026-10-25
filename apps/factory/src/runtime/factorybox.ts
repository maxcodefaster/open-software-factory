import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
  renderFactoryboxRuntime,
  prepareFactoryboxRuntime,
  releaseFactoryboxRuntime,
  deleteFactoryboxStore,
  factoryboxOriginalWorkerRetired,
  type FactoryboxRuntimeInput,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  executeFactoryboxOperation,
  inspectFactoryboxWorker,
  runFactoryboxKubernetes,
  type FactoryboxOperation,
  type FactoryboxWorkerIdentity,
  factoryboxWorkerIdentity,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import type { RuntimeHub } from "./hub";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"];
type Operation = { id: string; attempted: boolean; completed: boolean; observation: unknown };
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
  ) {
    await connection`INSERT INTO factory.factorybox_lifecycle_operation(runtime_attempt_id,action,snapshot_id)
      VALUES(${attemptID},${action},${snapshot}) ON CONFLICT DO NOTHING`;
    const [operation] = await connection<
      Operation[]
    >`SELECT id,attempted_at IS NOT NULL AS attempted,
      completed_at IS NOT NULL AS completed,observation FROM factory.factorybox_lifecycle_operation
      WHERE runtime_attempt_id=${attemptID} AND action=${action} AND snapshot_id IS NOT DISTINCT FROM ${snapshot}`;
    if (!operation) throw new Error("Factorybox lifecycle intent was not retained");
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
    op: FactoryboxOperation,
    observeOnly = false,
  ) {
    const identity = saved.identity;
    if (!identity) throw new Error("Factorybox worker has no admitted identity");
    const record = await intent(
      connection,
      attemptID,
      op.action,
      "snapshotID" in op ? op.snapshotID : null,
    );
    if (record.completed) return record.observation;
    const request = factoryboxRuntimeRequest(saved.request);
    const declaration = factoryboxRuntimeDeclaration(saved.request);
    // Once an external command may have run, only observation can settle it.
    // The same native command is never retried after lost output.
    if (observeOnly && !record.attempted) await attempted(connection, record);
    const observation =
      record.attempted || observeOnly
        ? await executeFactoryboxOperation(
            request,
            identity,
            { action: "state", sandboxID: "runtime" },
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
          id: z.literal("runtime"),
          phase: z.string(),
          input_sha256: z.string().optional(),
          owner: z.string(),
          pause: z
            .object({
              snapshot_id: z.string(),
              completed_at: z.string().optional(),
              resume: z.object({ completed_at: z.string().optional() }).optional(),
            })
            .optional(),
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
          (op.action === "resume" && !result.record.pause.resume?.completed_at)))
    )
      throw new Error(`Factorybox ${op.action} is not confirmed by its original native record`);
    const compact = {
      version: 1,
      id: result.record.id,
      owner: result.record.owner,
      phase: result.record.phase,
      inputSHA256: result.record.input_sha256,
      ...("snapshotID" in op ? { snapshotID: op.snapshotID } : {}),
    };
    await completed(connection, record, compact);
    return compact;
  }
  async function preparation(connection: SQL, attemptID: string, saved: Retained) {
    const operation = await intent(connection, attemptID, "prepare");
    if (operation.completed) return z.object({ bundle: z.string() }).parse(operation.observation);
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
      const path = `/var/lib/sysbox/fixed-store/data/store/input/${saved.identity.storeID}/prepared.json`;
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
          version: z.literal(1),
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
        }>
      >`SELECT attempt.kubernetes_namespace AS namespace,attempt.kubernetes_pod_name AS "podName",
        attempt.project_id AS "projectID",coalesce(attempt.workspace_id,attempt.id) AS "ownerID",
        attempt.generation,attempt.workspace_id IS NOT NULL AS "sharedSource",slot.id AS "slotID",
        artifact.factorybox_profile AS profile,artifact.runtime_host_image AS "runtimeHostImage"
        FROM factory.runtime_attempt attempt JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
        LEFT JOIN factory.execution_slot slot ON slot.assigned_attempt_id=attempt.id
        WHERE attempt.id=${attemptID} AND attempt.state='starting' AND attempt.stop_intended_at IS NULL`;
      if (!attempt?.profile) return null;
      const input: FactoryboxRuntimeInput = {
        attemptID,
        namespace: attempt.namespace,
        podName: attempt.podName,
        runtimeOwnerID: attempt.ownerID,
        labels: {
          "app.kubernetes.io/managed-by": "open-software-factory",
          "factory.dev/project": attempt.projectID,
          "factory.dev/runtime-owner": attempt.ownerID,
          "factory.dev/runtime-attempt": attemptID,
          "factory.dev/runtime-generation": String(attempt.generation),
          ...(attempt.slotID ? { "factory.dev/execution-slot": attempt.slotID } : {}),
        },
        profile: factoryboxRuntimeProfile.parse(attempt.profile),
        runtimeHostImage: attempt.runtimeHostImage,
        sharedSource: attempt.sharedSource,
        ...(attempt.slotID ? { workerID: attempt.slotID, reserve: true } : {}),
      };
      return [renderFactoryboxRuntime(input).pod];
    },
    async deleteStore(attemptID: string) {
      const [attempt] = await database.client<
        Array<{ namespace: string; namespaceUID: string | null; podName: string; profile: unknown }>
      >`
        SELECT attempt.kubernetes_namespace AS namespace,attempt.kubernetes_namespace_uid AS "namespaceUID",attempt.kubernetes_pod_name AS "podName",
          artifact.factorybox_profile AS profile FROM factory.runtime_attempt attempt
          JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id WHERE attempt.id=${attemptID}`;
      if (!attempt?.profile) return;
      if (!attempt.namespaceUID) throw new Error("Factorybox store Namespace UID was not observed");
      const saved = await retained(database.client, attemptID);
      await deleteFactoryboxStore(
        {
          namespace: attempt.namespace,
          namespaceUID: attempt.namespaceUID,
          podName: attempt.podName,
          attemptID,
          storeID: saved?.identity?.storeID ?? attemptID.replaceAll("-", ""),
          ...(saved?.identity ? { claimUID: saved.identity.claimUID } : {}),
        },
        run,
      );
    },
    async deleteSandbox(attemptID: string) {
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
        if (start?.attempted)
          await perform(connection, attemptID, saved, { action: "delete", sandboxID: "runtime" });
        await releaseFactoryboxRuntime(saved.request, saved.identity, !start?.attempted, run);
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
            }>
          >`
          SELECT attempt.state,attempt.kubernetes_namespace_uid AS "namespaceUID",attempt.kubernetes_uid AS "podUID",
            artifact.factorybox_profile AS profile,artifact.runtime_host_image AS "runtimeHostImage",slot.id AS "slotID",slot.factorybox_identity AS "slotIdentity"
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
              spec: z.object({ volumes: z.array(z.object({ name: z.string() }).passthrough()) }),
            })
            .parse(pod);
          const owner = parsed.metadata.labels["factory.dev/runtime-owner"];
          if (!owner) throw new Error("Factorybox runtime has no durable owner");
          const request: FactoryboxRuntimeInput = {
            attemptID,
            namespace: parsed.metadata.namespace,
            podName: parsed.metadata.name,
            runtimeOwnerID: owner,
            labels: {
              ...Object.fromEntries(
                Object.entries(parsed.metadata.labels).filter(
                  ([key]) =>
                    !["factory.dev/factorybox-store", "factory.dev/trust-domain"].includes(key),
                ),
              ),
              ...(attempt.slotID ? { "factory.dev/execution-slot": attempt.slotID } : {}),
            },
            runtimeHostImage: attempt.runtimeHostImage,
            profile: factoryboxRuntimeProfile.parse(attempt.profile),
            sharedSource: parsed.spec.volumes.some((volume) => volume.name === "runtime-data"),
            ...(attempt.slotID ? { workerID: attempt.slotID, reserve: true } : {}),
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
              (attempt.slotID ? factoryboxWorkerIdentity.parse(attempt.slotIdentity) : undefined),
            run,
            factoryboxRuntimeDeclaration(request),
          );
          if (identity.namespaceUID !== attempt.namespaceUID || identity.podUID !== attempt.podUID)
            throw new Error("Factorybox worker UIDs differ from the Runtime Attempt");
          if (!saved.identity) {
            await connection`UPDATE factory.factorybox_runtime SET identity=${JSON.stringify(identity)}::text::jsonb WHERE runtime_attempt_id=${attemptID} AND identity IS NULL`;
            saved.identity = identity;
          }
          const prepared = await preparation(connection, attemptID, saved);
          await perform(
            connection,
            attemptID,
            saved,
            {
              action: "start",
              sandboxID: "runtime",
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
          sandboxID: "runtime",
          snapshotID: snapshot,
        });
        await connection`UPDATE factory.runtime_attempt SET state='paused',failure=NULL,updated_at=now()
          WHERE id=${attemptID} AND state='pausing' AND stop_intended_at IS NULL`;
      });
    },
    async resume(attemptID: string) {
      return locked(attemptID, async (connection) => {
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
          sandboxID: "runtime",
          snapshotID: pause.snapshot,
        });
        await connection`UPDATE factory.runtime_attempt SET state='starting',failure=NULL,updated_at=now()
          WHERE id=${attemptID} AND state='resuming' AND stop_intended_at IS NULL`;
      });
    },
  };
}
