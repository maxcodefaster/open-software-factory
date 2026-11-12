import { isDeepStrictEqual } from "node:util";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { nativeLifecycleWindowMS } from "../../../../packages/runtime-domain/src/timing";
import {
  type KubernetesClient,
  requireRuntimePodArtifacts,
} from "../../../../packages/runtime-kubernetes/src/client";
import { withCommandDeadline } from "../../../../packages/runtime-kubernetes/src/command";
import {
  factoryboxLocation,
  factoryboxSharedLabels,
} from "../../../../packages/runtime-kubernetes/src/factorybox-location";
import { requireOriginalFactoryboxNode } from "../../../../packages/runtime-kubernetes/src/factorybox-node-discovery";
import { admitFactoryboxWorkerResources } from "../../../../packages/runtime-kubernetes/src/factorybox-resource-admission";
import {
  configuredFactoryboxRuntimeProfile,
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeImage,
  factoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
  factoryboxSandboxID,
  renderFactoryboxRuntime,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  type FactoryboxWorkerIdentity,
  factoryboxWorkerDeclaration,
  factoryboxWorkerIdentity,
  factoryboxWorkerRequest,
  observeOriginalFactoryboxDeclaration,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import { requireActiveAccountIn } from "../access/controller";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | TransactionSql;

export const terminatedFactoryboxWorkerFailure =
  "Original Factorybox worker terminated; execution cannot start on it. Source and worker history are retained. A fresh Start can recover failed initial setup after prior work settles. An already admitted worker requires operator recovery.";

// Keep lifecycle commands ordered within their worker across Factory processes.
// The retained default keeps its original key; remote workers use their own key.
export async function withFactoryboxWorkerLock<T>(
  sql: Database["client"],
  action: () => Promise<T>,
  deadline = performance.now() + nativeLifecycleWindowMS,
  workerID?: string,
) {
  const key = workerID ? `factorybox-worker-lifecycle:${workerID}` : "factorybox-worker-lifecycle";
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new Error("Factorybox worker deadline expired before admission");
  await sql`SELECT set_config('lock_timeout',${`${remaining}ms`},false)`;
  await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
  try {
    return await withCommandDeadline(deadline, action);
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
  }
}

type Worker = {
  id: string;
  singleton: boolean;
  nodeIdentity: unknown | null;
  admissionID: string;
  nodeName: string | null;
  namespaceUID: string | null;
  sourceClaimUID: string | null;
  claimUID: string | null;
  podUID: string | null;
  profile: unknown | null;
  runtimeHostImage: string | null;
  identity: FactoryboxWorkerIdentity | null;
  attempted: boolean;
  declaration: unknown | null;
};
const resource = z
  .object({
    kind: z.string(),
    metadata: z
      .object({
        name: z.string(),
        namespace: z.string().optional(),
        labels: z.record(z.string(), z.string()),
      })
      .passthrough(),
  })
  .passthrough();

async function read(sql: SQL, workerID?: string, admissionID?: string) {
  const [worker] = await sql<Worker[]>`SELECT worker.id,admission.id AS "admissionID",
    worker.singleton,worker.node_identity AS "nodeIdentity",
    worker.node_name AS "nodeName",worker.namespace_uid AS "namespaceUID",
    worker.source_claim_uid AS "sourceClaimUID",admission.claim_uid AS "claimUID",
    admission.pod_uid AS "podUID",admission.profile,admission.runtime_host_image AS "runtimeHostImage",
    admission.identity,admission.create_attempted AS attempted,admission.declaration
    FROM factory.factorybox_worker worker JOIN factory.factorybox_worker_admission admission
      ON admission.worker_id=worker.id
      AND (${admissionID ?? null}::uuid IS NULL AND admission.retired_at IS NULL OR admission.id=${admissionID ?? null}::uuid)
    WHERE (${workerID ?? null}::uuid IS NULL AND worker.singleton OR worker.id=${workerID ?? null}::uuid)`;
  if (!worker) throw new Error("Factory worker intent is missing");
  return worker;
}

export async function retainedFactoryboxProfile(
  sql: SQL,
  configured?: FactoryboxRuntimeProfile,
  bootstrapImage?: string,
  admitResources = admitFactoryboxWorkerResources,
): Promise<FactoryboxRuntimeProfile> {
  const [worker] = await sql<Array<{ profile: unknown | null }>>`
    SELECT admission.profile FROM factory.factorybox_worker worker
    LEFT JOIN factory.factorybox_worker_admission admission
      ON admission.worker_id=worker.id AND admission.retired_at IS NULL WHERE worker.singleton`;
  if (worker?.profile) return factoryboxRuntimeProfile.parse(worker.profile);
  const selected = factoryboxRuntimeProfile.parse(
    configured ?? configuredFactoryboxRuntimeProfile(),
  );
  // Pool observation does not commission execution or pin a budget. A fresh
  // execution supplies its exact bootstrap image, retained with the profile.
  if (!selected.resourceAdmission || !bootstrapImage) return selected;
  factoryboxRuntimeImage.parse(bootstrapImage);
  const allocation = await factoryboxAllocation(sql, selected.nodeName);
  // Another commissioner may have selected a budget while we allocated Source.
  if (allocation.profile) return factoryboxRuntimeProfile.parse(allocation.profile);
  const admitted = factoryboxRuntimeProfile.parse(await admitResources(selected));
  if (!admitted.resources)
    throw new Error("Worker resource admission did not select a finite budget");
  const [retained] = await sql<Array<{ profile: unknown }>>`
    UPDATE factory.factorybox_worker_admission
    SET profile=coalesce(profile,${JSON.stringify(admitted)}::text::jsonb),
      runtime_host_image=coalesce(runtime_host_image,${bootstrapImage})
    WHERE id=${allocation.admissionID} AND retired_at IS NULL
      AND (profile IS NOT NULL OR NOT create_attempted)
    RETURNING profile`;
  if (!retained) throw new Error("Worker admission changed before resource selection was retained");
  return factoryboxRuntimeProfile.parse(retained.profile);
}

export async function factoryboxAllocation(
  sql: SQL,
  nodeName?: string | null,
  workerID?: string,
  admissionID?: string,
) {
  if (workerID) {
    let worker = await read(sql, workerID, admissionID);
    if (nodeName && worker.nodeName !== nodeName) {
      if (!worker.singleton || worker.nodeName)
        throw new Error("Execution worker differs from its retained node");
      // Fresh isolated default execution has no Workspace Source preparation to
      // pin this field first. Preserve its original one-time node binding too.
      const pinned = await sql`UPDATE factory.factorybox_worker SET node_name=${nodeName}
        WHERE id=${workerID} AND node_name IS NULL`;
      if (pinned.count !== 1) throw new Error("Original worker node changed before binding");
      worker = await read(sql, workerID, admissionID);
    }
    return { ...factoryboxLocation(worker.id, worker.admissionID), ...worker };
  }
  await sql`SELECT factory.ensure_factorybox_admission()`;
  if (nodeName) {
    const updated =
      await sql`UPDATE factory.factorybox_worker SET node_name=coalesce(node_name,${nodeName})
      WHERE singleton AND (node_name IS NULL OR node_name=${nodeName})`;
    if (updated.count !== 1)
      throw new Error("Canonical Source and the Factory worker must remain on their original node");
  }
  const worker = await read(sql);
  return { ...factoryboxLocation(worker.id, worker.admissionID), ...worker };
}

export async function rememberFactoryboxSource(
  sql: SQL,
  workerID: string,
  source: { namespaceUID: string; claimUID: string; storageNode: string | null },
) {
  const updated = await sql`UPDATE factory.factorybox_worker
    SET namespace_uid=coalesce(namespace_uid,${source.namespaceUID}),
      source_claim_uid=coalesce(source_claim_uid,${source.claimUID}),
      node_name=coalesce(node_name,${source.storageNode})
    WHERE id=${workerID}
      AND (namespace_uid IS NULL OR namespace_uid=${source.namespaceUID})
      AND (source_claim_uid IS NULL OR source_claim_uid=${source.claimUID})
      AND (${source.storageNode}::text IS NULL OR node_name IS NULL OR node_name=${source.storageNode})`;
  if (updated.count !== 1)
    throw new Error("Shared canonical Source storage differs from its original Factory identity");
}

async function bindProfile(
  sql: SQL,
  profileInput: unknown,
  image: string,
  workerID?: string,
  admissionID?: string,
) {
  const profile = factoryboxRuntimeProfile.parse(profileInput);
  if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Factory worker consumer image must be pinned");
  const worker = await factoryboxAllocation(sql, profile.nodeName, workerID, admissionID);
  const updated = await sql`UPDATE factory.factorybox_worker_admission
    SET profile=coalesce(profile,${JSON.stringify(profile)}::text::jsonb),
      runtime_host_image=coalesce(runtime_host_image,${image})
    WHERE id=${worker.admissionID} AND retired_at IS NULL
      AND (profile IS NULL OR profile=${JSON.stringify(profile)}::text::jsonb)`;
  if (updated.count !== 1)
    throw new Error(
      "Factory worker profile is already pinned; refusing a different worker profile",
    );
  const bound = await read(sql, worker.id, worker.admissionID);
  if (worker.admissionID === worker.id)
    await sql`UPDATE factory.factorybox_worker
      SET profile=coalesce(profile,${JSON.stringify(profile)}::text::jsonb),
        runtime_host_image=coalesce(runtime_host_image,${bound.runtimeHostImage}) WHERE id=${worker.id}`;
  return read(sql, worker.id, worker.admissionID);
}

export async function rememberFactoryboxIdentity(
  sql: SQL,
  workerID: string,
  value: FactoryboxWorkerIdentity,
) {
  const identity = factoryboxWorkerIdentity.parse(value);
  const worker = await read(sql, workerID);
  const profile = factoryboxRuntimeProfile.parse(worker.profile);
  if (
    worker.id !== workerID ||
    !worker.attempted ||
    identity.storeID !==
      (profile.retainedStore?.storeID ?? worker.admissionID.replaceAll("-", "")) ||
    (profile.retainedStore &&
      identity.boundedBytes !== undefined &&
      identity.boundedBytes !== profile.retainedStore.boundedBytes) ||
    identity.executableSHA256 !== profile.executableSHA256 ||
    (profile.minimumBoundedBytes === undefined
      ? identity.boundedBytes !== undefined
      : identity.boundedBytes === undefined ||
        identity.boundedBytes < profile.minimumBoundedBytes ||
        identity.boundedBytes > profile.boundedBytes) ||
    (worker.identity && !isDeepStrictEqual(worker.identity, identity))
  )
    throw new Error("Native worker identity differs from its Factory create intent");
  if (identity.namespaceUID !== worker.namespaceUID)
    throw new Error("Native worker Namespace differs from its canonical Source allocation");
  const updated = await sql`UPDATE factory.factorybox_worker_admission
    SET claim_uid=coalesce(claim_uid,${identity.claimUID}),
      pod_uid=coalesce(pod_uid,${identity.podUID}),
      identity=coalesce(identity,${JSON.stringify(identity)}::text::jsonb)
    WHERE id=${worker.admissionID} AND retired_at IS NULL
      AND (claim_uid IS NULL OR claim_uid=${identity.claimUID})
      AND (pod_uid IS NULL OR pod_uid=${identity.podUID})`;
  if (updated.count !== 1) throw new Error("Factory worker Kubernetes identity changed");
  if (worker.admissionID === worker.id)
    await sql`UPDATE factory.factorybox_worker
      SET claim_uid=coalesce(claim_uid,${identity.claimUID}),
        pod_uid=coalesce(pod_uid,${identity.podUID}),
        identity=coalesce(identity,${JSON.stringify(identity)}::text::jsonb)
      WHERE id=${workerID}`;
}

export function createFactoryboxWorker(
  database: Database,
  kubernetes: KubernetesClient,
  nextProfile?: () => FactoryboxRuntimeProfile,
) {
  async function recoverBootstrap(input: { actorID: string; requestID: string }) {
    z.uuid().parse(input.requestID);
    const sql = database.coordination();
    try {
      return await withFactoryboxWorkerLock(sql, async () => {
        await sql`SELECT pg_advisory_lock(hashtext('factorybox-worker-create'))`;
        try {
          const current = await factoryboxAllocation(sql);
          if (!current.attempted || !current.podUID || current.identity) return current;
          const location = factoryboxLocation(current.id, current.admissionID);
          const namespace = await kubernetes.getNamespace(location.namespace);
          const pod = await kubernetes.getPod(location.namespace, location.podName);
          const labels = factoryboxSharedLabels(current.id);
          if (
            !namespace ||
            namespace.uid !== current.namespaceUID ||
            !Object.entries(labels).every(([key, value]) => namespace.labels[key] === value) ||
            !pod ||
            pod.uid !== current.podUID ||
            !Object.entries(labels).every(([key, value]) => pod.labels[key] === value)
          )
            throw new Error(
              "Original worker identity is unconfirmed; bootstrap recovery was refused",
            );
          if (pod.phase !== "Failed" && pod.phase !== "Succeeded") return current;
          const profile = factoryboxRuntimeProfile.parse(current.profile);
          if (profile.retainedStore)
            throw new Error("A retained-store worker requires explicit operator recovery");
          const selected = factoryboxRuntimeProfile.parse(
            await admitFactoryboxWorkerResources(nextProfile?.() ?? profile),
          );
          if (selected.nodeName !== current.nodeName)
            throw new Error("Bootstrap recovery cannot move canonical Source to another node");
          if (!current.runtimeHostImage)
            throw new Error("Original worker bootstrap image is missing");
          requireRuntimePodArtifacts(pod, current.runtimeHostImage, profile.image);
          await sql.begin(async (transaction) => {
            await requireActiveAccountIn(transaction, input.actorID);
            await transaction`SELECT id FROM factory.factorybox_worker_admission
              WHERE id=${current.admissionID} AND retired_at IS NULL FOR UPDATE`;
            const busy = await transaction`SELECT id FROM factory.runtime_attempt
              WHERE factorybox_admission_id=${current.admissionID} AND state NOT IN ('failed','stopped') LIMIT 1`;
            if (busy.length)
              throw new Error("Worker bootstrap recovery requires settled prior execution");
            const retired = await transaction`UPDATE factory.factorybox_worker_admission
              SET retired_at=now(),retirement_observation=${JSON.stringify({
                version: 1,
                podUID: pod.uid,
                phase: pod.phase,
                namespaceUID: namespace.uid,
                actorID: input.actorID,
                requestID: input.requestID,
              })}::text::jsonb WHERE id=${current.admissionID} AND retired_at IS NULL`;
            if (retired.count !== 1)
              throw new Error("Worker admission changed before bootstrap recovery");
            await transaction`INSERT INTO factory.factorybox_worker_admission(
              id,worker_id,previous_id,profile,runtime_host_image,created_by)
              VALUES(${input.requestID},${current.id},${current.admissionID},
                ${JSON.stringify({ ...selected, storageAdmission: 1 })}::text::jsonb,
                ${current.runtimeHostImage},${input.actorID})`;
          });
          return factoryboxAllocation(sql);
        } finally {
          await sql`SELECT pg_advisory_unlock(hashtext('factorybox-worker-create'))`;
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  return {
    async retainDeclaration() {
      // Do not allocate a worker or start compute while recovering a receipt.
      const missing = await database.client<
        Array<{ id: string; workerID: string; singleton: boolean }>
      >`
        SELECT admission.id,worker.id AS "workerID",worker.singleton
        FROM factory.factorybox_worker_admission admission JOIN factory.factorybox_worker worker ON worker.id=admission.worker_id
        WHERE admission.retired_at IS NULL AND admission.declaration IS NULL AND admission.identity IS NOT NULL`;
      if (!missing.length) return;
      for (const selected of missing) {
        const sql = database.coordination();
        try {
          await withFactoryboxWorkerLock(
            sql,
            async () => {
              const createKey = selected.singleton
                ? "factorybox-worker-create"
                : `factorybox-worker-create:${selected.workerID}`;
              await sql`SELECT pg_advisory_lock(hashtext(${createKey}))`;
              try {
                const worker = await read(sql, selected.workerID, selected.id);
                if (worker.declaration || !worker.identity || !worker.runtimeHostImage) return;
                const location = factoryboxLocation(worker.id, worker.admissionID);
                const pod = await kubernetes.getPod(location.namespace, location.podName);
                if (pod?.phase !== "Running" || !pod.ready) return;
                requireRuntimePodArtifacts(
                  pod,
                  worker.runtimeHostImage,
                  factoryboxRuntimeProfile.parse(worker.profile).image,
                );
                // This renders only the worker projection. No Sandbox or Runtime
                // Attempt is admitted, created, resumed or replayed here.
                const input = {
                  ...location,
                  attemptID: worker.admissionID,
                  sandboxID: factoryboxSandboxID(worker.admissionID),
                  runtimeOwnerID: worker.id,
                  runtimeHostImage: worker.runtimeHostImage,
                  profile: factoryboxRuntimeProfile.parse(worker.profile),
                  labels: {},
                  sharedSource: false,
                };
                const declaration = await observeOriginalFactoryboxDeclaration(
                  factoryboxRuntimeRequest(input),
                  factoryboxWorkerIdentity.parse(worker.identity),
                  renderFactoryboxRuntime(input),
                );
                const retained = await sql`UPDATE factory.factorybox_worker_admission
              SET declaration=${JSON.stringify(declaration)}::text::jsonb
              WHERE id=${worker.admissionID} AND declaration IS NULL AND retired_at IS NULL`;
                if (retained.count !== 1)
                  throw new Error("Original worker declaration changed during recovery");
              } finally {
                await sql`SELECT pg_advisory_unlock(hashtext(${createKey}))`;
              }
            },
            undefined,
            selected.singleton ? undefined : selected.workerID,
          );
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
    async location(sql: SQL = database.client, recovery?: { actorID: string; requestID: string }) {
      const current = recovery ? await recoverBootstrap(recovery) : await factoryboxAllocation(sql);
      return factoryboxLocation(current.id, current.admissionID);
    },
    async provision(
      resources: readonly unknown[],
      profile: FactoryboxRuntimeProfile,
      runtimeHostImage: string,
      destination?: { workerID: string; admissionID: string },
    ) {
      const declared = resources.map((value) => resource.parse(value));
      const sql = database.coordination();
      let createKey: string | undefined;
      try {
        const selected = destination
          ? await read(sql, destination.workerID, destination.admissionID)
          : undefined;
        createKey =
          selected && !selected.singleton
            ? `factorybox-worker-create:${selected.id}`
            : "factorybox-worker-create";
        await sql`SELECT pg_advisory_lock(hashtext(${createKey}))`;
        const worker = await bindProfile(
          sql,
          profile,
          runtimeHostImage,
          destination?.workerID,
          destination?.admissionID,
        );
        if (!worker.singleton)
          await requireOriginalFactoryboxNode(profile.nodeName, worker.nodeIdentity);
        const bootstrapImage = worker.runtimeHostImage;
        if (!bootstrapImage) throw new Error("Factory worker bootstrap image is missing");
        const location = factoryboxLocation(worker.id, worker.admissionID);
        const storeID = profile.retainedStore?.storeID ?? worker.admissionID.replaceAll("-", "");
        // The shared Pod keeps its exact original init image and environment.
        // Consumer upgrades are exported separately after native admission.
        for (const item of declared) {
          if (item.kind !== "Pod" || item.metadata.name !== location.podName) continue;
          const pod = z
            .object({
              spec: z
                .object({
                  initContainers: z.array(
                    z.object({ name: z.string(), image: z.string() }).passthrough(),
                  ),
                  containers: z.array(z.object({ name: z.string() }).passthrough()),
                })
                .passthrough(),
            })
            .parse(item);
          for (const container of [...pod.spec.initContainers, ...pod.spec.containers]) {
            if (container.name === "runtime-image") Reflect.set(container, "image", bootstrapImage);
            const env = z
              .array(z.object({ name: z.string(), value: z.string().optional() }).passthrough())
              .parse(Reflect.get(container, "env"));
            for (const entry of env)
              if (entry.name === "FACTORY_RUNTIME_IMAGE") entry.value = bootstrapImage;
            Reflect.set(container, "env", env);
          }
          Reflect.set(item, "spec", pod.spec);
        }
        const declaredPod = declared.find((value) => value.kind === "Pod");
        if (!declaredPod || declaredPod.metadata.name !== location.podName)
          throw new Error("Execution resources belong to a different worker admission");
        const expectedLabels = factoryboxSharedLabels(worker.id);
        const namespace = declared.find((value) => value.kind === "Namespace");
        if (
          !namespace ||
          !isDeepStrictEqual(namespace.metadata, {
            name: location.namespace,
            labels: expectedLabels,
          })
        )
          throw new Error("Execution resources do not belong to the shared Factory Namespace");
        let observedNamespace = await kubernetes.getNamespace(location.namespace);
        if (observedNamespace) {
          if (
            (worker.namespaceUID && worker.namespaceUID !== observedNamespace.uid) ||
            !Object.entries(expectedLabels).every(
              ([key, value]) => observedNamespace?.labels[key] === value,
            )
          )
            throw new Error("Factory Namespace identity or ownership changed");
        } else {
          if (worker.namespaceUID) throw new Error("Original Factory Namespace disappeared");
          const created = await kubernetes.apply([namespace]);
          observedNamespace = { uid: created.namespaceUID, labels: expectedLabels };
        }
        const namespacePinned =
          await sql`UPDATE factory.factorybox_worker SET namespace_uid=coalesce(namespace_uid,${observedNamespace.uid})
          WHERE id=${worker.id} AND (namespace_uid IS NULL OR namespace_uid=${observedNamespace.uid})`;
        if (namespacePinned.count !== 1) throw new Error("Factory Namespace UID changed");
        const pod = await kubernetes.getPod(location.namespace, location.podName);
        if (pod && !worker.attempted)
          throw new Error("Refusing a worker Pod without its persisted create attempt");
        if (worker.podUID && !pod)
          throw new Error(
            "Original Factory worker Pod no longer exists (its node was deleted or replaced, or the Pod object was removed). Its termination was not observed, so no replacement was created. Source and the store claim are retained; restore the original node and Pod object.",
          );
        if (worker.podUID && pod?.uid !== worker.podUID)
          throw new Error("Original Factory worker UID changed");
        if (!pod && worker.attempted)
          throw new Error("Factory worker creation is unconfirmed; refusing another create");
        const storeClaimDeclaration = declared.find(
          (item) =>
            item.kind === "PersistentVolumeClaim" && item.metadata.name === `store-${storeID}`,
        );
        if (!storeClaimDeclaration) throw new Error("Factory worker store declaration is missing");
        let declaration = worker.declaration
          ? factoryboxWorkerDeclaration.parse(worker.declaration)
          : factoryboxWorkerDeclaration.parse({
              namespace,
              claim: storeClaimDeclaration,
              pod: declaredPod,
            });
        if (!worker.declaration && pod) {
          if (!worker.identity)
            throw new Error(
              "Original worker bootstrap is unconfirmed; retain its admission before upgrading",
            );
          const nativeProfile = { ...profile };
          delete nativeProfile.storageAdmission;
          delete nativeProfile.filesystemLayout;
          delete nativeProfile.resourceAdmission;
          delete nativeProfile.retainedStore;
          declaration = factoryboxWorkerDeclaration.parse(
            await observeOriginalFactoryboxDeclaration(
              factoryboxWorkerRequest.parse({
                ...nativeProfile,
                version: 1,
                namespace: location.namespace,
                podName: location.podName,
                storeID,
                trustDomainID: worker.id.replaceAll("-", ""),
              }),
              factoryboxWorkerIdentity.parse(worker.identity),
              declaration,
            ),
          );
        }
        const frozen = await sql`UPDATE factory.factorybox_worker_admission
          SET declaration=coalesce(declaration,${JSON.stringify(declaration)}::text::jsonb)
          WHERE id=${worker.admissionID} AND retired_at IS NULL
            AND (declaration IS NULL OR declaration=${JSON.stringify(declaration)}::text::jsonb)`;
        if (frozen.count !== 1) throw new Error("Factory worker bootstrap declaration changed");
        // Never send an upgraded renderer's bootstrap or resource defaults to
        // the original worker. Private per-Sandbox resources remain separate.
        Reflect.set(declaredPod, "metadata", declaration.pod.metadata);
        Reflect.set(declaredPod, "spec", declaration.pod.spec);
        Reflect.set(storeClaimDeclaration, "metadata", declaration.claim.metadata);
        Reflect.set(storeClaimDeclaration, "spec", declaration.claim.spec);
        if (!pod) {
          await sql`UPDATE factory.factorybox_worker_admission SET create_attempted=true
            WHERE id=${worker.admissionID} AND retired_at IS NULL`;
          if (worker.admissionID === worker.id)
            await sql`UPDATE factory.factorybox_worker SET create_attempted=true WHERE id=${worker.id}`;
        }
        const storeKey = `PersistentVolumeClaim/store-${storeID}`;
        const shared = declared.filter(
          (value) =>
            value === namespace || value.metadata.labels["factory.dev/shared-resource"] === "true",
        );
        const applied = await kubernetes.apply(shared, {
          ownerID: worker.id,
          uid: observedNamespace.uid,
          createShared: !pod,
          sharedUIDs: {
            ...(worker.sourceClaimUID
              ? { "PersistentVolumeClaim/runtime-data": worker.sourceClaimUID }
              : {}),
            ...(worker.claimUID ? { [storeKey]: worker.claimUID } : {}),
            ...(pod ? { [`Pod/${location.podName}`]: pod.uid } : {}),
          },
        });
        const sourceClaim = applied.sharedUIDs?.["PersistentVolumeClaim/runtime-data"];
        const storeClaim = applied.sharedUIDs?.[storeKey];
        if (!sourceClaim || !storeClaim)
          throw new Error("Factory shared storage create outcome is unconfirmed");
        const sourcePinned = await sql`UPDATE factory.factorybox_worker
          SET source_claim_uid=coalesce(source_claim_uid,${sourceClaim})
          WHERE id=${worker.id} AND (source_claim_uid IS NULL OR source_claim_uid=${sourceClaim})`;
        const storagePinned = await sql`UPDATE factory.factorybox_worker_admission
          SET claim_uid=coalesce(claim_uid,${storeClaim})
          WHERE id=${worker.admissionID} AND retired_at IS NULL
            AND (claim_uid IS NULL OR claim_uid=${storeClaim})`;
        if (storagePinned.count !== 1 || sourcePinned.count !== 1)
          throw new Error("Factory shared storage UID changed");
        if (worker.admissionID === worker.id)
          await sql`UPDATE factory.factorybox_worker SET claim_uid=coalesce(claim_uid,${storeClaim})
            WHERE id=${worker.id}`;
        const original = pod ?? (await kubernetes.getPod(location.namespace, location.podName));
        if (!original) throw new Error("Original Factory worker create outcome is unconfirmed");
        requireRuntimePodArtifacts(original, bootstrapImage, profile.image);
        if (!Object.entries(expectedLabels).every(([key, value]) => original.labels[key] === value))
          throw new Error("Factory worker Pod ownership changed");
        const podPinned =
          await sql`UPDATE factory.factorybox_worker_admission SET pod_uid=coalesce(pod_uid,${original.uid})
          WHERE id=${worker.admissionID} AND retired_at IS NULL AND (pod_uid IS NULL OR pod_uid=${original.uid})`;
        if (podPinned.count !== 1) throw new Error("Original Factory worker UID changed");
        if (worker.admissionID === worker.id)
          await sql`UPDATE factory.factorybox_worker SET pod_uid=coalesce(pod_uid,${original.uid})
            WHERE id=${worker.id}`;
        if (original.phase === "Failed" || original.phase === "Succeeded")
          throw new Error(terminatedFactoryboxWorkerFailure);
        const privateResources = declared.filter(
          (value) =>
            value.kind !== "Namespace" &&
            value.metadata.labels["factory.dev/shared-resource"] !== "true",
        );
        if (privateResources.length)
          await kubernetes.apply([namespace, ...privateResources], {
            ownerID: worker.id,
            uid: observedNamespace.uid,
          });
        return {
          namespaceUID: observedNamespace.uid,
          podUID: original.uid,
          workerRuntimeHostImage: bootstrapImage,
          workerDeclaration: declaration,
        };
      } finally {
        try {
          if (createKey) await sql`SELECT pg_advisory_unlock(hashtext(${createKey}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
  };
}
