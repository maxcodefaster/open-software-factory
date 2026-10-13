import { expect, test } from "bun:test";
import type { ExecutionSlot } from "../../runtime-domain/src/reserve";
import {
  renderReserveResources,
  validateReserveObservation,
  slotActivationCommand,
} from "./reserve";

const slot: ExecutionSlot = {
  id: "ec253fc1-4e17-4a75-a36d-c4efef02e77e",
  role: "verification",
  state: "creating",
  runtimeHostImage: `registry.invalid/check@sha256:${"1".repeat(64)}`,
  namespace: "factory-reserve-ec253fc14e17",
  namespaceUID: null,
  podUID: null,
  claimUID: null,
  expiresAt: "2026-10-10T00:00:00Z",
  assignedAttemptID: null,
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
test("reserve uses the exact Envbox topology without repository, user capabilities or shared Docker graphs", () => {
  const resources = renderReserveResources(slot, "approved-ca");
  const payload = JSON.stringify(resources);
  expect(payload).toContain("factory-runtime-connector reserve");
  expect(payload).not.toContain("until docker info");
  expect(payload).not.toMatch(
    /parent-token|child-token|repositoryUrl|FACTORY_MODEL_API_KEY|FACTORY_FORGEJO_TOKEN/,
  );
  const pod = resources.find((value) => value.kind === "Pod");
  expect(JSON.stringify(pod?.spec.volumes)).not.toContain("docker.sock");
  expect(JSON.stringify(pod?.spec.containers[0]?.volumeMounts)).not.toContain("docker.sock");
  expect(
    pod?.spec.containers[0]?.env.find((entry) => entry.name === "CODER_MOUNTS")?.value,
  ).not.toContain("docker.sock");
  expect(resources.find((value) => value.kind === "Pod")?.spec.automountServiceAccountToken).toBe(
    false,
  );
  expect(validateReserveObservation(slot, resources, observations())).toMatchObject({
    ready: true,
    failed: false,
    podUID: "owned-Pod-slot",
    claimUID: "owned-PersistentVolumeClaim-runtime-data",
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
    (value) => value.kind === "Secret" && value.metadata.name === "runtime-assignment",
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
