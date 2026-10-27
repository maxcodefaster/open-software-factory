import { expect, test } from "bun:test";
import { factoryboxSharedLabels } from "../../packages/runtime-kubernetes/src/factorybox-location";
import { removeOwnedProjectSources } from "../fixtures/editor-source-resources";
import { requireFixtureWorkerCleanup } from "../fixtures/factorybox-cleanup";
import { ownedFactoryboxLocation } from "../fixtures/runtime-configuration";

test("whole-fixture cleanup refuses live Source resources and replacements instead of deleting a Project namespace", () => {
  const { workerID, namespace: name } = ownedFactoryboxLocation;
  const labels = factoryboxSharedLabels(workerID);
  const worker = {
    id: workerID,
    namespaceUID: "namespace-uid",
    sourceClaimUID: "source-claim-uid",
    claimUID: "store-claim-uid",
    podUID: "worker-pod-uid",
  };
  const namespace = {
    kind: "Namespace",
    metadata: { name, uid: worker.namespaceUID, labels },
  };
  const resources = {
    items: [
      { kind: "Pod", metadata: { name: "worker", uid: worker.podUID, labels } },
      {
        kind: "PersistentVolumeClaim",
        metadata: { name: "runtime-data", uid: worker.sourceClaimUID, labels },
      },
    ],
  };
  expect(requireFixtureWorkerCleanup(worker, namespace, resources).worker.id).toBe(worker.id);
  expect(() =>
    requireFixtureWorkerCleanup(
      worker,
      { ...namespace, metadata: { ...namespace.metadata, uid: "replacement" } },
      resources,
    ),
  ).toThrow();
  for (const extra of [
    { kind: "Pod", metadata: { name: "worker", uid: "replacement", labels } },
    { kind: "Pod", metadata: { name: "source-epoch", uid: "source-pod", labels } },
    { kind: "Secret", metadata: { name: "assignment-used", uid: "assignment", labels } },
    { kind: "PersistentVolumeClaim", metadata: { name: "foreign", uid: "claim", labels } },
    { kind: "Secret", metadata: { name: "registry-ca", uid: "ca", labels: {} } },
  ])
    expect(() =>
      requireFixtureWorkerCleanup(worker, namespace, { items: [...resources.items, extra] }),
    ).toThrow();
});

test("Project cleanup stops only its Source epochs and leaves the shared worker namespace alone", async () => {
  const { workerID, namespace } = ownedFactoryboxLocation;
  const first = {
    id: crypto.randomUUID(),
    state: "ready",
    namespace,
    workerID,
    namespaceUID: "namespace-uid",
  };
  const sources = [first, { ...first, id: crypto.randomUUID(), state: "stopped" }];
  const stopped: string[] = [];
  const queries: string[] = [];
  const sql = async (parts: TemplateStringsArray) => {
    queries.push(parts.join("?"));
    return parts.join("").includes("development_workspace") ? sources : [{ state: "stopped" }];
  };
  const database = { client: sql } as unknown as Parameters<typeof removeOwnedProjectSources>[0];
  const projectID = crypto.randomUUID();
  await removeOwnedProjectSources(database, projectID, async (id) => {
    stopped.push(id);
  });
  expect(stopped).toEqual([first.id]);
  expect(queries.every((query) => query.trimStart().startsWith("SELECT"))).toBe(true);
  first.namespace = "foreign-project-namespace";
  await expect(
    removeOwnedProjectSources(database, projectID, async () => {
      throw new Error("must not stop a mismatched Source");
    }),
  ).rejects.toThrow("recorded Factory worker");
});
