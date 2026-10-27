import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  factoryboxLocation,
  factoryboxSharedLabels,
} from "../../packages/runtime-kubernetes/src/factorybox-location";
import { editorFixtureKubectl } from "./editor-source-resources";
import { eventually, type factoryProcess } from "./factory-process";

const workerSchema = z.object({
  id: z.uuid(),
  namespaceUID: z.string().min(1),
  sourceClaimUID: z.string().min(1).nullable(),
  claimUID: z.string().min(1).nullable(),
  podUID: z.string().min(1).nullable(),
});
const objectSchema = z.object({
  kind: z.string(),
  metadata: z.object({
    name: z.string(),
    uid: z.string().min(1),
    labels: z.record(z.string(), z.string()).default({}),
  }),
});

export function requireFixtureWorkerCleanup(
  workerValue: unknown,
  namespaceValue: unknown,
  resourcesValue: unknown,
) {
  const worker = workerSchema.parse(workerValue);
  const location = factoryboxLocation(worker.id);
  const namespace = objectSchema.parse(namespaceValue);
  const shared = factoryboxSharedLabels(worker.id);
  const owned = (labels: Readonly<Record<string, string>>) =>
    Object.entries(shared).every(([key, value]) => labels[key] === value);
  if (
    namespace.kind !== "Namespace" ||
    namespace.metadata.name !== location.namespace ||
    namespace.metadata.uid !== worker.namespaceUID ||
    !owned(namespace.metadata.labels)
  )
    throw new Error("Fixture cannot remove a changed or unowned shared Factorybox namespace");
  const resources = z.object({ items: z.array(objectSchema) }).parse(resourcesValue).items;
  for (const resource of resources) {
    const { kind, metadata } = resource;
    const key = `${kind}/${metadata.name}`;
    if (key === "ConfigMap/kube-root-ca.crt" || key === "ServiceAccount/default") continue;
    const expectedUID =
      key === "Pod/worker"
        ? worker.podUID
        : key === "PersistentVolumeClaim/runtime-data"
          ? worker.sourceClaimUID
          : key === `PersistentVolumeClaim/store-${worker.id.replaceAll("-", "")}`
            ? worker.claimUID
            : key === "Secret/registry-ca"
              ? metadata.uid
              : null;
    if (!expectedUID || metadata.uid !== expectedUID || !owned(metadata.labels))
      throw new Error(
        "Fixture retains a live owner, replacement UID or unexpected shared resource",
      );
  }
  return { worker, namespace: namespace.metadata, resources };
}

// Only an owned factoryProcess is accepted. Individual Source/Attempt cleanup
// must never delete the shared worker, claim or another Project's checkout.
export async function removeOwnedFactoryboxFixture(
  fixture: Awaited<ReturnType<typeof factoryProcess>>,
  artifacts: string,
) {
  await fixture.shutdown();
  const database = fixture.connect();
  try {
    const [unfinished] = await database.client<Array<{ count: number }>>`
      SELECT (
        (SELECT count(*) FROM factory.runtime_attempt WHERE state NOT IN ('stopped','failed')) +
        (SELECT count(*) FROM factory.factorybox_runtime WHERE inputs_released_at IS NULL) +
        (SELECT count(*) FROM factory.execution_slot WHERE state<>'deleted') +
        (SELECT count(*) FROM factory.workspace_source WHERE state<>'stopped') +
        (SELECT count(*) FROM factory.factorybox_lifecycle_operation
          WHERE attempted_at IS NOT NULL AND completed_at IS NULL)
      )::int AS count`;
    if (unfinished?.count !== 0)
      throw new Error("Fixture teardown retains unsettled Sandbox, Source or lifecycle ownership");
    const [worker] = await database.client<
      Array<{
        id: string;
        namespaceUID: string | null;
        sourceClaimUID: string | null;
        claimUID: string | null;
        podUID: string | null;
      }>
    >`SELECT id,namespace_uid AS "namespaceUID",
      source_claim_uid AS "sourceClaimUID",claim_uid AS "claimUID",pod_uid AS "podUID"
      FROM factory.factorybox_worker WHERE singleton`;
    if (!worker?.namespaceUID) return;
    const location = factoryboxLocation(worker.id);
    const readNamespace = async () => {
      const raw = await editorFixtureKubectl([
        "get",
        "namespace",
        location.namespace,
        "--ignore-not-found",
        "-o",
        "json",
      ]);
      return raw.trim() ? JSON.parse(raw) : null;
    };
    const namespace = await readNamespace();
    if (!namespace) return;
    const checked = requireFixtureWorkerCleanup(
      worker,
      namespace,
      JSON.parse(
        await editorFixtureKubectl([
          "get",
          "all,pvc,secret,configmap,serviceaccounts,networkpolicies",
          "-n",
          location.namespace,
          "-o",
          "json",
        ]),
      ),
    );
    await mkdir(artifacts, { recursive: true });
    const deletion = {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: checked.namespace.uid },
      propagationPolicy: "Foreground",
    };
    await writeFile(
      resolve(artifacts, "shared-worker-cleanup-intent.json"),
      `${JSON.stringify({ factoryID: fixture.id, ...checked, deletion }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    let response: "confirmed" | "unconfirmed" = "confirmed";
    try {
      await editorFixtureKubectl(
        ["delete", "--raw", `/api/v1/namespaces/${location.namespace}`, "-f", "-"],
        deletion,
        60_000,
      );
    } catch {
      response = "unconfirmed";
    }
    // Do not replay an uncertain Delete or remove Namespace finalizers.
    await eventually(
      async () => {
        const remaining = await readNamespace();
        if (remaining && remaining.metadata?.uid !== checked.namespace.uid)
          throw new Error("Fixture namespace was replaced during teardown");
        return remaining;
      },
      (value) => value === null,
      "Owned shared worker namespace deletion remains unconfirmed",
      120_000,
    );
    await writeFile(
      resolve(artifacts, "shared-worker-cleanup.json"),
      `${JSON.stringify({ factoryID: fixture.id, namespace: checked.namespace, response, absenceConfirmed: true })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    await database.client.end({ timeout: 2 });
  }
}
