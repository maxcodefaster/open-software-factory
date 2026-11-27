// Ownership discovery, UID-preconditioned deletion, and cleanup flows for clean-room runs.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Cluster } from "./clean-room-cluster";
import {
  type CleanupState,
  chartName,
  classifyClaims,
  cleanRoomIDFromNamespace,
  cleanRoomNamespace,
  clusterObjectNames,
  disappeared,
  emptyCleanup,
  ownedClusterObjects,
  ownedRuntimeNamespaces,
  ownedVolumes,
  type Receipt,
  receiptPath,
  releaseName,
  requireCleanRoomNativeInventory,
  runtimeNamespacesNotAttributed,
  verifyOwnedNamespace,
} from "./clean-room-model";

const name = chartName(releaseName);

export type Ownership = {
  claims: { namespace: string; name: string; uid: string }[];
  runtime: { name: string; uid: string }[];
  cluster: { kind: "clusterrole" | "clusterrolebinding"; name: string; uid: string }[];
  unexpectedClaims: string[];
};

export type Items<T> = { items: T[] };
export type NamespaceItem = {
  metadata: { name: string; uid: string; labels?: Record<string, string> };
};
type ClaimItem = { metadata: { name: string; uid: string } };

// Only independent IDEs are Kubernetes Namespaces. Native execution resources
// require a separate native cleanup proof, not a Kubernetes namespace sweep.
export async function gatherOwnership(cl: Cluster, namespace: string): Promise<Ownership> {
  const listClaims = async (target: string) => {
    const found = await cl.kubectl(["-n", target, "get", "pvc", "-o", "json"], {
      allowFailure: true,
    });
    if (found.code !== 0)
      throw Error("Owned claim inventory is unavailable; installation retained");
    return (JSON.parse(found.stdout) as Items<ClaimItem>).items.map((item) => ({
      namespace: target,
      name: item.metadata.name,
      uid: item.metadata.uid,
    }));
  };
  const claims = await listClaims(namespace);
  const recorded = await cl.kubectl(
    [
      "exec",
      "-n",
      namespace,
      `${name}-postgres-0`,
      "--",
      "psql",
      "-U",
      "factory",
      "-d",
      "factory",
      "-X",
      "-At",
      "-c",
      `SELECT 'native-resources-present' WHERE EXISTS(
        SELECT 1 FROM factory.substrate_provision
        UNION ALL SELECT 1 FROM factory.operation WHERE kind='runtime.worker_capacity' AND scope_type='worker'
        UNION ALL SELECT 1 FROM factory.runtime_attempt WHERE atespace IS NOT NULL)
        UNION SELECT payload->>'namespaceUid' FROM factory.operation
          WHERE kind='workspace.developer_ide' AND scope_type='user' AND payload->>'namespaceUid' IS NOT NULL`,
    ],
    { allowFailure: true },
  );
  const uids = requireCleanRoomNativeInventory(recorded);
  const namespaces = uids.size
    ? ((await cl.json(["get", "namespaces"])) as Items<NamespaceItem>)
    : { items: [] };
  const runtime = uids.size ? ownedRuntimeNamespaces(namespaces.items, uids) : [];
  for (const item of runtime) claims.push(...(await listClaims(item.name)));
  const id = cleanRoomIDFromNamespace(namespace);
  if (!id) throw Error("Owned clean-room Namespace is missing");
  const names = clusterObjectNames(id, releaseName);
  const clusterObjects: Ownership["cluster"] = [];
  for (const [kind, expected] of [
    ["clusterrole", names.clusterRoles],
    ["clusterrolebinding", names.clusterRoleBindings],
  ] as const) {
    const listed = (await cl.json(["get", kind])) as Items<NamespaceItem>;
    for (const objectName of ownedClusterObjects(listed.items, expected, releaseName)) {
      const item = listed.items.find((entry) => entry.metadata.name === objectName);
      if (!item?.metadata.uid)
        throw Error("Owned cluster object UID is unavailable; installation retained");
      clusterObjects.push({ kind, name: objectName, uid: item.metadata.uid });
    }
  }
  return {
    claims,
    runtime,
    cluster: clusterObjects,
    unexpectedClaims: classifyClaims(
      claims.filter((claim) => claim.namespace === namespace).map((claim) => claim.name),
      releaseName,
    ).unexpected,
  };
}

