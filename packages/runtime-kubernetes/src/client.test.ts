import { expect, test } from "bun:test";
import { createKubernetesClient, KubernetesObservationUnavailableError } from "./client";
import { factoryboxSharedLabels } from "./factorybox-location";

const namespace = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    name: "factory-owned",
    labels: {
      "app.kubernetes.io/managed-by": "open-software-factory",
      "factory.dev/runtime-owner": "workspace",
    },
  },
};
const resources = [
  namespace,
  { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "runtime-data" } },
  { apiVersion: "v1", kind: "Secret", metadata: { name: "assignment" } },
  { apiVersion: "v1", kind: "Pod", metadata: { name: "source" } },
];

test("runtime observation requires Factorybox artifacts and never adopts an Envbox Pod", async () => {
  for (const legacy of [false, true]) {
    const client = createKubernetesClient(async () => ({
      stdout: JSON.stringify({
        metadata: { uid: "owned" },
        spec: legacy
          ? {
              containers: [
                {
                  name: "envbox",
                  image: "legacy",
                  env: [{ name: "CODER_INNER_IMAGE", value: "legacy-inner" }],
                },
              ],
            }
          : {
              containers: [{ name: "worker", image: "owned-worker" }],
              initContainers: [{ name: "runtime-image", image: "owned-runtime" }],
            },
        status: { phase: "Running" },
      }),
      stderr: "",
      exitCode: 0,
    }));
    if (legacy) await expect(client.getPod("owned", "runtime")).rejects.toThrow("Factorybox");
    else
      expect(await client.getPod("owned", "runtime")).toMatchObject({
        factoryboxImage: "owned-worker",
        runtimeHostImage: "owned-runtime",
      });
  }
});

test.each([
  "Unable to connect to the server: context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
  "Unable to connect to the server: dial tcp: i/o timeout",
  "The connection to the server 127.0.0.1:6443 was refused",
  "Error from server (ServiceUnavailable): the server is currently unable to handle the request",
])(
  "a Pod read preserves unavailable observation instead of proving Pod failure: %s",
  async (stderr) => {
    const client = createKubernetesClient(async () => ({ stdout: "", stderr, exitCode: 1 }));
    try {
      await client.getPod("owned-namespace", "owned-pod");
      throw new Error("Expected unavailable observation");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).name).toBe("KubernetesObservationUnavailableError");
    }
  },
);

test("a bounded Pod-read subprocess timeout is still an unavailable observation", async () => {
  const client = createKubernetesClient(async () => {
    throw new Error("Infrastructure command timed out; outcome is unconfirmed");
  });
  await expect(client.getPod("owned-namespace", "owned-pod")).rejects.toBeInstanceOf(
    KubernetesObservationUnavailableError,
  );
});

test.each([
  "Unable to connect to the server: context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
  "Error from server (ServiceUnavailable): the server is currently unable to handle the request",
])(
  "namespace read classifies transient observations without claiming resource absence: %s",
  async (stderr) => {
    const client = createKubernetesClient(async () => ({ stdout: "", stderr, exitCode: 1 }));
    await expect(client.getNamespace("owned-namespace")).rejects.toBeInstanceOf(
      KubernetesObservationUnavailableError,
    );
  },
);

test("a bounded namespace-read subprocess timeout remains an unavailable observation", async () => {
  const client = createKubernetesClient(async () => {
    throw new Error("Infrastructure command timed out; outcome is unconfirmed");
  });
  await expect(client.getNamespace("owned-namespace")).rejects.toBeInstanceOf(
    KubernetesObservationUnavailableError,
  );
});

test.each([
  "Error from server (Forbidden): pods is forbidden",
  "You must be logged in to the server",
  "Infrastructure command output exceeded its bound",
])(
  "a non-transport Pod read error is not retried as a transient observation: %s",
  async (stderr) => {
    const client = createKubernetesClient(async () => ({ stdout: "", stderr, exitCode: 1 }));
    try {
      await client.getPod("owned-namespace", "owned-pod");
      throw new Error("Expected Pod read rejection");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBeInstanceOf(KubernetesObservationUnavailableError);
    }
  },
);

