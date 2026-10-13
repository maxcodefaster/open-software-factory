import { expect, test } from "bun:test";
import { createKubernetesClient } from "./client";

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
