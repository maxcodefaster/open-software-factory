import { expect, test } from "bun:test";
import { renderWorkspaceSourceResources } from "./source-manifest";
import { workspaceSourceIdentity } from "../../workspace-domain/src/source";
import {
  boundedSourceBody,
  sourceResourceListObservation,
  validateSourceObservation,
} from "./workspace-source";

test("source access mounts only canonical source, remains independent and requires exact role artifacts", () => {
  const input = {
    identity: workspaceSourceIdentity("11111111-1111-5111-8111-111111111111", 1),
    projectID: "22222222-2222-5222-8222-222222222222",
    namespace: "factory-workspace-111111111111",
    revision: "a".repeat(40),
    repositoryURL: "https://forge.invalid/project.git",
    originURL: "https://forge.invalid/project.git",
    capability: "server-only-source-capability",
    filesImage: `registry.invalid/source@sha256:${"1".repeat(64)}`,
    storageNode: "source-node",
  };
  const resources = renderWorkspaceSourceResources(input);
  const pod = resources.find((resource) => resource.kind === "Pod");
  expect(pod?.spec?.nodeSelector).toEqual({
    "kubernetes.io/os": "linux",
    "kubernetes.io/hostname": "source-node",
  });
  expect(pod?.spec?.containers?.[0]?.volumeMounts).toEqual([
    { name: "data", mountPath: "/data/home", subPath: "home" },
    { name: "assignment", mountPath: "/assignment", readOnly: true },
    { name: "temporary", mountPath: "/tmp" },
  ]);
  expect(pod?.spec?.initContainers).toEqual([]);
  expect(pod?.spec?.containers?.[0]?.securityContext.runAsUser).toBe(0);
  expect(pod?.spec?.containers?.[0]?.args).toContain("--initialize");
  expect(JSON.stringify(resources)).not.toMatch(
    /runtimeAttemptId|OpenCode|theia|privileged|hostPath|docker.sock/,
  );
  expect(() => renderWorkspaceSourceResources({ ...input, filesImage: "source:latest" })).toThrow(
    "pinned by digest",
  );
});

test("chunked source requests are bounded before dispatch, without trusting Content-Length", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array((4 << 20) + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  await expect(
    boundedSourceBody(new Request("http://factory.invalid/write", { method: "POST", body })),
  ).rejects.toThrow("4 MiB");
  expect(canceled).toBe(true);
  expect(
    await boundedSourceBody(
      new Request("http://factory.invalid/read", { method: "POST", body: '{"path":"app.ts"}' }),
    ),
  ).toEqual(new TextEncoder().encode('{"path":"app.ts"}'));
});

test("source upload cancellation releases a stalled body before dispatch", async () => {
  let canceled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const content = boundedSourceBody(
    new Request("http://factory.invalid/write", { method: "POST", body }),
    controller.signal,
  );
  controller.abort(new Error("Source upload canceled"));
  await expect(content).rejects.toThrow("Source upload canceled");
  expect(canceled).toBe(true);
});