test("resource creation uses one ordered apply after confirming its Namespace identity", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const client = createKubernetesClient(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    if (args[0] === "get") return { stdout: "", stderr: "NotFound", exitCode: 1 };
    return {
      stdout: JSON.stringify({ metadata: { uid: "namespace-uid" } }),
      stderr: "",
      exitCode: 0,
    };
  });
  expect(await client.apply(resources)).toEqual({ namespaceUID: "namespace-uid" });
  expect(calls.map(({ args }) => args[0])).toEqual(["get", "create", "apply"]);
  expect(JSON.parse(calls[1]?.input ?? "null")).toEqual(namespace);
  expect(JSON.parse(calls[2]?.input ?? "null")).toEqual({
    apiVersion: "v1",
    kind: "List",
    items: resources.slice(1),
  });
  expect(calls[2]?.args).toContain("--server-side");
});

test("foreign or replaced Namespace blocks the entire resource apply", async () => {
  for (const observed of [
    { uid: "replacement", labels: namespace.metadata.labels },
    {
      uid: "namespace-uid",
      labels: { ...namespace.metadata.labels, "factory.dev/runtime-owner": "other" },
    },
  ]) {
    const calls: string[][] = [];
    const client = createKubernetesClient(async (args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ metadata: observed }), stderr: "", exitCode: 0 };
    });
    await expect(
      client.apply(resources, { ownerID: "workspace", uid: "namespace-uid" }),
    ).rejects.toThrow("Refusing");
    expect(calls.map((args) => args[0])).toEqual(["get"]);
  }
});

test("partially failed batch retains deterministic intent for an observed-namespace retry", async () => {
  const batches: string[] = [];
  let fail = true;
  const client = createKubernetesClient(async (args, input) => {
    if (args[0] === "get")
      return {
        stdout: JSON.stringify({ metadata: { ...namespace.metadata, uid: "namespace-uid" } }),
        stderr: "",
        exitCode: 0,
      };
    batches.push(input ?? "");
    return { stdout: "", stderr: fail ? "partial apply failed" : "", exitCode: fail ? 1 : 0 };
  });
  const ownership = { ownerID: "workspace", uid: "namespace-uid" };
  await expect(client.apply(resources, ownership)).rejects.toThrow("apply failed");
  fail = false;
  expect(await client.apply(resources, ownership)).toEqual({ namespaceUID: "namespace-uid" });
  expect(batches).toHaveLength(2);
  expect(batches[0]).toBe(batches[1]);
});

const sharedLabels = factoryboxSharedLabels("68f16b47-92d3-493d-8145-f92742951764");
const common = {
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: { name: "runtime-data", namespace: namespace.metadata.name, labels: sharedLabels },
  spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "32Gi" } } },
};
const privateAssignment = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: {
    name: "assignment-owned",
    namespace: namespace.metadata.name,
    labels: {
      "app.kubernetes.io/managed-by": "open-software-factory",
      "factory.dev/runtime-owner": "sandbox",
    },
  },
  stringData: { "assignment.json": "owned" },
};

test("existing shared storage is observed and UID-checked, never reapplied with a Sandbox", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const client = createKubernetesClient(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    return {
      stdout: JSON.stringify(
        args[1] === "namespace"
          ? { metadata: { uid: "namespace-uid", labels: namespace.metadata.labels } }
          : { ...common, metadata: { ...common.metadata, uid: "claim-uid" } },
      ),
      stderr: "",
      exitCode: 0,
    };
  });
  expect(
    await client.apply([namespace, common, privateAssignment], {
      ownerID: "workspace",
      uid: "namespace-uid",
      sharedUIDs: { "PersistentVolumeClaim/runtime-data": "claim-uid" },
    }),
  ).toEqual({
    namespaceUID: "namespace-uid",
    sharedUIDs: { "PersistentVolumeClaim/runtime-data": "claim-uid" },
  });
  expect(calls.map((call) => call.args[0])).toEqual(["get", "get", "apply"]);
  expect(JSON.parse(calls[2]?.input ?? "{}").items).toEqual([privateAssignment]);
});

