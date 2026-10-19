import { expect, test } from "bun:test";
import { developerIDEIdentity } from "../../workspace-domain/src/developer-ide";
import { renderDeveloperIDEResources } from "./developer-ide-manifest";
import { createDeveloperIDEClient, validateDeveloperIDEObservation } from "./developer-ide";
import { createKubernetesClient } from "./client";

const input = {
  identity: developerIDEIdentity(
    "11111111-1111-4111-8111-111111111111",
    1,
    "22222222-2222-4222-8222-222222222222",
  ),
  image: `registry.invalid/ide@sha256:${"1".repeat(64)}`,
  namespaceUID: "namespace",
  podUID: "pod",
};
test("one editor identity per developer and epoch, with no Project or execution dependency", () => {
  const identity = (epoch: number) =>
    developerIDEIdentity(input.identity.userID, epoch, input.identity.resourceID);
  expect(identity(1)).toEqual(input.identity);
  expect(identity(2).namespace).toBe(input.identity.namespace);
  expect(identity(2).podName).not.toBe(input.identity.podName);
  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => identity(epoch)).toThrow();
  expect(() => developerIDEIdentity("../another-user", 1, input.identity.resourceID)).toThrow();
  expect(() => developerIDEIdentity(input.identity.userID, 1, "../another-service")).toThrow();
  const resources = renderDeveloperIDEResources(input);
  expect(JSON.stringify(resources)).not.toMatch(
    /Secret|PersistentVolumeClaim|hostPath|docker.sock|opencode|repository|token/,
  );
  expect(() => renderDeveloperIDEResources({ ...input, image: "ide:latest" })).toThrow(
    "pinned by digest",
  );
});

test("an incompatible unrecorded editor is neither adopted nor deleted; recorded outcomes remain fenced", async () => {
  const resources = renderDeveloperIDEResources(input);
  const namespace = resources.find((item) => item.kind === "Namespace");
  const expected = resources.find((item) => item.kind === "Pod");
  if (!namespace || !expected) throw new Error("Missing intended resources");
  const other = {
    ...expected,
    metadata: { ...expected.metadata, uid: "other-pod" },
    spec: {
      ...expected.spec,
      containers: [{ ...expected.spec.containers[0], image: `other@sha256:${"2".repeat(64)}` }],
    },
  };
  const kubernetes = createKubernetesClient(async (args) => {
    if (args[0] !== "get") throw new Error("Must not mutate the occupied namespace");
    return {
      stdout: JSON.stringify({
        ...namespace,
        metadata: { ...namespace.metadata, uid: "namespace" },
      }),
      stderr: "",
      exitCode: 0,
    };
  });
  const calls: string[] = [];
  const client = createDeveloperIDEClient(kubernetes, async (args) => {
    calls.push(args[0]!);
    if (args[0] !== "get") throw new Error("Must not delete the other Pod");
    return JSON.stringify(other);
  });
  try {
    const unrecorded = { ...input, podUID: null };
    await expect(client.prepare(unrecorded)).rejects.toThrow("differs from persisted intent");
    await client.stop(unrecorded);
    await expect(client.stop(input)).rejects.toThrow("differs from persisted intent");
    expect(calls).toEqual(["get", "get", "get"]);
  } finally {
    client.close();
  }
});
test("editor recovery validates exact Pod, ownership and immutable outcomes without adopting altered compute", () => {
  const resources = renderDeveloperIDEResources(input);
  const expectedPod = resources.find((item) => item.kind === "Pod");
  const expectedNamespace = resources.find((item) => item.kind === "Namespace");
  if (!expectedPod || !expectedNamespace) throw new Error("Missing editor resources");
  const namespace = { uid: "namespace", labels: expectedNamespace.metadata.labels };
  const pod = {
    ...expectedPod,
    metadata: { ...expectedPod.metadata, uid: "pod" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  };
  expect(validateDeveloperIDEObservation(input, namespace, pod)).toEqual({
    namespaceUID: "namespace",
    podUID: "pod",
    ready: true,
    failed: false,
  });
  for (const changed of [
    { ...pod, metadata: { ...pod.metadata, uid: "replacement" } },
    {
      ...pod,
      metadata: {
        ...pod.metadata,
        labels: { ...pod.metadata.labels, "factory.dev/editor-epoch": "2" },
      },
    },
    { ...pod, spec: { ...pod.spec, hostNetwork: true } },
    { ...pod, spec: { ...pod.spec, initContainers: [{ image: input.image }] } },
    {
      ...pod,
      spec: {
        ...pod.spec,
        containers: [{ ...pod.spec.containers[0], env: [{ name: "TOKEN", value: "forbidden" }] }],
      },
    },
    { ...pod, spec: { ...pod.spec, volumes: [{ name: "home", hostPath: { path: "/" } }] } },
  ])
    expect(() => validateDeveloperIDEObservation(input, namespace, changed)).toThrow("differs");
  expect(() => validateDeveloperIDEObservation(input, { ...namespace, uid: "other" }, pod)).toThrow(
    "ownership",
  );
  expect(() => validateDeveloperIDEObservation(input, { ...namespace, labels: {} }, pod)).toThrow(
    "ownership",
  );
});
