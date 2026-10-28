import { isDeepStrictEqual } from "node:util";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type KubernetesClient,
  requireRuntimePodArtifacts,
} from "../../../../packages/runtime-kubernetes/src/client";
import { withCommandDeadline } from "../../../../packages/runtime-kubernetes/src/command";
import {
  factoryboxLocation,
  factoryboxSharedLabels,
} from "../../../../packages/runtime-kubernetes/src/factorybox-location";
import {
  type FactoryboxRuntimeProfile,
  factoryboxRuntimeProfile,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  type FactoryboxWorkerIdentity,
  factoryboxWorkerIdentity,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | TransactionSql;

// All Sandboxes share one native controller lock. Keep its commands ordered
// across reserve, execution and retirement controllers, including other Factory
// processes connected to this installation's database.
export async function withFactoryboxWorkerLock<T>(
  sql: Database["client"],
  action: () => Promise<T>,
  deadline = performance.now() + 420_000,
) {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new Error("Factorybox worker deadline expired before admission");
  await sql`SELECT set_config('lock_timeout',${`${remaining}ms`},false)`;
  await sql`SELECT pg_advisory_lock(hashtext('factorybox-worker-lifecycle'))`;
  try {
    return await withCommandDeadline(deadline, action);
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('factorybox-worker-lifecycle'))`;
  }
}

type Worker = {
  id: string;
  nodeName: string | null;
  namespaceUID: string | null;
  sourceClaimUID: string | null;
  claimUID: string | null;
  podUID: string | null;
  profile: unknown | null;
  runtimeHostImage: string | null;
  identity: FactoryboxWorkerIdentity | null;
  attempted: boolean;
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

async function read(sql: SQL) {
  const [worker] = await sql<Worker[]>`SELECT id,node_name AS "nodeName",
    namespace_uid AS "namespaceUID",source_claim_uid AS "sourceClaimUID",claim_uid AS "claimUID",
    pod_uid AS "podUID",profile,runtime_host_image AS "runtimeHostImage",identity,
    create_attempted AS attempted FROM factory.factorybox_worker WHERE singleton`;
  if (!worker) throw new Error("Factory worker intent is missing");
  return worker;
}

export async function factoryboxAllocation(sql: SQL, nodeName?: string | null) {
  await sql`SELECT factory.ensure_factorybox_worker()`;
  if (nodeName) {
    const updated =
      await sql`UPDATE factory.factorybox_worker SET node_name=coalesce(node_name,${nodeName})
      WHERE singleton AND (node_name IS NULL OR node_name=${nodeName})`;
    if (updated.count !== 1)
      throw new Error("Canonical Source and the Factory worker must remain on their original node");
  }
  const worker = await read(sql);
  return { ...factoryboxLocation(worker.id), ...worker };
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

async function bindProfile(sql: SQL, profileInput: unknown, image: string) {
  const profile = factoryboxRuntimeProfile.parse(profileInput);
  if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Factory worker consumer image must be pinned");
  await factoryboxAllocation(sql, profile.nodeName);
  const updated = await sql`UPDATE factory.factorybox_worker
    SET profile=coalesce(profile,${JSON.stringify(profile)}::text::jsonb),
      runtime_host_image=coalesce(runtime_host_image,${image})
    WHERE singleton AND (profile IS NULL OR profile=${JSON.stringify(profile)}::text::jsonb)`;
  if (updated.count !== 1)
    throw new Error(
      "Factory worker profile is already pinned; refusing a different worker profile",
    );
  return read(sql);
}

export async function rememberFactoryboxIdentity(
  sql: SQL,
  workerID: string,
  value: FactoryboxWorkerIdentity,
) {
  const identity = factoryboxWorkerIdentity.parse(value);
  const worker = await read(sql);
  const profile = factoryboxRuntimeProfile.parse(worker.profile);
  if (
    worker.id !== workerID ||
    !worker.attempted ||
    identity.storeID !== workerID.replaceAll("-", "") ||
    identity.executableSHA256 !== profile.executableSHA256 ||
    (worker.identity && !isDeepStrictEqual(worker.identity, identity))
  )
    throw new Error("Native worker identity differs from its Factory create intent");
  const updated = await sql`UPDATE factory.factorybox_worker
    SET namespace_uid=coalesce(namespace_uid,${identity.namespaceUID}),
      claim_uid=coalesce(claim_uid,${identity.claimUID}),
      pod_uid=coalesce(pod_uid,${identity.podUID}),
      identity=coalesce(identity,${JSON.stringify(identity)}::text::jsonb)
    WHERE id=${workerID}
      AND (namespace_uid IS NULL OR namespace_uid=${identity.namespaceUID})
      AND (claim_uid IS NULL OR claim_uid=${identity.claimUID})
      AND (pod_uid IS NULL OR pod_uid=${identity.podUID})`;
  if (updated.count !== 1) throw new Error("Factory worker Kubernetes identity changed");
}

export function createFactoryboxWorker(database: Database, kubernetes: KubernetesClient) {
  return {
    location: async (sql: SQL = database.client) =>
      factoryboxLocation((await factoryboxAllocation(sql)).id),
    async provision(
      resources: readonly unknown[],
      profile: FactoryboxRuntimeProfile,
      runtimeHostImage: string,
    ) {
      const declared = resources.map((value) => resource.parse(value));
      const sql = database.coordination();
      try {
        await sql`SELECT pg_advisory_lock(hashtext('factorybox-worker-create'))`;
        const worker = await bindProfile(sql, profile, runtimeHostImage);
        const bootstrapImage = worker.runtimeHostImage;
        if (!bootstrapImage) throw new Error("Factory worker bootstrap image is missing");
        // The shared Pod keeps its exact original init image and environment.
        // Consumer upgrades are exported separately after native admission.
        for (const item of declared) {
          if (item.kind !== "Pod" || item.metadata.name !== "worker") continue;
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
        const location = factoryboxLocation(worker.id);
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
        if (worker.podUID && (!pod || pod.uid !== worker.podUID))
          throw new Error("Original Factory worker disappeared or its UID changed");
        if (!pod && worker.attempted)
          throw new Error("Factory worker creation is unconfirmed; refusing another create");
        if (!pod) {
          await sql`UPDATE factory.factorybox_worker SET create_attempted=true WHERE id=${worker.id}`;
        }
        const storeKey = `PersistentVolumeClaim/store-${worker.id.replaceAll("-", "")}`;
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
            ...(pod ? { "Pod/worker": pod.uid } : {}),
          },
        });
        const sourceClaim = applied.sharedUIDs?.["PersistentVolumeClaim/runtime-data"];
        const storeClaim = applied.sharedUIDs?.[storeKey];
        if (!sourceClaim || !storeClaim)
          throw new Error("Factory shared storage create outcome is unconfirmed");
        const storagePinned = await sql`UPDATE factory.factorybox_worker
          SET source_claim_uid=coalesce(source_claim_uid,${sourceClaim}),
            claim_uid=coalesce(claim_uid,${storeClaim})
          WHERE id=${worker.id}
            AND (source_claim_uid IS NULL OR source_claim_uid=${sourceClaim})
            AND (claim_uid IS NULL OR claim_uid=${storeClaim})`;
        if (storagePinned.count !== 1) throw new Error("Factory shared storage UID changed");
        const original = pod ?? (await kubernetes.getPod(location.namespace, location.podName));
        if (!original) throw new Error("Original Factory worker create outcome is unconfirmed");
        requireRuntimePodArtifacts(original, bootstrapImage, profile.image);
        if (!Object.entries(expectedLabels).every(([key, value]) => original.labels[key] === value))
          throw new Error("Factory worker Pod ownership changed");
        const podPinned =
          await sql`UPDATE factory.factorybox_worker SET pod_uid=coalesce(pod_uid,${original.uid})
          WHERE id=${worker.id} AND (pod_uid IS NULL OR pod_uid=${original.uid})`;
        if (podPinned.count !== 1) throw new Error("Original Factory worker UID changed");
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
        };
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext('factorybox-worker-create'))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    },
  };
}
