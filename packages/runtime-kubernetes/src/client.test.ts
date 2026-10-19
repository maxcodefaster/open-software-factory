import { expect, test } from "bun:test";
import { createKubernetesClient, KubernetesObservationUnavailableError } from "./client";

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