test.each(["UID", "owner", "spec"] as const)(
  "shared storage %s drift refuses before private writes",
  async (changed) => {
    const writes: string[][] = [];
    const client = createKubernetesClient(async (args) => {
      if (args[0] !== "get") writes.push(args);
      return {
        stdout: JSON.stringify(
          args[1] === "namespace"
            ? { metadata: { uid: "namespace-uid", labels: namespace.metadata.labels } }
            : {
                ...common,
                metadata: {
                  ...common.metadata,
                  uid: changed === "UID" ? "replacement" : "claim-uid",
                  labels: {
                    ...common.metadata.labels,
                    ...(changed === "owner" ? { "factory.dev/runtime-owner": "foreign" } : {}),
                  },
                },
                spec:
                  changed === "spec"
                    ? { ...common.spec, accessModes: ["ReadWriteMany"] }
                    : common.spec,
              },
        ),
        stderr: "",
        exitCode: 0,
      };
    });
    await expect(
      client.apply([namespace, common, privateAssignment], {
        ownerID: "workspace",
        uid: "namespace-uid",
        sharedUIDs: { "PersistentVolumeClaim/runtime-data": "claim-uid" },
      }),
    ).rejects.toThrow("immutable owner");
    expect(writes).toHaveLength(0);
  },
);

test("a surviving worker cannot recreate even an unrecorded missing shared resource", async () => {
  const writes: string[][] = [];
  const client = createKubernetesClient(async (args) => {
    if (args[0] !== "get") writes.push(args);
    if (args[1] === "namespace")
      return {
        stdout: JSON.stringify({
          metadata: { uid: "namespace-uid", labels: namespace.metadata.labels },
        }),
        stderr: "",
        exitCode: 0,
      };
    if (args[0] === "get")
      return { stdout: "", stderr: "Error from server (NotFound): missing claim", exitCode: 1 };
    return {
      stdout: JSON.stringify({ metadata: { uid: "replacement" } }),
      stderr: "",
      exitCode: 0,
    };
  });
  await expect(
    client.apply([namespace, common, privateAssignment], {
      ownerID: "workspace",
      uid: "namespace-uid",
      createShared: false,
    }),
  ).rejects.toThrow("disappeared");
  expect(writes).toHaveLength(0);
});

test.each([
  "original",
  "foreign-namespace",
  "foreign-owner",
  "shared-secret",
  "unavailable",
] as const)(
  "private assignment cleanup is UID-bound and preserves shared resources: %s",
  async (scenario) => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const client = createKubernetesClient(async (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      if (scenario === "unavailable")
        return { stdout: "", stderr: "Connection refused", exitCode: 1 };
      return {
        stdout: JSON.stringify(
          args[1] === "namespace"
            ? {
                metadata: {
                  uid: scenario === "foreign-namespace" ? "replacement" : "namespace-uid",
                },
              }
            : {
                metadata: {
                  uid: "assignment-uid",
                  labels: {
                    ...privateAssignment.metadata.labels,
                    ...(scenario === "foreign-owner"
                      ? { "factory.dev/runtime-owner": "other" }
                      : {}),
                    ...(scenario === "shared-secret"
                      ? { "factory.dev/shared-resource": "true" }
                      : {}),
                  },
                },
              },
        ),
        stderr: "",
        exitCode: 0,
      };
    });
    const deletion = client.deleteSecret({
      namespace: namespace.metadata.name,
      namespaceUID: "namespace-uid",
      name: privateAssignment.metadata.name,
      ownerID: "sandbox",
    });
    if (scenario === "original") {
      await deletion;
      const removed = calls.filter((call) => call.args[0] === "delete");
      expect(removed).toHaveLength(1);
      expect(removed[0]?.args[2]).toBe(
        `/api/v1/namespaces/${namespace.metadata.name}/secrets/${privateAssignment.metadata.name}`,
      );
      expect(JSON.parse(removed[0]?.input ?? "{}").preconditions).toEqual({
        uid: "assignment-uid",
      });
    } else {
      await expect(deletion).rejects.toThrow();
      expect(calls.every((call) => call.args[0] === "get")).toBe(true);
    }
  },
);
