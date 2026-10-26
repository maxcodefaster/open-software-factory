import { expect, test } from "bun:test";
import { workspaceSourceIdentity } from "../../workspace-domain/src/source";
import { createKubernetesClient } from "./client";
import { renderWorkspaceSourceResources } from "./source-manifest";
import {
  confirmSourceRoot,
  createWorkspaceSourceClient,
  type SourceResources,
} from "./workspace-source";

const input: SourceResources = {
  identity: workspaceSourceIdentity("11111111-1111-5111-8111-111111111111", 1),
  projectID: "22222222-2222-5222-8222-222222222222",
  namespace: "factory-source-client-test",
  revision: "a".repeat(40),
  repositoryURL: "https://forge.invalid/project.git",
  originURL: "https://forge.invalid/project.git",
  capability: "test-only-capability",
  filesImage: `registry.invalid/source@sha256:${"1".repeat(64)}`,
  storageNode: "source-node",
  sourceDirectory: "workspaces/11111111111151118111111111111111/home",
  namespaceUID: "namespace-uid",
  claimUID: "claim-uid",
  podUID: "pod-uid",
};

function resources(request: SourceResources = input) {
  return renderWorkspaceSourceResources(request).map((resource) => ({
    ...resource,
    metadata: {
      ...resource.metadata,
      uid:
        resource.kind === "Namespace"
          ? "namespace-uid"
          : resource.kind === "PersistentVolumeClaim"
            ? "claim-uid"
            : resource.kind === "Pod"
              ? (request.podUID ?? "pod-uid")
              : "secret-uid",
    },
    ...(resource.kind === "Pod"
      ? {
          spec: { ...resource.spec, nodeName: "source-node" },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
        }
      : {}),
    ...(resource.kind === "Secret"
      ? {
          data: Object.fromEntries(
            Object.entries(resource.stringData).map(([key, value]) => [
              key,
              Buffer.from(value).toString("base64"),
            ]),
          ),
        }
      : {}),
  }));
}

test("stopping one Source epoch preserves another validated connection in the same namespace", async () => {
  const next: SourceResources = {
    ...input,
    identity: workspaceSourceIdentity(input.identity.workspaceID, 2),
    podUID: "next-pod-uid",
    capability: "test-only-next-capability",
  };
  const inventory = new Map(
    [input, next].flatMap((request) =>
      resources(request).map(
        (resource) => [`${resource.kind}:${resource.metadata.name}`, resource] as const,
      ),
    ),
  );
  const opened: Array<{
    podName: string;
    cancel: AbortController;
    kills: number;
  }> = [];
  const client = createWorkspaceSourceClient(
    createKubernetesClient(),
    async (args) => {
      if (args[0] === "delete") {
        const path = args[2] ?? "";
        const [plural, name] = path.split("/").slice(-2);
        const kind = plural === "pods" ? "Pod" : "Secret";
        inventory.delete(`${kind}:${name}`);
        return "{}";
      }
      if (args[1]?.startsWith("pod/")) {
        const request = args[1] === `pod/${input.identity.podName}` ? input : next;
        return JSON.stringify({
          items: resources(request).filter((resource) =>
            inventory.has(`${resource.kind}:${resource.metadata.name}`),
          ),
        });
      }
      const kind = args[1] === "pods" ? "Pod" : "Secret";
      const resource = inventory.get(`${kind}:${args[2]}`);
      return resource ? JSON.stringify(resource) : null;
    },
    Object.assign(
      async (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        expect(options?.signal?.aborted).toBe(false);
        return Response.json({ kind: "directory" });
      },
      { preconnect: fetch.preconnect },
    ),
    (_role, _namespace, podName) => {
      const exit = Promise.withResolvers<number>();
      const connection = { podName, cancel: new AbortController(), kills: 0 };
      opened.push(connection);
      return {
        endpoint: Promise.resolve("http://127.0.0.1:4600"),
        cancel: connection.cancel,
        child: {
          exited: exit.promise,
          kill() {
            connection.kills++;
            exit.resolve(0);
          },
        },
      };
    },
  );
  try {
    await client.connect(input);
    await client.connect(next);
    expect(opened).toHaveLength(2);
    await client.stop(input);
    expect(opened[0]?.cancel.signal.aborted).toBe(true);
    expect(opened[0]?.kills).toBe(1);
    expect(opened[1]?.cancel.signal.aborted).toBe(false);
    expect(opened[1]?.kills).toBe(0);
    await client.request(
      next,
      "stat",
      new Request("http://factory.invalid/stat", { method: "POST", body: '{"path":""}' }),
      new AbortController().signal,
    );
    expect(opened).toHaveLength(2);
    expect(inventory.has(`Pod:${next.identity.podName}`)).toBe(true);
    expect(inventory.has(`Secret:${next.identity.secretName}`)).toBe(true);
  } finally {
    client.close();
  }
});