test("ambiguous source create recovery validates storage, the complete Pod and its private assignment", () => {
  const input = {
    identity: workspaceSourceIdentity("11111111-1111-5111-8111-111111111111", 1),
    projectID: "22222222-2222-5222-8222-222222222222",
    namespace: "factory-workspace-111111111111",
    revision: "a".repeat(40),
    repositoryURL: "https://forge.invalid/project.git",
    originURL: "https://forge.invalid/project.git",
    capability: "server-only-source-capability",
    filesImage: `registry.invalid/source@sha256:${"1".repeat(64)}`,
    storageNode: "source-node",
    namespaceUID: "namespace",
    claimUID: "claim",
    podUID: "pod",
  };
  const resources = renderWorkspaceSourceResources(input);
  const pod = resources.find((item) => item.kind === "Pod");
  const claim = resources.find((item) => item.kind === "PersistentVolumeClaim");
  const secret = resources.find((item) => item.kind === "Secret");
  const namespace = resources.find((item) => item.kind === "Namespace");
  if (!pod || !claim || !secret || !namespace) throw new Error("Missing source resources");
  const observed = {
    pod: {
      ...pod,
      metadata: { ...pod.metadata, uid: "pod" },
      spec: { ...pod.spec, nodeName: "source-node" },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    },
    claim: { ...claim, metadata: { ...claim.metadata, uid: "claim" } },
    secret: {
      ...secret,
      metadata: { ...secret.metadata, uid: "secret" },
      data: Object.fromEntries(
        Object.entries(secret.stringData).map(([key, value]) => [
          key,
          Buffer.from(value).toString("base64"),
        ]),
      ),
    },
    namespace: { uid: "namespace", labels: namespace.metadata.labels },
  };
  expect(validateSourceObservation(input, observed).ready).toBe(true);
  // The authenticated stat, not Kubelet's next TCP probe, decides product readiness.
  const listening = {
    ...observed,
    pod: {
      ...observed.pod,
      status: {
        phase: "Running",
        conditions: [{ type: "Initialized", status: "True" }],
        containerStatuses: [
          { name: "source", state: { running: { startedAt: "2026-10-10T12:00:00Z" } } },
        ],
      },
    },
  };
  expect(validateSourceObservation(input, listening).ready).toBe(true);
  expect(
    validateSourceObservation(input, {
      ...listening,
      pod: { ...listening.pod, status: { ...listening.pod.status, phase: "Pending" } },
    }).ready,
  ).toBe(false);
  expect(
    validateSourceObservation(input, {
      ...listening,
      pod: {
        ...listening.pod,
        status: {
          ...listening.pod.status,
          containerStatuses: [
            {
              name: "initialize-source",
              state: { running: { startedAt: "2026-10-10T12:00:00Z" } },
            },
          ],
        },
      },
    }).ready,
  ).toBe(false);
  expect(
    validateSourceObservation(input, {
      ...listening,
      pod: { ...listening.pod, status: { ...listening.pod.status, conditions: [] } },
    }).ready,
  ).toBe(false);
  const listing = {
    items: [
      observed.pod,
      observed.claim,
      observed.secret,
      { ...namespace, metadata: { ...namespace.metadata, uid: "namespace" } },
    ],
  };
  expect(sourceResourceListObservation(input, listing)).toEqual(
    validateSourceObservation(input, observed),
  );
  expect(sourceResourceListObservation(input, { items: listing.items.slice(1) })).toBeNull();
  expect(() =>
    sourceResourceListObservation(input, { items: [...listing.items, observed.pod] }),
  ).toThrow();
  expect(() =>
    sourceResourceListObservation(input, { items: [observed.pod, observed.pod] }),
  ).toThrow("duplicate");
  expect(() =>
    sourceResourceListObservation(input, {
      items: [
        { ...observed.pod, metadata: { ...observed.pod.metadata, namespace: "another-workspace" } },
      ],
    }),
  ).toThrow("unrelated");
  expect(() =>
    sourceResourceListObservation(input, {
      items: listing.items.map((item) =>
        item.kind === "Pod"
          ? { ...item, metadata: { ...item.metadata, uid: "replacement" } }
          : item,
      ),
    }),
  ).toThrow();
  const { nodeSelector: _placement, ...firstPodSpec } = observed.pod.spec;
  expect(
    validateSourceObservation(input, { ...observed, pod: { ...observed.pod, spec: firstPodSpec } })
      .ready,
  ).toBe(true);
  for (const corrupt of [
    () => ({
      ...observed,
      secret: {
        ...observed.secret,
        data: {
          ...observed.secret.data,
          "access.json": Buffer.from("different assignment").toString("base64"),
        },
      },
    }),
    () => ({
      ...observed,
      pod: { ...observed.pod, spec: { ...observed.pod.spec, hostPID: true } },
    }),
    () => ({
      ...observed,
      pod: {
        ...observed.pod,
        spec: {
          ...observed.pod.spec,
          containers: [...observed.pod.spec.containers, observed.pod.spec.containers[0]],
        },
      },
    }),
    () => ({
      ...observed,
      pod: {
        ...observed.pod,
        spec: {
          ...observed.pod.spec,
          initContainers: [
            { name: "unapproved", image: input.filesImage, command: ["sh", "-c", "unsafe"] },
          ],
        },
      },
    }),
    () => ({
      ...observed,
      pod: { ...observed.pod, metadata: { ...observed.pod.metadata, uid: "replaced" } },
    }),
    () => ({
      ...observed,
      pod: { ...observed.pod, spec: { ...observed.pod.spec, nodeName: "another-node" } },
    }),
  ])
    expect(() => validateSourceObservation(input, corrupt())).toThrow("differs");
});
