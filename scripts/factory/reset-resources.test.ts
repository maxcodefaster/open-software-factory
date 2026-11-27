import { expect, test } from "bun:test";
import { SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { nativeInstallationFixture } from "../../test/fixtures/native-installation";
import { type ResetResources, requireResetResourcesAbsent } from "./reset-resources";

const connection = nativeInstallationFixture().connection;
const resources: ResetResources = {
  nativeScopes: [{ name: `fa-${"a".repeat(32)}`, connection }],
  editorNamespaces: [`factory-editor-${"b".repeat(32)}`],
  capacityPools: [{ namespace: "ate-system", name: "factory-capacity-owned" }],
};

test("native reset reads only exact recorded scopes, editor Namespaces and capacity pools", async () => {
  const calls: unknown[] = [];
  await requireResetResourcesAbsent(
    resources,
    async (...args) => {
      calls.push(args);
      return false;
    },
    (selected) => {
      expect(selected).toEqual(connection);
      return async (method, request) => {
        calls.push([method, request]);
        throw new SubstrateRPCError("NotFound", "Owned native scope is absent");
      };
    },
  );
  expect(calls).toEqual([
    ["GetAtespace", { atespace: { name: resources.nativeScopes[0]?.name } }],
    ["namespace", resources.editorNamespaces[0]],
    ["workerpool", "factory-capacity-owned", "ate-system"],
  ]);
});

test("an existing native scope refuses reset without deleting or enumerating anything", async () => {
  const calls: string[] = [];
  for (const response of [{ metadata: { uid: crypto.randomUUID() } }, null, {}]) {
    await expect(
      requireResetResourcesAbsent(
        resources,
        async () => {
          throw new Error("Kubernetes must not be reached");
        },
        () => async (method) => {
          calls.push(method);
          return response;
        },
      ),
    ).rejects.toThrow("native scope");
  }
  expect(calls).toEqual(["GetAtespace", "GetAtespace", "GetAtespace"]);
});

test("missing credentials, permission denial and unknown native outcomes never count as absence", async () => {
  for (const error of [
    new Error("Owned transport unavailable"),
    new SubstrateRPCError("PermissionDenied", "Owned permission denial"),
    new SubstrateRPCError("Unavailable", "Owned unavailable API"),
  ])
    await expect(
      requireResetResourcesAbsent(
        resources,
        async () => false,
        () => async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
});

test("remaining or unobservable Kubernetes resources refuse native reset", async () => {
  const absent = () => async () => {
    throw new SubstrateRPCError("NotFound", "Owned native scope is absent");
  };
  await expect(requireResetResourcesAbsent(resources, async () => true, absent)).rejects.toThrow(
    "Developer IDE Namespace",
  );
  await expect(
    requireResetResourcesAbsent(resources, async (kind) => kind === "workerpool", absent),
  ).rejects.toThrow("capacity WorkerPool");
  await expect(
    requireResetResourcesAbsent(
      resources,
      async () => {
        throw new Error("Owned Kubernetes read failed");
      },
      absent,
    ),
  ).rejects.toThrow("Kubernetes read failed");
});

test("invalid saved identities refuse before native or Kubernetes I/O", async () => {
  for (const invalid of [
    { ...resources, nativeScopes: [{ ...resources.nativeScopes[0], name: "foreign" }] },
    { ...resources, editorNamespaces: ["factory-workspace-123456abcdef"] },
    { ...resources, capacityPools: [{ namespace: "../other", name: "pool" }] },
  ]) {
    let calls = 0;
    await expect(
      requireResetResourcesAbsent(
        invalid as ResetResources,
        async () => {
          calls++;
          return false;
        },
        () => async () => {
          calls++;
          return null;
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  }
});
