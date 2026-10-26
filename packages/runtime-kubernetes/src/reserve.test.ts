import { expect, test } from "bun:test";
import type { ExecutionSlot } from "../../runtime-domain/src/reserve";
import { createKubernetesClient } from "./client";
import { factoryboxAssignmentSecret, factoryboxLocation } from "./factorybox-location";
import { factoryboxReserveBootstrapProgram } from "./factorybox-runtime";
import {
  createReserveClient,
  renderReserveResources,
  slotActivationCommand,
  validateReserveObservation,
} from "./reserve";

const slot: ExecutionSlot = {
  id: "ec253fc1-4e17-4a75-a36d-c4efef02e77e",
  ...factoryboxLocation("e35856d5-d042-4226-971c-901cd27ec021"),
  role: "verification",
  state: "creating",
  runtimeHostImage: `registry.invalid/check@sha256:${"1".repeat(64)}`,
  namespaceUID: null,
  podUID: null,
  claimUID: null,
  expiresAt: "2026-10-10T00:00:00Z",
  assignedAttemptID: null,
  factoryboxProfile: {
    image: `registry.invalid/worker@sha256:${"2".repeat(64)}`,
    executableSHA256: "3".repeat(64),
    architecture: "amd64",
    nodeName: "owned-node",
    kernel: "6.12.0",
    boundedBytes: 8589934592,
    claimGiB: 32,
  },
};
function observations() {
  return renderReserveResources(slot, "approved-ca").map((resource) => ({
    ...resource,
    metadata: { ...resource.metadata, uid: `owned-${resource.kind}-${resource.metadata.name}` },
    ...("stringData" in resource
      ? {
          data: Object.fromEntries(
            Object.entries(resource.stringData).map(([key, value]) => [
              key,
              Buffer.from(value).toString("base64"),
            ]),
          ),
        }
      : {}),
    ...(resource.kind === "Pod"
      ? { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }
      : {}),
  }));
}
test("reserve uses the exact Factorybox topology without repository, user capabilities or shared Docker graphs", () => {
  const resources = renderReserveResources(slot, "approved-ca");
  const payload = JSON.stringify(resources) + factoryboxReserveBootstrapProgram;
  expect(payload).toContain("factory-runtime-connector reserve");
  expect(payload).not.toContain("until docker info");
  expect(payload).not.toMatch(
    /parent-token|child-token|repositoryUrl|FACTORY_MODEL_API_KEY|FACTORY_FORGEJO_TOKEN/,
  );
  const pod = resources.find((value) => value.kind === "Pod");
  expect(JSON.stringify(pod?.spec.volumes)).not.toContain("docker.sock");
  expect(JSON.stringify(pod?.spec.containers[0]?.volumeMounts)).not.toContain("docker.sock");
  expect(JSON.stringify(pod?.spec.containers[0]?.env)).not.toContain("docker.sock");
  expect(resources.find((value) => value.kind === "Pod")?.spec.automountServiceAccountToken).toBe(
    false,
  );
  expect(validateReserveObservation(slot, resources, observations())).toMatchObject({
    ready: true,
    failed: false,
    podUID: "owned-Pod-worker",
    claimUID: "owned-PersistentVolumeClaim-store-e35856d5d0424226971c901cd27ec021",
  });
});
test("reserve observation rejects changed tools, mounts, seeds, ownership and resource identities", () => {
  const resources = renderReserveResources(slot, "approved-ca");
  const changes: Array<(actual: ReturnType<typeof observations>) => void> = [
    (actual) => {
      const namespace = actual[0];
      if (!namespace) throw new Error("Expected reserve Namespace");
      Reflect.set(namespace.metadata.labels, "factory.dev/runtime-owner", "other-owner");
    },
    (actual) => {
      const namespace = actual[0];
      if (!namespace) throw new Error("Expected reserve Namespace");
      Reflect.deleteProperty(namespace.metadata.labels, "factory.dev/runtime-owner");
    },
    (actual) => {
      const pod = actual.find((value) => value.kind === "Pod");
      if (!pod) throw new Error("Expected reserve Pod");
      Reflect.set(pod.spec, "hostNetwork", true);
    },
    (actual) => {
      const pod = actual.find((value) => value.kind === "Pod");
      if (!pod) throw new Error("Expected reserve Pod");
      Reflect.set(pod.spec, "initContainers", [{ image: "unapproved" }]);
    },
    (actual) => {
      const secret = actual.find((value) => value.kind === "Secret");
      if (!secret) throw new Error("Expected reserve seed");
      Reflect.set(secret, "data", {
        "slot.json": Buffer.from('{"id":"other-slot"}').toString("base64"),
      });
    },
    (actual) => {
      const namespace = actual[0];
      if (!namespace) throw new Error("Expected reserve Namespace");
      Reflect.set(actual, actual.length, { ...namespace, kind: "ConfigMap" });
    },
    (actual) => {
      const secret = actual.find((value) => value.kind === "Secret");
      if (!secret || !("data" in secret)) throw new Error("Expected reserve seed");
      Reflect.set(
        secret.data,
        "unexpected-capability",
        Buffer.from("not-clean").toString("base64"),
      );
    },
    (actual) => {
      const secret = actual.find((value) => value.kind === "Secret");
      if (!secret || !("data" in secret)) throw new Error("Expected reserve seed");
      Reflect.set(secret.data, "toString", Buffer.from("not-clean").toString("base64"));
    },
  ];
  for (const change of changes) {
    const actual = observations();
    change(actual);
    expect(() => validateReserveObservation(slot, resources, actual)).toThrow();
  }
  expect(() =>
    validateReserveObservation({ ...slot, podUID: "different-pod" }, resources, observations()),
  ).toThrow("UID changed");
  expect(() =>
    validateReserveObservation({ ...slot, claimUID: "different-claim" }, resources, observations()),
  ).toThrow("UID changed");
  expect(slotActivationCommand.indexOf('test "$FACTORY_POD_UID"')).toBeLessThan(
    slotActivationCommand.indexOf("mktemp"),
  );
  expect(slotActivationCommand).toContain("cmp -s");
  expect(slotActivationCommand).toContain("chown 100000:100000");
});

