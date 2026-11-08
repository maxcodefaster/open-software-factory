import { expect, test } from "bun:test";
import { fixtureValue } from "../../../test/fixtures/value";
import { developerIDEIdentity } from "../../workspace-domain/src/developer-ide";
import { createKubernetesClient } from "./client";
import { createDeveloperIDEClient, validateDeveloperIDEObservation } from "./developer-ide";
import { renderDeveloperIDEResources } from "./developer-ide-manifest";

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

function forwardingFixture() {
  const intended = renderDeveloperIDEResources(input);
  const namespace = fixtureValue(
    intended.find((item) => item.kind === "Namespace"),
    "namespace",
  );
  const pod = fixtureValue(
    intended.find((item) => item.kind === "Pod"),
    "pod",
  );
  const observation = JSON.stringify({
    ...pod,
    metadata: { ...pod.metadata, uid: input.podUID },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  });
  const inventory = Promise.withResolvers<string | null>();
  const validating = Promise.withResolvers<void>();
  const opened: Array<{
    ready: ReturnType<typeof Promise.withResolvers<string>>;
    exit: ReturnType<typeof Promise.withResolvers<number>>;
    cancel: AbortController;
    kills: number;
  }> = [];
  const waiters = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<(typeof opened)[number]>>
  >();
  let reads = 0;
  let deferInventory = true;
  let readyAutomatically = false;
  let absent = false;
  const kubernetes = createKubernetesClient(async () => ({
    stdout: JSON.stringify({
      ...namespace,
      metadata: { ...namespace.metadata, uid: input.namespaceUID },
    }),
    stderr: "",
    exitCode: 0,
  }));
  const client = createDeveloperIDEClient(
    kubernetes,
    async (args) => {
      if (args[0] === "delete") return "";
      reads++;
      validating.resolve();
      if (absent) return null;
      return deferInventory ? inventory.promise : observation;
    },
    () => {
      const connection = {
        ready: Promise.withResolvers<string>(),
        exit: Promise.withResolvers<number>(),
        cancel: new AbortController(),
        kills: 0,
      };
      opened.push(connection);
      waiters.get(opened.length - 1)?.resolve(connection);
      if (readyAutomatically) connection.ready.resolve("http://127.0.0.1:4400");
      return {
        endpoint: connection.ready.promise,
        cancel: connection.cancel,
        child: {
          exited: connection.exit.promise,
          kill() {
            connection.kills++;
          },
        },
      };
    },
  );
  return {
    client,
    opened,
    validating: validating.promise,
    reads: () => reads,
    recordAbsence() {
      absent = true;
    },
    recordPresence() {
      absent = false;
    },
    waitForForward(index: number) {
      const connection = opened[index];
      if (connection) return Promise.resolve(connection);
      const waiter = Promise.withResolvers<(typeof opened)[number]>();
      waiters.set(index, waiter);
      return waiter.promise;
    },
    releaseInventory() {
      deferInventory = false;
      inventory.resolve(observation);
    },
    readyAutomatically() {
      readyAutomatically = true;
    },
    readyAll() {
      for (const connection of opened) connection.ready.resolve("http://127.0.0.1:4400");
    },
  };
}

test("concurrent editor endpoints share validation and one opening forward", async () => {
  const f = forwardingFixture();
  const first = f.client.endpoint(input);
  const second = f.client.endpoint(input);
  try {
    await f.validating;
    f.releaseInventory();
    await f.waitForForward(0);
    f.readyAll();
    expect(await Promise.all([first, second])).toEqual([
      "http://127.0.0.1:4400",
      "http://127.0.0.1:4400",
    ]);
    expect(f.reads()).toBe(1);
    expect(f.opened).toHaveLength(1);
  } finally {
    f.client.close();
  }
});

test.each(["close", "stop"] as const)(
  "editor %s invalidates validation without opening a late forward",
  async (action) => {
    const f = forwardingFixture();
    const pending = f.client.endpoint(input).then(
      () => "connected",
      () => "closed",
    );
    try {
      await f.validating;
      if (action === "close") f.client.close();
      else {
        f.recordAbsence();
        await f.client.stop(input);
      }
      f.readyAutomatically();
      f.releaseInventory();
      expect(await pending).toBe("closed");
      await f.client.observe(input);
      expect(f.opened).toHaveLength(0);
    } finally {
      f.client.close();
    }
  },
);

test.each(["close", "stop"] as const)(
  "editor %s owns a pending forward and its late exit cannot remove a reconnection",
  async (action) => {
    const f = forwardingFixture();
    f.releaseInventory();
    const pending = f.client.endpoint(input).then(
      () => "connected",
      () => "closed",
    );
    try {
      const old = await f.waitForForward(0);
      if (action === "close") f.client.close();
      else {
        f.recordAbsence();
        await f.client.stop(input);
        f.recordPresence();
      }
      expect(old.kills).toBe(1);
      expect(old.cancel.signal.aborted).toBe(true);
      expect(await pending).toBe("closed");
      old.ready.resolve("http://127.0.0.1:4400");
      const reconnect = f.client.endpoint(input);
      const current = await f.waitForForward(1);
      current.ready.resolve("http://127.0.0.1:4400");
      await reconnect;
      old.exit.resolve(0);
      await Promise.resolve();
      await f.client.endpoint(input);
      expect(f.opened).toHaveLength(2);
      expect(current.kills).toBe(0);
      expect(old.kills).toBe(1);
    } finally {
      f.client.close();
    }
  },
);

