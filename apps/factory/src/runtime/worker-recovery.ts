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
const refused = (message: string) => new CommandError("conflict", message);

export async function recoverFactoryboxWorker(
  database: Database,
  kubernetes: KubernetesClient,
  configured: FactoryboxRuntimeProfile,
  bootstrapImage: string,
  input: { actorID: string; requestID: string },
  admitResources = admitFactoryboxWorkerResources,
) {
  z.uuid().parse(input.requestID);
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
            Array<{ workerID: string; previousID: string; actorID: string; kind: string | null }>
          >`
            SELECT admitted.worker_id AS "workerID",admitted.previous_id AS "previousID",
              admitted.created_by AS "actorID",previous.retirement_observation->>'kind' AS kind
            FROM factory.factorybox_worker_admission admitted
            LEFT JOIN factory.factorybox_worker_admission previous ON previous.id=admitted.previous_id
            WHERE admitted.id=${input.requestID}`;
          if (completed) {
            if (
              completed.workerID !== original["id"] ||
              completed.actorID !== input.actorID ||
              !completed.previousID ||
              completed.kind !== "operator-recovery"
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
          if (
            !namespace ||
            namespace.uid !== current.namespaceUID ||
            !Object.entries(labels).every(([key, value]) => namespace.labels[key] === value) ||
            !pod ||
            pod.uid !== current.podUID ||
            !Object.entries(labels).every(([key, value]) => pod.labels[key] === value)
          )
            throw refused(
              "Original worker termination is unconfirmed; its identities were retained",
            );
          if (!["Failed", "Succeeded"].includes(pod.phase))
            throw refused("Stop the original worker before explicit recovery");
          if (!current.runtimeHostImage)
            throw refused("Original worker bootstrap image is missing");
          requireRuntimePodArtifacts(pod, current.runtimeHostImage, profile.image);
          if (
            (
              await transaction`SELECT id FROM factory.runtime_attempt
              WHERE factorybox_admission_id=${current.admissionID} AND state NOT IN ('failed','stopped') LIMIT 1`
            ).length ||
            (
              await transaction`SELECT id FROM factory.execution_slot
              WHERE factorybox_admission_id=${current.admissionID} AND state<>'deleted' LIMIT 1`
            ).length
          )
            throw refused("Worker recovery requires all prior execution to settle through Stop");
          const next = factoryboxRuntimeProfile.parse(configured);
          if (next.nodeName !== current.nodeName || next.architecture !== profile.architecture)
            throw refused(
              "Worker recovery cannot move Source or the retained store to another platform",
            );
          const previousStore = profile.retainedStore ?? {
            storeID: current.identity?.storeID,
            initializedByPodUID: current.podUID,
            boundedBytes: current.identity?.boundedBytes ?? profile.boundedBytes,
          };
          const selected = factoryboxRuntimeProfile.parse(
            await admitResources(
              factoryboxRuntimeProfile.parse({
                ...next,
                boundedBytes: profile.boundedBytes,
                minimumBoundedBytes: profile.minimumBoundedBytes,
                claimGiB: profile.claimGiB,
                retainedStore: previousStore,
              }),
            ),
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
            claim: originalDeclaration.claim,
            pod: rendered.pod,
          });
          await transaction`UPDATE factory.factorybox_worker_admission
            SET retired_at=now(),retirement_observation=${JSON.stringify({
              version: 1,
              kind: "operator-recovery",
              podUID: pod.uid,
              phase: pod.phase,
              namespaceUID: namespace.uid,
              actorID: input.actorID,
              requestID: input.requestID,
            })}::text::jsonb WHERE id=${current.admissionID} AND retired_at IS NULL`;
          await transaction`INSERT INTO factory.factorybox_worker_admission(
            id,worker_id,previous_id,profile,runtime_host_image,claim_uid,declaration,created_by)
            VALUES(${input.requestID},${current.id},${current.admissionID},
              ${JSON.stringify(selected)}::text::jsonb,${bootstrapImage},${current.claimUID},
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