test("assigned replay allows only the exact activation keys under its durable owner", () => {
  const assigned: ExecutionSlot = {
    ...slot,
    state: "assigned",
    assignedAttemptID: "3e8ca245-0686-49f3-bd1f-097f42760567",
  };
  const resources = renderReserveResources(assigned, "approved-ca");
  const actual = observations();
  const secret = actual.find(
    (value) =>
      value.kind === "Secret" && value.metadata.name === factoryboxAssignmentSecret(slot.id),
  );
  if (!secret || !("data" in secret)) throw new Error("Expected assignment Secret");
  const assignmentData = {
    "assignment.json": JSON.stringify({ runtimeAttemptId: assigned.assignedAttemptID }),
    "parent-token": "test-parent",
    "child-token": "test-child",
  };
  for (const [key, value] of Object.entries(assignmentData))
    Reflect.set(secret.data, key, Buffer.from(value).toString("base64"));
  const validate = () =>
    validateReserveObservation(
      assigned,
      resources,
      actual,
      assigned.assignedAttemptID ?? undefined,
      assignmentData,
    );
  expect(validate()).toMatchObject({ ready: true });
  expect(() => validateReserveObservation(assigned, resources, actual)).toThrow();
  expect(() => validateReserveObservation(assigned, resources, actual, "other-owner")).toThrow();
  Reflect.set(secret.data, "parent-token", Buffer.from("changed-token").toString("base64"));
  expect(validate).toThrow("changed credentials");
  Reflect.set(
    secret.data,
    "parent-token",
    Buffer.from(assignmentData["parent-token"]).toString("base64"),
  );
  Reflect.set(secret.data, "unexpected-capability", Buffer.from("not-clean").toString("base64"));
  expect(validate).toThrow("changed credentials");
  Reflect.deleteProperty(secret.data, "unexpected-capability");
  const ca = actual.find(
    (value) => value.kind === "Secret" && value.metadata.name === "registry-ca",
  );
  if (!ca || !("data" in ca)) throw new Error("Expected registry CA Secret");
  Reflect.set(ca.data, "parent-token", Buffer.from("not-clean").toString("base64"));
  expect(validate).toThrow("changed credentials");
});

