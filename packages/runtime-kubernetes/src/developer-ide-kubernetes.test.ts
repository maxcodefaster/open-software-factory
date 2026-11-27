import { expect, test } from "bun:test";
import { developerIDEIdentity } from "#workspace-domain/developer-ide";
import {
  createDeveloperIDEKubernetesClient,
  DeveloperIDEObservationUnavailableError,
} from "./developer-ide-kubernetes";
import { renderDeveloperIDEResources } from "./developer-ide-manifest";

const identity = developerIDEIdentity(
  "11111111-1111-4111-8111-111111111111",
  1,
  "22222222-2222-4222-8222-222222222222",
);
const resources = renderDeveloperIDEResources({
  identity,
  image: `registry.test/editor@sha256:${"a".repeat(64)}`,
  namespaceUID: null,
  podUID: null,
});
const namespace = resources.find((item) => item.kind === "Namespace");
if (!namespace) throw Error("Owned editor Namespace missing");
const observed = { metadata: { ...namespace.metadata, uid: "original-namespace" } };
const ownership = { ownerID: identity.userID, uid: "original-namespace" };

test("the editor creates only its ordinary Namespace and one Pod, never shared storage or privileged execution", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const client = createDeveloperIDEKubernetesClient(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    if (args[0] === "get") return { exitCode: 1, stdout: "", stderr: "NotFound" };
    const resource = JSON.parse(input ?? "null");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ...resource,
        metadata: { ...resource.metadata, uid: `owned-${resource.kind}` },
      }),
      stderr: "",
    };
  });
  expect(await client.apply(resources)).toEqual({ namespaceUID: "owned-Namespace" });
  expect(calls.map((call) => call.args[0])).toEqual(["get", "create", "create"]);
  const declarations = calls.slice(1).map((call) => JSON.parse(call.input ?? "null"));
  expect(declarations).toEqual(resources);
  expect(declarations.map((item) => item.kind)).toEqual(["Namespace", "Pod"]);
  expect(declarations[0].metadata.labels).not.toHaveProperty("pod-security.kubernetes.io/enforce");
  expect(JSON.stringify(declarations)).not.toMatch(
    /privileged|hostPath|docker\.sock|PersistentVolumeClaim/,
  );
  expect(declarations[1].spec.automountServiceAccountToken).toBe(false);
  expect(declarations[1].spec.containers[0].securityContext).toMatchObject({
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  });
});

test.each(["foreign-owner", "foreign-manager", "replaced", "unrecorded"] as const)(
  "editor creation refuses a %s Namespace before Pod creation",
  async (scenario) => {
    const calls: string[][] = [];
    const client = createDeveloperIDEKubernetesClient(async (args) => {
      calls.push(args);
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          metadata: {
            ...observed.metadata,
            uid: scenario === "replaced" ? "replacement" : observed.metadata.uid,
            labels: {
              ...observed.metadata.labels,
              ...(scenario === "foreign-owner"
                ? { "factory.dev/runtime-owner": "another-user" }
                : {}),
              ...(scenario === "foreign-manager"
                ? { "app.kubernetes.io/managed-by": "another-app" }
                : {}),
            },
          },
        }),
      };
    });
    await expect(
      client.apply(resources, scenario === "unrecorded" ? undefined : ownership),
    ).rejects.toThrow("Refusing");
    expect(calls.map((args) => args[0])).toEqual(["get"]);
  },
);

test("a recorded Namespace cannot be recreated after absence", async () => {
  const calls: string[][] = [];
  const client = createDeveloperIDEKubernetesClient(async (args) => {
    calls.push(args);
    return { exitCode: 1, stdout: "", stderr: "NotFound" };
  });
  await expect(client.apply(resources, ownership)).rejects.toThrow("disappeared");
  expect(calls).toHaveLength(1);
});

test.each(["Namespace", "Pod"] as const)(
  "a lost editor %s Create reply is not replayed or followed by another write",
  async (kind) => {
    const writes: string[] = [];
    const client = createDeveloperIDEKubernetesClient(async (args, input) => {
      if (args[0] === "get") return { exitCode: 1, stdout: "", stderr: "NotFound" };
      const declaration = JSON.parse(input ?? "null");
      writes.push(declaration.kind);
      if (declaration.kind === kind) throw Error("Owned create response lost");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ metadata: { uid: "namespace" } }),
        stderr: "",
      };
    });
    await expect(client.apply(resources)).rejects.toThrow("Owned create response lost");
    expect(writes).toEqual(kind === "Namespace" ? ["Namespace"] : ["Namespace", "Pod"]);
  },
);

test("a concurrent Pod Create conflict is not permission to patch or apply over it", async () => {
  const calls: string[][] = [];
  const client = createDeveloperIDEKubernetesClient(async (args) => {
    calls.push(args);
    return args[0] === "get"
      ? { exitCode: 0, stdout: JSON.stringify(observed), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "AlreadyExists" };
  });
  await expect(client.apply(resources, ownership)).rejects.toThrow("unconfirmed");
  expect(calls.map((args) => args[0])).toEqual(["get", "create"]);
});

test.each([
  "context deadline exceeded",
  "dial tcp: i/o timeout",
  "connection refused",
  "Error from server (ServiceUnavailable)",
  "Infrastructure command timed out; outcome is unconfirmed",
])("editor Namespace observation preserves unknown outcomes: %s", async (message) => {
  for (const thrown of [false, true]) {
    const client = createDeveloperIDEKubernetesClient(async () => {
      if (thrown) throw Error(message);
      return { exitCode: 1, stdout: "", stderr: message };
    });
    await expect(client.getNamespace(identity.namespace)).rejects.toBeInstanceOf(
      DeveloperIDEObservationUnavailableError,
    );
  }
});

test.each(["Forbidden", "Unauthorized", "Infrastructure command output exceeded its bound"])(
  "editor permission or malformed observation is not resource absence: %s",
  async (message) => {
    const client = createDeveloperIDEKubernetesClient(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: message,
    }));
    await expect(client.getNamespace(identity.namespace)).rejects.not.toBeInstanceOf(
      DeveloperIDEObservationUnavailableError,
    );
    await expect(client.getNamespace(identity.namespace)).rejects.toThrow(message);
  },
);

test("the editor refuses extra resources and non-editor names before Kubernetes access", async () => {
  let calls = 0;
  const client = createDeveloperIDEKubernetesClient(async () => {
    calls++;
    throw Error("Invalid declarations must not touch the cluster");
  });
  await expect(client.apply([...resources, ...resources])).rejects.toThrow("exact Namespace");
  const other = renderDeveloperIDEResources({
    identity: { ...identity, namespace: `factory-box-${"a".repeat(32)}` },
    image: `registry.test/editor@sha256:${"a".repeat(64)}`,
    namespaceUID: null,
    podUID: null,
  });
  await expect(client.apply(other)).rejects.toThrow("exact Namespace");
  expect(calls).toBe(0);
});
