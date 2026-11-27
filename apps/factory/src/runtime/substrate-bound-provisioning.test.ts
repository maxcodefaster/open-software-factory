import { expect, test } from "bun:test";
import { SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import {
  nativeProjectBootstrap,
  nativeProjectDefinition,
} from "../../../../test/fixtures/native-project";
import { substrateTemplateSHA256 } from "./substrate";
import {
  absentBoundNativeResource,
  type BoundNativeProvisioningFacts,
  boundNativeCreateRejected,
  boundNativeProvisioningChecks,
  boundNativeProvisioningKinds,
  boundNativeProvisioningResource,
  provisionBoundNativeResources,
} from "./substrate-bound-provisioning";
import { renderSubstrateTemplate } from "./substrate-template";

const atespace = "fa-owned-bound-provisioning";
const editorPrincipal = "user:system:serviceaccount:owned:factory-control";
const attempted = new Date("2026-11-20T12:00:00Z");
const template = renderSubstrateTemplate(
  atespace,
  {
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    workerSelector: { "factory.dev/deployment": "owned" },
  },
  nativeProjectBootstrap({ assignment: { runtimeAttemptId: crypto.randomUUID() } }),
  nativeProjectDefinition,
);

test.each(["lost-create", "lost-outcome"] as const)(
  "shared provisioning observes the original %s without repeating Create or retaining bootstrap secrets",
  async (failure) => {
    const facts: BoundNativeProvisioningFacts = {
      atespace: null,
      policy: null,
      template: null,
      atespaceAttemptedAt: null,
      policyAttemptedAt: null,
      templateAttemptedAt: null,
      atespaceRejected: false,
      policyRejected: false,
      templateRejected: false,
    };
    const checks = boundNativeProvisioningChecks(
      "Workspace",
      atespace,
      editorPrincipal,
      template,
      substrateTemplateSHA256(template),
    );
    const resources = new Map<string, unknown>();
    const creates: string[] = [];
    const roles: string[] = [];
    let failing = true;
    const call = (role: string) => async (method: string) => {
      roles.push(`${role}:${method}`);
      const kind = method.includes("ActorTemplate")
        ? "template"
        : method.includes("AccessPolicy")
          ? "policy"
          : "atespace";
      if (method.startsWith("Get")) {
        const value = resources.get(kind);
        if (!value) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(value);
      }
      expect(facts[`${kind}AttemptedAt`]).toEqual(attempted);
      creates.push(method);
      const value = {
        ...(kind === "template" ? template : {}),
        ...(kind === "policy"
          ? { bindings: [{ role: "editor", members: [editorPrincipal] }] }
          : {}),
        metadata: {
          name: checks(kind).name,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: attempted.toISOString(),
          ...(kind === "template" ? { atespace } : {}),
        },
      };
      resources.set(kind, value);
      if (failing && failure === "lost-create") {
        failing = false;
        throw new SubstrateRPCError("Unavailable", "lost Create reply");
      }
      return value;
    };
    const input = {
      label: "Workspace",
      checks,
      owner: call("owner"),
      editor: call("editor"),
      read: async () => structuredClone(facts),
      authorize: async () => {},
      dispatch: async (kind: (typeof boundNativeProvisioningKinds)[number]) => {
        facts[`${kind}AttemptedAt`] = attempted;
      },
      reject: async (kind: (typeof boundNativeProvisioningKinds)[number]) => {
        facts[`${kind}Rejected`] = true;
      },
      remember: async (
        kind: (typeof boundNativeProvisioningKinds)[number],
        value: typeof boundNativeProvisioningResource._output,
      ) => {
        if (failing && failure === "lost-outcome") {
          failing = false;
          throw new Error("lost local outcome write");
        }
        facts[kind] = value;
      },
    };
    await expect(provisionBoundNativeResources(input)).rejects.toThrow("lost");
    const completed = await provisionBoundNativeResources(input);
    expect(creates).toEqual([
      "CreateAtespace",
      "CreateAtespaceAccessPolicy",
      "CreateActorTemplate",
    ]);
    expect(completed.template).toEqual({
      metadata: boundNativeProvisioningResource.parse(resources.get("template")).metadata,
    });
    expect(roles.at(-2)).toBe("editor:CreateActorTemplate");
    expect(roles.at(-1)).toBe("editor:GetActorTemplate");
    const before = creates.length;
    await provisionBoundNativeResources(input);
    expect(creates).toHaveLength(before);
    expect(roles.slice(-3)).toEqual([
      "editor:GetAtespace",
      "editor:GetAtespaceAccessPolicy",
      "editor:GetActorTemplate",
    ]);
  },
);

test.each(["Workspace", "Verification", "isolated"] as const)(
  "%s checks retain each bound resource's name, scope, dispatch time, UID and version",
  (label) => {
    const checks = boundNativeProvisioningChecks(
      label,
      atespace,
      editorPrincipal,
      template,
      substrateTemplateSHA256(template),
    );
    for (const kind of boundNativeProvisioningKinds) {
      const check = checks(kind);
      const value = boundNativeProvisioningResource.parse({
        ...(kind === "template" ? template : {}),
        ...(kind === "policy"
          ? { bindings: [{ role: "editor", members: [editorPrincipal] }] }
          : {}),
        metadata: {
          name: check.name,
          ...(kind === "template" ? { atespace } : {}),
          uid: crypto.randomUUID(),
          version: "1",
          createTime: attempted.toISOString(),
        },
      });
      check.requireOriginal(value, null, attempted);
      check.requireOriginal(structuredClone(value), value, attempted);
      expect(() => check.requireOriginal(value, null, null)).toThrow("original identity");
      for (const metadata of [
        { name: "foreign" },
        { uid: crypto.randomUUID() },
        { version: "2" },
        { createTime: new Date(attempted.getTime() - 1).toISOString() },
        { atespace: kind === "template" ? undefined : atespace },
      ]) {
        const foreign = { ...value, metadata: { ...value.metadata, ...metadata } };
        expect(() => check.requireOriginal(foreign, value, attempted)).toThrow("original identity");
      }
      if (kind === "template")
        expect(() => check.requireOriginal({ ...value, containers: [] }, value, attempted)).toThrow(
          "frozen intent",
        );
      if (kind === "policy")
        expect(() => check.requireOriginal({ ...value, bindings: [] }, value, attempted)).toThrow(
          "grant differs",
        );
    }
    expect(checks("atespace")).toMatchObject({
      getMethod: "GetAtespace",
      createMethod: "CreateAtespace",
      getRequest: { atespace: { name: atespace } },
      createRequest: { atespace: { metadata: { name: atespace } } },
    });
    expect(checks("policy")).toMatchObject({
      getMethod: "GetAtespaceAccessPolicy",
      createMethod: "CreateAtespaceAccessPolicy",
      getRequest: { atespace: { name: atespace }, name: "default" },
      createRequest: {
        atespace: { name: atespace },
        accessPolicy: {
          metadata: { name: "default" },
          bindings: [{ role: "editor", members: [editorPrincipal] }],
        },
      },
    });
    expect(checks("template")).toMatchObject({
      getMethod: "GetActorTemplate",
      createMethod: "CreateActorTemplate",
      getRequest: { actorTemplate: { atespace, name: "runtime" } },
      createRequest: { actorTemplate: template },
    });
  },
);

test("only definitive bound Create rejections prevent observation after a lost reply", () => {
  for (const code of ["AlreadyExists", "PermissionDenied", "Unauthenticated", "InvalidArgument"])
    expect(boundNativeCreateRejected(new SubstrateRPCError(code, "rejected"))).toBe(true);
  for (const code of ["Unavailable", "DeadlineExceeded", "Internal", "NotFound"])
    expect(boundNativeCreateRejected(new SubstrateRPCError(code, "unknown"))).toBe(false);
  expect(boundNativeCreateRejected(new Error("bridge reply lost"))).toBe(false);
  expect(boundNativeCreateRejected({ code: "PermissionDenied" })).toBe(false);
});

test("bound resource absence requires native NotFound, never a failed read", async () => {
  const notFound = new SubstrateRPCError("NotFound", "absent");
  expect(
    await absentBoundNativeResource(
      async () => {
        throw notFound;
      },
      "GetAtespace",
      {},
    ),
  ).toBeNull();
  const unknown = new SubstrateRPCError("Unavailable", "lost read");
  await expect(
    absentBoundNativeResource(
      async () => {
        throw unknown;
      },
      "GetAtespace",
      {},
    ),
  ).rejects.toBe(unknown);
});