// Removes one run's resources and nothing else. The Namespace is only deleted after its name,
// owner label and managed-by label match; every deletion requires the original resource UID.
export async function removeRun(
  cl: Cluster,
  id: string,
  ownership: Ownership,
  namespaceUID: string,
): Promise<CleanupState> {
  if (!namespaceUID)
    throw Error("Original clean-room Namespace UID is unavailable; nothing deleted");
  if (ownership.unexpectedClaims.length)
    throw Error("Unexpected claims are present in the owned Namespace; nothing deleted");
  const namespace = cleanRoomNamespace(id);
  const state = emptyCleanup();
  const remove = async (label: string, path: string, uid: string) => {
    if (!uid) throw Error("Original cleanup resource UID is unavailable; nothing deleted");
    const result = await cl.kubectl(["delete", "--raw", path, "-f", "-"], {
      input: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid } }),
      allowFailure: true,
    });
    if (result.code === 0) state.deleted.push(label);
    else state.errors.push(`${label}: deletion outcome is unconfirmed`);
    return result.code === 0;
  };
  const found = await cl.kubectl(["get", "namespace", namespace, "-o", "json"], {
    allowFailure: true,
  });
  if (found.code !== 0)
    throw Error("Original Namespace observation is unavailable; nothing deleted");
  // Namespace GC removes its own release, claims and Secrets. Do not first
  // uninstall Helm by name: a same-name replacement could otherwise be harmed
  // before the UID-preconditioned Namespace deletion rejects it.
  verifyOwnedNamespace(JSON.parse(found.stdout), id, namespaceUID);
  for (const item of ownership.runtime) {
    const current = await cl.kubectl(["get", "namespace", item.name, "-o", "json"], {
      allowFailure: true,
    });
    if (current.code !== 0) throw Error("Original editor Namespace observation is unavailable");
    const parsed = JSON.parse(current.stdout) as NamespaceItem;
    if (
      parsed.metadata.uid !== item.uid ||
      parsed.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory"
    ) {
      state.errors.push(`${item.name} changed identity since it was attributed; left in place`);
      state.state = "failed";
      return state;
    }
    if (!(await remove(`namespace/${item.name}`, `/api/v1/namespaces/${item.name}`, item.uid)))
      throw Error("Original editor Namespace deletion is unconfirmed");
    await cl.kubectl(["wait", "--for=delete", `namespace/${item.name}`, "--timeout=10m"]);
  }
  verifyOwnedNamespace(await cl.json(["get", "namespace", namespace]), id, namespaceUID);
  if (!(await remove(`namespace/${namespace}`, `/api/v1/namespaces/${namespace}`, namespaceUID)))
    throw Error(
      "Original clean-room Namespace deletion is unconfirmed; no replacement was deleted",
    );
  await cl.kubectl(["wait", "--for=delete", `namespace/${namespace}`, "--timeout=10m"]);

  const owned = [namespace, ...ownership.runtime.map((item) => item.name)];
  const claimUIDs = new Set(ownership.claims.map((claim) => claim.uid));
  const volumes = (await cl.json(["get", "pv"])) as Items<{
    metadata: { name: string; uid: string };
    spec?: { claimRef?: { namespace?: string; uid?: string } };
  }>;
  for (const volume of volumes.items) {
    if (!ownedVolumes([volume], owned, claimUIDs).length) continue;
    if (
      !(await remove(
        `pv/${volume.metadata.name}`,
        `/api/v1/persistentvolumes/${volume.metadata.name}`,
        volume.metadata.uid,
      ))
    )
      throw Error("Original owned PV deletion is unconfirmed");
    await cl.kubectl(["wait", "--for=delete", `pv/${volume.metadata.name}`, "--timeout=2m"]);
  }
  for (const item of ownership.cluster) {
    const plural = item.kind === "clusterrole" ? "clusterroles" : "clusterrolebindings";
    await remove(
      `${item.kind}/${item.name}`,
      `/apis/rbac.authorization.k8s.io/v1/${plural}/${item.name}`,
      item.uid,
    );
  }

  // Verify rather than assume.
  const namespaceInventory = (await cl.json(["get", "namespaces"])) as Items<NamespaceItem>;
  for (const target of owned)
    if (namespaceInventory.items.some((item) => item.metadata.name === target))
      state.remaining.push(`namespace/${target}`);
  const after = (await cl.json(["get", "pv"])) as Items<never>;
  for (const volume of after.items)
    for (const leftover of ownedVolumes([volume], owned, claimUIDs))
      state.remaining.push(`pv/${leftover}`);
  const names = clusterObjectNames(id, releaseName);
  for (const [kind, expected] of [
    ["clusterrole", names.clusterRoles],
    ["clusterrolebinding", names.clusterRoleBindings],
  ] as const) {
    const listed = (await cl.json(["get", kind])) as Items<NamespaceItem>;
    for (const item of ownedClusterObjects(listed.items, expected, releaseName))
      state.remaining.push(`${kind}/${item}`);
  }
  state.state = state.errors.length || state.remaining.length ? "failed" : "removed";
  return state;
}

