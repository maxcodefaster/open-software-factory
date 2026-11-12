import { isDeepStrictEqual } from "node:util";
import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import { observeFactoryboxNodes } from "../../../../packages/runtime-kubernetes/src/factorybox-node-discovery";
import {
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeImage,
  factoryboxRuntimeProfile,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import { factoryboxAllocation, retainedFactoryboxProfile } from "./worker";

type SQL = ReturnType<typeof createDatabase>["client"] | TransactionSql;

// Only a NEW Verification calls this. Retained attempts always use their stored
// worker/admission/profile, even when the destination has failed or disappeared.
// Discovery never prompts a model or provisions cloud infrastructure.
export async function selectVerificationPlacement(
  sql: SQL,
  configured: FactoryboxRuntimeProfile,
  runtimeHostImage: string,
  observe = observeFactoryboxNodes,
  verificationID?: string,
) {
  factoryboxRuntimeImage.parse(runtimeHostImage);
  if (verificationID) {
    const [saved] = await sql<Array<{ workerID: string; admissionID: string }>>`
      SELECT worker_id AS "workerID",admission_id AS "admissionID" FROM factory.verification_compute_placement
      WHERE verification_id=${verificationID}`;
    if (saved)
      return {
        allocation: await factoryboxAllocation(sql, undefined, saved.workerID, saved.admissionID),
        refused: [],
      };
  }
  const original = await factoryboxAllocation(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtext('factory-verification-placement'))`;
  const owned = await sql<Array<{ podUID: string }>>`SELECT admission.pod_uid AS "podUID"
    FROM factory.factorybox_worker worker JOIN factory.factorybox_worker_admission admission ON admission.worker_id=worker.id
    WHERE NOT worker.singleton AND admission.retired_at IS NULL AND admission.pod_uid IS NOT NULL`;
  const observed = await observe(
    configured,
    undefined,
    owned.map((row) => row.podUID),
  );
  async function retain(allocation: Awaited<ReturnType<typeof factoryboxAllocation>>) {
    if (verificationID && !allocation.singleton) {
      await sql`INSERT INTO factory.verification_compute_placement(verification_id,worker_id,admission_id,profile)
        VALUES(${verificationID},${allocation.id},${allocation.admissionID},${JSON.stringify(allocation.profile)}::text::jsonb)`;
    }
    return { allocation, refused: observed.refused };
  }
  for (const candidate of observed.candidates) {
    if (candidate.nodeName === (original.nodeName ?? configured.nodeName)) continue;
    const [existing] = await sql<
      Array<{
        id: string;
        nodeIdentity: unknown;
        attempted: boolean;
        identity: unknown;
        podUID: string | null;
        profile: unknown;
      }>
    >`
      SELECT worker.id,worker.node_identity AS "nodeIdentity",admission.create_attempted AS attempted,
        admission.identity,admission.pod_uid AS "podUID",admission.profile FROM factory.factorybox_worker worker
      JOIN factory.factorybox_worker_admission admission ON admission.worker_id=worker.id AND admission.retired_at IS NULL
      WHERE NOT worker.singleton AND worker.node_name=${candidate.nodeName}`;
    if (existing) {
      if (!isDeepStrictEqual(existing.nodeIdentity, candidate.identity)) {
        observed.refused.push({
          nodeName: candidate.nodeName,
          reason: "Retained destination node UID or boot identity changed; no replacement admitted",
        });
        continue;
      }
      if (existing.attempted && !existing.identity) {
        observed.refused.push({
          nodeName: candidate.nodeName,
          reason: "Original worker create/native admission is unconfirmed; no repeated create",
        });
        continue;
      }
      if (existing.identity) {
        const pod = candidate.podObservations?.find((pod) => pod.uid === existing.podUID);
        if (pod?.phase !== "Running" || !pod.ready) {
          observed.refused.push({
            nodeName: candidate.nodeName,
            reason:
              "Original worker Pod is missing, terminal or not Ready; no adoption or replacement admitted",
          });
          continue;
        }
      }
      const retained = factoryboxRuntimeProfile.parse(existing.profile).resources;
      const available = candidate.profile.resources;
      if (
        !retained ||
        !available ||
        retained.cpuMilli > available.cpuMilli ||
        retained.memoryMiB > available.memoryMiB
      ) {
        observed.refused.push({
          nodeName: candidate.nodeName,
          reason: "Retained finite worker budget no longer fits node reservations and headroom",
        });
        continue;
      }
      // Capacity of a retained worker is checked by its finite native aggregate
      // gate. Never derive a new budget or change its immutable profile.
      return retain(await factoryboxAllocation(sql, candidate.nodeName, existing.id));
    }
    const workerID = crypto.randomUUID();
    await sql`INSERT INTO factory.factorybox_worker(id,singleton,node_name,node_identity)
      VALUES(${workerID},false,${candidate.nodeName},${JSON.stringify(candidate.identity)}::text::jsonb)`;
    await sql`INSERT INTO factory.factorybox_worker_admission(id,worker_id,profile,runtime_host_image)
      VALUES(${workerID},${workerID},${JSON.stringify(candidate.profile)}::text::jsonb,${runtimeHostImage})`;
    return retain(await factoryboxAllocation(sql, candidate.nodeName, workerID));
  }
  // Same-node handoff remains available; refusing B never grants permission to
  // move, reset or replace A's canonical Source. Native capacity owns waits.
  // The default worker keeps its existing explicit bootstrap-recovery path:
  // its Attempt/artifacts, not a new permanent Verification pointer, pin that
  // admission before creation. Remote placement is never reselected on retry.
  const profile = await retainedFactoryboxProfile(sql, configured, runtimeHostImage);
  // Legacy finite profiles have no automatic resource-selection step. Retain
  // their existing default before storing the new Verification's placement too.
  await sql`UPDATE factory.factorybox_worker_admission
    SET profile=coalesce(profile,${JSON.stringify(profile)}::text::jsonb),
      runtime_host_image=coalesce(runtime_host_image,${runtimeHostImage})
    WHERE id=${original.admissionID} AND retired_at IS NULL AND (profile IS NOT NULL OR NOT create_attempted)`;
  return retain(await factoryboxAllocation(sql));
}