test.each(["Succeeded", "Failed"])(
  "a terminal %s source daemon requires explicit recovery instead of endless preparation",
  async (phase) => {
    const observed = resources().map((resource) =>
      resource.kind === "Pod"
        ? { ...resource, status: { phase, conditions: [{ type: "Ready", status: "False" }] } }
        : resource,
    );
    const client = createWorkspaceSourceClient(createKubernetesClient(), async () =>
      JSON.stringify({ items: observed }),
    );
    try {
      expect(await client.observe(input)).toMatchObject({
        ready: false,
        failed: true,
        podUID: input.podUID,
        claimUID: input.claimUID,
      });
    } finally {
      client.close();
    }
  },
);

test("prepared source uses its fully validated observation without reading assignment twice", async () => {
  const observed = resources();
  const calls: string[][] = [];
  const kubernetes = createKubernetesClient(async (args) => {
    throw new Error(`Prepared source should not issue another ${args[0]}`);
  });
  const client = createWorkspaceSourceClient(kubernetes, async (args) => {
    calls.push(args);
    return args[1] === "secret"
      ? JSON.stringify(observed.find((resource) => resource.kind === "Secret"))
      : JSON.stringify({ items: observed });
  });
  expect(await client.prepare(input)).toEqual({
    namespaceUID: "namespace-uid",
    claimUID: "claim-uid",
    podUID: "pod-uid",
    storageNode: "source-node",
    ready: true,
    failed: false,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(`secret/${input.identity.secretName}`);
  client.close();
});

test("partial create still rejects a conflicting persisted assignment before applying anything", async () => {
  const observed = resources();
  const kubernetes = createKubernetesClient(async (args) => {
    throw new Error(`Conflicting source should not issue ${args[0]}`);
  });
  const secret = observed.find((resource) => resource.kind === "Secret");
  if (!secret) throw new Error("Test assignment missing");
  const conflicting = {
    ...secret,
    data: { "access.json": Buffer.from("wrong").toString("base64") },
  };
  const calls: string[][] = [];
  const client = createWorkspaceSourceClient(kubernetes, async (args) => {
    calls.push(args);
    return args[1] === "secret"
      ? JSON.stringify(conflicting)
      : JSON.stringify({ items: [observed[0], conflicting] });
  });
  await expect(client.prepare(input)).rejects.toThrow("capability differs");
  expect(calls).toHaveLength(1);
  client.close();
});

test("fresh source uses one inventory then guarded apply and outcome observation", async () => {
  const observed = resources();
  const calls: string[][] = [];
  const writes: string[][] = [];
  const fresh = { ...input, namespaceUID: null, claimUID: null, podUID: null };
  const kubernetes = createKubernetesClient(async (args, body) => {
    writes.push(args);
    if (args[0] === "get") return { stdout: "", stderr: "NotFound", exitCode: 1 };
    if (args[0] === "create") {
      expect(JSON.parse(body ?? "{}").kind).toBe("Namespace");
      return { stdout: JSON.stringify(observed[0]), stderr: "", exitCode: 0 };
    }
    expect(args[0]).toBe("apply");
    expect(JSON.parse(body ?? "{}").items).toHaveLength(3);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const client = createWorkspaceSourceClient(kubernetes, async (args) => {
    calls.push(args);
    return JSON.stringify({ items: calls.length === 1 ? [] : observed });
  });
  expect((await client.prepare(fresh)).podUID).toBe("pod-uid");
  expect(calls).toHaveLength(2);
  expect(writes.map((args) => args[0])).toEqual(["get", "create", "apply"]);
  client.close();
});

test("partial inventory rejects changed namespace identity before apply", async () => {
  const namespace = resources()[0];
  if (!namespace) throw new Error("Test Namespace missing");
  const kubernetes = createKubernetesClient(async () => {
    throw new Error("Changed Namespace must not be applied");
  });
  const client = createWorkspaceSourceClient(kubernetes, async () =>
    JSON.stringify({
      items: [{ ...namespace, metadata: { ...namespace.metadata, uid: "replacement" } }],
    }),
  );
  await expect(client.prepare(input)).rejects.toThrow("unrelated source namespace");
  client.close();
});

test("partial source still rechecks the namespace UID immediately before apply", async () => {
  const observed = resources();
  const namespace = observed[0];
  if (!namespace) throw new Error("Test Namespace missing");
  const calls: string[][] = [];
  const kubernetes = createKubernetesClient(async (args) => {
    expect(args[0]).toBe("get");
    return {
      stdout: JSON.stringify({
        ...namespace,
        metadata: { ...namespace.metadata, uid: "replacement" },
      }),
      stderr: "",
      exitCode: 0,
    };
  });
  const client = createWorkspaceSourceClient(kubernetes, async (args) => {
    calls.push(args);
    return JSON.stringify({ items: [namespace] });
  });
  await expect(client.prepare({ ...input, claimUID: null, podUID: null })).rejects.toThrow(
    "Refusing to adopt existing namespace",
  );
  expect(calls).toHaveLength(1);
  client.close();
});

test("a missing confirmed source Pod cannot be recreated under its old access epoch", async () => {
  const observed = resources().filter((resource) => resource.kind !== "Pod");
  let applies = 0;
  const kubernetes = createKubernetesClient(async (args) => {
    if (args[0] === "get") return { stdout: JSON.stringify(observed[0]), stderr: "", exitCode: 0 };
    applies++;
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const client = createWorkspaceSourceClient(kubernetes, async () =>
    JSON.stringify({ items: observed }),
  );
  try {
    await expect(client.prepare(input)).rejects.toThrow("Recorded source Pod disappeared");
    expect(applies).toBe(0);
  } finally {
    client.close();
  }
});

function replacedSource(corruption?: string) {
  let observed = resources().map((resource) =>
    resource.kind === "Pod"
      ? { ...resource, metadata: { ...resource.metadata, uid: "replacement-pod" } }
      : resource,
  );
  const pod = observed.find((resource) => resource.kind === "Pod");
  const secret = observed.find((resource) => resource.kind === "Secret");
  const claim = observed.find((resource) => resource.kind === "PersistentVolumeClaim");
  const namespace = observed.find((resource) => resource.kind === "Namespace");
  if (!pod || !secret || !claim || !namespace) throw new Error("Missing owned source fixture");
  const container = pod.spec.containers[0];
  const data = secret.data;
  if (!container || !data) throw new Error("Missing source container or assignment");
  if (corruption === "claim") claim.metadata.uid = "different-claim";
  if (corruption === "namespace") namespace.metadata.uid = "different-namespace";
  if (corruption === "assignment")
    data["access.json"] = Buffer.from('{"token":"different"}').toString("base64");
  if (corruption === "image") container.image = "unowned:latest";
  if (corruption === "environment")
    Reflect.set(container, "env", [{ name: "UNOWNED", value: "changed" }]);
  const deleted: Array<{ path: string; uid: string }> = [];
  const client = createWorkspaceSourceClient(createKubernetesClient(), async (args, body) => {
    if (args[0] === "delete") {
      const path = args[2];
      if (!path) throw new Error("Missing exact resource path");
      const uid = (body as { preconditions: { uid: string } }).preconditions.uid;
      deleted.push({ path, uid });
      observed = observed.filter((resource) => resource.metadata.uid !== uid);
      return "";
    }
    if (args[1]?.startsWith("pod/"))
      return JSON.stringify({
        items:
          corruption === "pod-race"
            ? observed.map((resource) =>
                resource.kind === "Pod"
                  ? { ...resource, metadata: { ...resource.metadata, uid: "second-replacement" } }
                  : resource,
              )
            : observed,
      });
    if (args[1] === "pods" || args[1] === "pod") {
      const resource = observed.find((resource) => resource.kind === "Pod");
      return resource ? JSON.stringify(resource) : null;
    }
    if (args[1] === "secrets") return JSON.stringify(secret);
    throw new Error(`Unexpected source cleanup operation: ${args[0]}`);
  });
  return { client, deleted, remaining: () => observed };
}

test("explicit source Stop can remove only a fully validated replacement, without adopting it or removing storage", async () => {
  const f = replacedSource();
  try {
    await expect(f.client.observe(input)).rejects.toThrow("identity differs");
    await f.client.stop(input);
    expect(f.deleted.map((entry) => entry.uid)).toEqual(["replacement-pod", "secret-uid"]);
    expect(
      f.deleted.every((entry) => entry.path.startsWith(`/api/v1/namespaces/${input.namespace}/`)),
    ).toBe(true);
    expect(f.remaining().map((resource) => resource.kind)).toEqual([
      "Namespace",
      "PersistentVolumeClaim",
    ]);
    expect(input.podUID).toBe("pod-uid");
  } finally {
    f.client.close();
  }
});

test.each(["claim", "namespace", "assignment", "image", "environment", "pod-race"])(
  "explicit source Stop still refuses a replacement with changed %s before deleting anything",
  async (corruption) => {
    const f = replacedSource(corruption);
    try {
      await expect(f.client.stop(input)).rejects.toThrow();
      expect(f.deleted).toEqual([]);
    } finally {
      f.client.close();
    }
  },
);

test("complete source observation still rejects a conflicting assignment", async () => {
  const observed = resources().map((resource) =>
    resource.kind === "Secret"
      ? { ...resource, data: { "access.json": Buffer.from("wrong").toString("base64") } }
      : resource,
  );
  const kubernetes = createKubernetesClient(async (args) => {
    expect(args[0]).toBe("get");
    return { stdout: JSON.stringify(observed[0]), stderr: "", exitCode: 0 };
  });
  const calls: string[][] = [];
  const client = createWorkspaceSourceClient(kubernetes, async (args) => {
    calls.push(args);
    return JSON.stringify({ items: observed });
  });
  await expect(client.prepare(input)).rejects.toThrow("identity differs");
  expect(calls).toHaveLength(1);
  client.close();
});

test("source connection revalidates replacement identity before opening a tunnel", async () => {
  const observed = resources().map((resource) =>
    resource.kind === "Pod"
      ? {
          ...resource,
          metadata: { ...resource.metadata, uid: "replaced" },
        }
      : resource,
  );
  const client = createWorkspaceSourceClient(createKubernetesClient(), async () =>
    JSON.stringify({ items: observed }),
  );
  await expect(client.connect(input)).rejects.toThrow("identity differs");
  client.close();
});

test("source readiness requires a directory stat, not arbitrary successful JSON", () => {
  expect(() => confirmSourceRoot({ kind: "directory" })).not.toThrow();
  for (const value of [null, {}, { kind: "file" }])
    expect(() => confirmSourceRoot(value)).toThrow();
});

test("a current ready source observation is consumed once without duplicate infrastructure reads", async () => {
  const calls: string[][] = [];
  const observed = resources();
  const client = createWorkspaceSourceClient(createKubernetesClient(), async (args) => {
    calls.push(args);
    return JSON.stringify({ items: observed });
  });
  const result = await client.observe(input);
  expect(result?.ready).toBe(true);
  // Invalid names stop the real supervisor immediately after endpoint selection.
  // The assertion isolates inventory reuse, not connection success.
  await expect(client.connect(input, result ?? undefined)).rejects.toThrow();
  expect(calls).toHaveLength(1);
  client.close();
});

test("observation reuse cannot bypass replacement identity or accept caller-forged observations", async () => {
  for (const forged of [false, true]) {
    let inventories = 0;
    const client = createWorkspaceSourceClient(createKubernetesClient(), async () => {
      inventories += 1;
      return JSON.stringify({ items: resources() });
    });
    const observed = await client.observe(input);
    if (!observed) throw new Error("Missing test observation");
    const changed = { ...input, podUID: "replacement" };
    await expect(client.connect(changed, forged ? { ...observed } : observed)).rejects.toThrow(
      "identity differs",
    );
    expect(inventories).toBe(forged ? 2 : 1);
    client.close();
  }
});

test("source observations expire and cannot suppress later infrastructure revalidation", async () => {
  let inventories = 0;
  const client = createWorkspaceSourceClient(createKubernetesClient(), async () => {
    inventories += 1;
    return JSON.stringify({ items: resources() });
  });
  const observed = await client.observe(input);
  await Bun.sleep(1_010);
  await expect(client.connect(input, observed ?? undefined)).rejects.toThrow();
  expect(inventories).toBe(2);
  client.close();
});