export async function runCleanupCommand(input: {
  cl: Cluster;
  namespace: string;
  context: string;
  root: string;
  log: (message: string) => void;
}) {
  const { cl, namespace, context, root, log } = input;
  const id = cleanRoomIDFromNamespace(namespace) ?? "";
  const file = resolve(root, receiptPath(namespace));
  const previous = await readFile(file, "utf8").then(
    (text) => JSON.parse(text) as Record<string, unknown>,
    () => null,
  );
  const namespaceUID = previous?.["namespaceUID"];
  if (
    typeof namespaceUID !== "string" ||
    !namespaceUID ||
    previous?.["context"] !== context ||
    previous?.["namespace"] !== namespace
  )
    throw Error("Original clean-room Namespace UID/context is unavailable; nothing deleted");
  verifyOwnedNamespace(await cl.json(["get", "namespace", namespace]), id, namespaceUID);
  const ownership = await gatherOwnership(cl, namespace);
  const cleanup = await removeRun(cl, id, ownership, namespaceUID);
  log(`${cleanup.state}: deleted ${cleanup.deleted.join(", ") || "nothing"}`);
  await writeFile(
    file,
    `${JSON.stringify({ ...(previous ?? { schema: 1, id, namespace }), cleanupRerun: cleanup }, null, 2)}\n`,
  );
  return cleanup.state === "removed" ? 0 : 1;
}

export async function finalizeRunCleanup(input: {
  cl: Cluster;
  id: string;
  namespace: string;
  context: string;
  origin: string;
  keep: boolean;
  created: boolean;
  receipt: Receipt;
  beforeNamespaces: string[];
  beforeRuntime: string[];
  log: (message: string) => void;
}) {
  const {
    cl,
    id,
    namespace,
    context,
    origin,
    keep,
    created,
    receipt,
    beforeNamespaces,
    beforeRuntime,
    log,
  } = input;
  if (created && keep) {
    receipt.cleanup.state = "kept";
    log(
      `--keep: ${namespace} stays at ${origin}. Native inventory is retained.\nCleanup may be requested with: mise exec -- bun run release:clean-room --cleanup ${namespace} --context ${context}`,
    );
    return;
  }
  if (!created) return;
  try {
    if (!receipt.namespaceUID)
      throw Error("Original Namespace create outcome is unconfirmed; nothing deleted");
    verifyOwnedNamespace(await cl.json(["get", "namespace", namespace]), id, receipt.namespaceUID);
    const ownership = await gatherOwnership(cl, namespace);
    const done = await removeRun(cl, id, ownership, receipt.namespaceUID);
    const after = (await cl.json(["get", "namespaces"]).catch(() => ({
      items: [],
    }))) as Items<NamespaceItem>;
    receipt.cleanup = {
      ...done,
      unexpectedClaims: ownership.unexpectedClaims,
      unattributedRuntimeNamespaces: runtimeNamespacesNotAttributed(
        beforeRuntime,
        after.items,
        ownership.runtime.map((item) => item.name),
      ),
      disappeared: disappeared(
        beforeNamespaces,
        after.items.map((item) => item.metadata.name),
        done.deleted.filter((item) => item.startsWith("namespace/")).map((item) => item.slice(10)),
      ),
    };
    log(`Cleanup ${done.state}: deleted ${done.deleted.join(", ") || "nothing"}`);
  } catch (cause) {
    receipt.cleanup.state = "failed";
    receipt.cleanup.errors.push(cause instanceof Error ? cause.message : String(cause));
    log(`Cleanup refused: ${receipt.cleanup.errors.at(-1)}`);
  }
}
