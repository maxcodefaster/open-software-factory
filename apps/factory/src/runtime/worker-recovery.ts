import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type KubernetesClient,
  requireRuntimePodArtifacts,
} from "../../../../packages/runtime-kubernetes/src/client";
import {
  factoryboxLocation,
  factoryboxSharedLabels,
} from "../../../../packages/runtime-kubernetes/src/factorybox-location";
import { admitFactoryboxWorkerResources } from "../../../../packages/runtime-kubernetes/src/factorybox-resource-admission";
import {
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeImage,
  factoryboxRuntimeProfile,
  factoryboxSandboxID,
  renderFactoryboxRuntime,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import { factoryboxWorkerDeclaration } from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import { requireActiveAccountIn } from "../access/controller";
import { CommandError } from "../command-error";
import { factoryboxAllocation, withFactoryboxWorkerLock } from "./worker";

type Database = ReturnType<typeof createDatabase>;
export type WorkerRecoveryInput = {
  actorID: string;
  requestID: string;
  storage?: "retain" | "fresh";
};
const refused = (message: string) => new CommandError("conflict", message);

export async function recoverFactoryboxWorker(
  database: Database,
  kubernetes: KubernetesClient,
  configured: FactoryboxRuntimeProfile,
  bootstrapImage: string,
  input: WorkerRecoveryInput,
  admitResources = admitFactoryboxWorkerResources,
) {
  z.uuid().parse(input.requestID);
  const storage = z.enum(["retain", "fresh"]).parse(input.storage ?? "retain");
  factoryboxRuntimeImage.parse(bootstrapImage);
  const sql = database.coordination();
  try {
    return await withFactoryboxWorkerLock(sql, async () => {
      await sql`SELECT pg_advisory_lock(hashtext('factorybox-worker-create'))`;
      try {
        return await sql.begin(async (transaction) => {
          await requireActiveAccountIn(transaction, input.actorID);
          if (
            !(
              await transaction`SELECT user_id FROM factory.administrator WHERE user_id=${input.actorID}`
            ).length
          )
            throw new CommandError("forbidden", "System Manager access required");
          const [original] =
            await transaction`SELECT id FROM factory.factorybox_worker WHERE singleton`;
          if (!original) throw refused("No retained worker exists to recover");
          const [completed] = await transaction<
            Array<{
              workerID: string;
              previousID: string;
              actorID: string;
              kind: string | null;
              storage: string | null;
            }>
          >`
            SELECT admitted.worker_id AS "workerID",admitted.previous_id AS "previousID",
              admitted.created_by AS "actorID",previous.retirement_observation->>'kind' AS kind,
              previous.retirement_observation->>'storage' AS storage
            FROM factory.factorybox_worker_admission admitted
            LEFT JOIN factory.factorybox_worker_admission previous ON previous.id=admitted.previous_id
            WHERE admitted.id=${input.requestID}`;
          if (completed) {
            if (
              completed.workerID !== original["id"] ||
              completed.actorID !== input.actorID ||
              !completed.previousID ||
              completed.kind !== "operator-recovery" ||
              (completed.storage ?? "retain") !== storage
            )
              throw refused("Recovery request belongs to another admission or actor");
            return {
              workerID: completed.workerID,
              admissionID: input.requestID,
              previousAdmissionID: completed.previousID,
            };
          }
          const current = await factoryboxAllocation(transaction);
          await transaction`SELECT id FROM factory.factorybox_worker_admission
            WHERE id=${current.admissionID} AND retired_at IS NULL FOR UPDATE`;
          const profile = factoryboxRuntimeProfile.parse(current.profile);
          if (
            (!current.identity && !profile.retainedStore) ||
            !current.claimUID ||
            !current.podUID ||
            !current.namespaceUID ||
            !current.declaration ||
            !current.attempted
          )
            throw refused("Operator recovery requires its original admitted store and declaration");
          const [namespace, pod] = await Promise.all([
            kubernetes.getNamespace(current.namespace),
            kubernetes.getPod(current.namespace, current.podName),
          ]).catch(() => {
            throw new CommandError(
              "unavailable",
              "Original worker observation is unavailable. No admission changed.",
            );
          });
          const labels = factoryboxSharedLabels(current.id);
          if (!namespace || namespace.uid !== current.namespaceUID)
            throw refused(
              "Original worker Namespace is missing or replaced; its identities were retained. Do not recreate it by hand.",
            );
          if (!pod)
            throw refused(
              "Original worker Pod no longer exists (its node was deleted or replaced, or the Pod object was removed), so its termination cannot be observed. No successor was created and the store claim, Source and history are retained. Restore the original node and Pod object, or keep the retained data and escalate to the Factory operator.",
            );
          if (
            pod.uid !== current.podUID ||
            !Object.entries(labels).every(([key, value]) => namespace.labels[key] === value) ||
            !Object.entries(labels).every(([key, value]) => pod.labels[key] === value)
          )
            throw refused(
              "Original worker termination is unconfirmed; its identities were retained",
            );
          if (!["Failed", "Succeeded"].includes(pod.phase))
            throw refused(
              "Stop the original worker before explicit recovery. After a node reboot Kubernetes reports the Pod Failed; wait for that state and keep the Pod object.",
            );
          if (!current.runtimeHostImage)
            throw refused("Original worker bootstrap image is missing");
          requireRuntimePodArtifacts(pod, current.runtimeHostImage, profile.image);
          if (
            (
              await transaction`SELECT id FROM factory.runtime_attempt
               WHERE factorybox_admission_id=${current.admissionID} AND state NOT IN ('failed','stopped')
                 AND NOT (${storage === "retain"} AND state='cleanup-failed') LIMIT 1`
            ).length ||
            (
              await transaction`SELECT id FROM factory.execution_slot
              WHERE factorybox_admission_id=${current.admissionID} AND state<>'deleted' LIMIT 1`
            ).length
          )
            throw refused("Worker recovery requires all prior execution to settle through Stop");
          // A terminal original Pod cannot execute these cleanup-only attempts.
          // Retaining the exact store lets the successor observe their pending
          // retirement. It neither declares cleanup successful nor releases data.
          const next = factoryboxRuntimeProfile.parse(configured);
          if (next.nodeName !== current.nodeName || next.architecture !== profile.architecture)
            throw refused(
              "Worker recovery cannot move Source or the retained store to another platform",
            );
          if (storage === "fresh") {
            const [pending] = await transaction`WITH store_admissions AS (
              SELECT id FROM factory.factorybox_worker_admission
              WHERE worker_id=${current.id} AND claim_uid=${current.claimUID}
            ) SELECT 1 WHERE
              EXISTS(SELECT 1 FROM factory.factorybox_runtime runtime
                JOIN factory.runtime_attempt attempt ON attempt.id=runtime.runtime_attempt_id
                WHERE attempt.factorybox_admission_id IN (SELECT id FROM store_admissions)
                  AND runtime.inputs_released_at IS NULL)
              OR EXISTS(SELECT 1 FROM factory.execution_slot slot
                WHERE slot.factorybox_admission_id IN (SELECT id FROM store_admissions)
                  AND slot.assigned_attempt_id IS NULL
                  AND (slot.factorybox_start_attempted OR slot.factorybox_fork_attempted)
                  AND slot.factorybox_retirement_observation IS NULL)
              OR EXISTS(SELECT 1 FROM factory.factorybox_lifecycle_operation operation
                JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
                WHERE attempt.factorybox_admission_id IN (SELECT id FROM store_admissions)
                  AND operation.action IN ('retire-checkpoint','retire-resume','retire-sandbox')
                  AND operation.completed_at IS NULL)`;
            if (pending)
              throw refused(
                "Fresh storage requires confirmed private backing cleanup; retain the store to continue unresolved retirement",
              );
          }
          const previousStore = profile.retainedStore ?? {
            storeID: current.identity?.storeID,
            initializedByPodUID: current.podUID,
            boundedBytes: current.identity?.boundedBytes ?? profile.boundedBytes,
          };
          const selection =
            storage === "fresh"
              ? { ...next, storageAdmission: 1 as const }
              : {
                  ...next,
                  boundedBytes: profile.boundedBytes,
                  minimumBoundedBytes: profile.minimumBoundedBytes,
                  claimGiB: profile.claimGiB,
                  retainedStore: previousStore,
                };
          if (storage === "fresh") delete selection.retainedStore;
          const selected = factoryboxRuntimeProfile.parse(
            await admitResources(factoryboxRuntimeProfile.parse(selection)),
          );
          const location = factoryboxLocation(current.id, input.requestID);
          const rendered = renderFactoryboxRuntime({
            ...location,
            attemptID: input.requestID,
            sandboxID: factoryboxSandboxID(input.requestID),
            runtimeOwnerID: input.requestID,
            runtimeHostImage: bootstrapImage,
            labels: {},
            profile: selected,
            sharedSource: false,
          });
          const originalDeclaration = factoryboxWorkerDeclaration.parse(current.declaration);
          const declaration = factoryboxWorkerDeclaration.parse({
            namespace: originalDeclaration.namespace,
            claim: storage === "fresh" ? rendered.claim : originalDeclaration.claim,
            pod: rendered.pod,
          });
          await transaction`UPDATE factory.factorybox_worker_admission
            SET retired_at=now(),retirement_observation=${JSON.stringify({
              version: 1,
              kind: "operator-recovery",
              ...(storage === "fresh" ? { storage } : {}),
              podUID: pod.uid,
              phase: pod.phase,
              namespaceUID: namespace.uid,
              actorID: input.actorID,
              requestID: input.requestID,
            })}::text::jsonb WHERE id=${current.admissionID} AND retired_at IS NULL`;
          await transaction`INSERT INTO factory.factorybox_worker_admission(
            id,worker_id,previous_id,profile,runtime_host_image,claim_uid,declaration,created_by)
            VALUES(${input.requestID},${current.id},${current.admissionID},
              ${JSON.stringify(selected)}::text::jsonb,${bootstrapImage},${storage === "fresh" ? null : current.claimUID},
              ${JSON.stringify(declaration)}::text::jsonb,${input.actorID})`;
          return {
            workerID: current.id,
            admissionID: input.requestID,
            previousAdmissionID: current.admissionID,
          };
        });
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtext('factorybox-worker-create'))`;
      }
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