test("editor readiness failure cleans its own forward and allows a fresh validation", async () => {
  const f = forwardingFixture();
  f.releaseInventory();
  const pending = f.client.endpoint(input);
  try {
    const old = await f.waitForForward(0);
    old.ready.reject(new Error("Developer IDE connection exceeded its deadline"));
    await expect(pending).rejects.toThrow("Developer IDE connection exceeded its deadline");
    expect(old.kills).toBe(1);
    expect(old.cancel.signal.aborted).toBe(true);
    const retry = f.client.endpoint(input);
    const current = await f.waitForForward(1);
    current.ready.resolve("http://127.0.0.1:4400");
    await retry;
    expect(f.reads()).toBe(2);
  } finally {
    f.client.close();
  }
});

test("editor child exit reconnects through a new validated forward", async () => {
  const f = forwardingFixture();
  f.releaseInventory();
  try {
    const first = f.client.endpoint(input);
    const old = await f.waitForForward(0);
    old.ready.resolve("http://127.0.0.1:4400");
    await first;
    old.exit.resolve(0);
    await Promise.resolve();
    expect(old.cancel.signal.aborted).toBe(true);
    expect(old.kills).toBe(0);
    const retry = f.client.endpoint(input);
    const current = await f.waitForForward(1);
    current.ready.resolve("http://127.0.0.1:4400");
    await retry;
    expect(f.reads()).toBe(2);
    expect(current.kills).toBe(0);
  } finally {
    f.client.close();
  }
});

test.each(["namespaceUID", "podUID", "image"] as const)(
  "a retained editor forward cannot bypass a changed %s",
  async (field) => {
    const f = forwardingFixture();
    f.releaseInventory();
    try {
      const first = f.client.endpoint(input);
      const current = await f.waitForForward(0);
      current.ready.resolve("http://127.0.0.1:4400");
      await first;
      const changed =
        field === "image" ? `registry.invalid/ide@sha256:${"2".repeat(64)}` : "changed";
      await expect(f.client.endpoint({ ...input, [field]: changed })).rejects.toThrow("differs");
      expect(f.reads()).toBe(2);
      expect(f.opened).toHaveLength(1);
      expect(current.kills).toBe(0);
      await f.client.endpoint(input);
      expect(f.reads()).toBe(2);
    } finally {
      f.client.close();
    }
  },
);

test("stopping one editor generation preserves another generation's owned forward", async () => {
  const next = {
    ...input,
    identity: developerIDEIdentity(input.identity.userID, 2, input.identity.resourceID),
    podUID: "next-pod",
  };
  const namespace = fixtureValue(
    renderDeveloperIDEResources(input).find((item) => item.kind === "Namespace"),
    "namespace",
  );
  const pods = new Map(
    [input, next].map((request) => {
      const pod = fixtureValue(
        renderDeveloperIDEResources(request).find((item) => item.kind === "Pod"),
        "pod",
      );
      return [
        request.identity.podName,
        {
          ...pod,
          metadata: { ...pod.metadata, uid: request.podUID },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
        },
      ] as const;
    }),
  );
  const opened: Array<{ podName: string; cancel: AbortController; kills: number }> = [];
  const client = createDeveloperIDEClient(
    createKubernetesClient(async () => ({
      stdout: JSON.stringify({
        ...namespace,
        metadata: { ...namespace.metadata, uid: input.namespaceUID },
      }),
      stderr: "",
      exitCode: 0,
    })),
    async (args, body) => {
      if (args[0] === "delete") {
        expect((body as { preconditions: { uid: string } }).preconditions.uid).toBe(input.podUID);
        pods.delete(input.identity.podName);
        return "";
      }
      const pod = pods.get(args[2] ?? "");
      return pod ? JSON.stringify(pod) : null;
    },
    (_role, _namespace, podName) => {
      const owned = { podName, cancel: new AbortController(), kills: 0 };
      opened.push(owned);
      return {
        endpoint: Promise.resolve("http://127.0.0.1:4400"),
        cancel: owned.cancel,
        child: {
          exited: Promise.withResolvers<number>().promise,
          kill() {
            owned.kills++;
          },
        },
      };
    },
  );
  try {
    await Promise.all([client.endpoint(input), client.endpoint(next)]);
    await client.stop(input);
    expect(opened[0]?.kills).toBe(1);
    expect(opened[0]?.cancel.signal.aborted).toBe(true);
    expect(opened[1]?.kills).toBe(0);
    expect(opened[1]?.cancel.signal.aborted).toBe(false);
    await client.endpoint(next);
    expect(opened).toHaveLength(2);
    expect(pods.has(next.identity.podName)).toBe(true);
  } finally {
    client.close();
  }
});
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
  expect(
    resources.find((resource) => resource.kind === "Pod")?.spec.containers[0]?.resources,
  ).toEqual({
    requests: { cpu: "50m", memory: "256Mi" },
    limits: { cpu: "1", memory: "768Mi" },
  });
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
    calls.push(fixtureValue(args[0], "args[0]"));
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