function cleanupFixture(change?: (actual: ReturnType<typeof observations>) => void) {
  const actual = observations();
  const observed = validateReserveObservation(
    slot,
    renderReserveResources(slot, "approved-ca"),
    actual,
  );
  change?.(actual);
  const deleted: string[] = [];
  const reads: string[][] = [];
  const adapter = createReserveClient(
    async (args) => {
      reads.push(args);
      if (args[0] !== "get" || args.includes("pods,pvc,secrets"))
        throw new Error("Cleanup must not list a Namespace or mutate shared resources");
      if (args[1] === "namespace")
        return JSON.stringify(actual.find((item) => item.kind === "Namespace"));
      return JSON.stringify({ items: actual.filter((item) => item.kind !== "Namespace") });
    },
    {
      ...createKubernetesClient(async () => {
        throw new Error("Unexpected Kubernetes operation");
      }),
      async deleteSecret(input) {
        expect(input).toEqual({
          namespace: slot.namespace,
          namespaceUID: observed.namespaceUID,
          name: factoryboxAssignmentSecret(slot.id),
          ownerID: slot.id,
        });
        deleted.push(input.name);
      },
      async deleteNamespace() {
        throw new Error("Cleanup must preserve the Factory Namespace");
      },
    },
  );
  return {
    adapter,
    deleted,
    reads,
    slot: {
      ...slot,
      namespaceUID: observed.namespaceUID,
      podUID: observed.podUID,
      claimUID: observed.claimUID,
    },
  };
}

test("retiring an unused slot deletes only its private assignment and preserves the shared worker", async () => {
  const fixture = cleanupFixture();
  await fixture.adapter.retire({ ...fixture.slot, state: "retiring" });
  expect(fixture.deleted).toEqual([factoryboxAssignmentSecret(slot.id)]);
  expect(fixture.reads.every((args) => args[0] === "get")).toBe(true);
});

test("assigned slot cleanup preserves Factory resources and keeps its original slot owner", async () => {
  const fixture = cleanupFixture();
  expect(
    await fixture.adapter.removeAssigned(
      {
        ...fixture.slot,
        state: "assigned",
        assignedAttemptID: "3e8ca245-0686-49f3-bd1f-097f42760567",
      },
      1,
    ),
  ).toBe(true);
  expect(fixture.deleted).toEqual([factoryboxAssignmentSecret(slot.id)]);
});

test("slot cleanup refuses changed shared ownership or UIDs before deleting credentials", async () => {
  for (const change of [
    (actual: ReturnType<typeof observations>) => {
      const pod = actual.find((item) => item.kind === "Pod");
      if (!pod) throw new Error("Expected shared worker");
      pod.metadata.uid = "replacement";
    },
    (actual: ReturnType<typeof observations>) => {
      const namespace = actual.find((item) => item.kind === "Namespace");
      if (!namespace) throw new Error("Expected Factory Namespace");
      Reflect.set(namespace.metadata.labels, "factory.dev/runtime-owner", slot.id);
    },
    (actual: ReturnType<typeof observations>) => {
      const claim = actual.find(
        (item) => item.kind === "PersistentVolumeClaim" && item.metadata.name === "runtime-data",
      );
      if (!claim) throw new Error("Expected shared Source claim");
      Reflect.deleteProperty(claim.metadata.labels, "factory.dev/shared-resource");
    },
  ]) {
    const fixture = cleanupFixture(change);
    await expect(fixture.adapter.retire({ ...fixture.slot, state: "retiring" })).rejects.toThrow();
    expect(fixture.deleted).toEqual([]);
  }
});
