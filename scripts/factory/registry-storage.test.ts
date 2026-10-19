import { expect, test } from "bun:test";
import { parseAllDocuments } from "yaml";
import { requireSafeRegistryStorage } from "./registry-storage";

test("the Registry manifest uses retained storage and preserves its upstream image pin", async () => {
  const documents = parseAllDocuments(
    await Bun.file(new URL("../../deploy/runtime-smoke/registry.yaml", import.meta.url)).text(),
  ).map((document) => document.toJSON());
  const claim = documents.find((document) => document.kind === "PersistentVolumeClaim");
  const registry = documents.find((document) => document.kind === "Deployment");
  expect(claim?.metadata.name).toBe("registry-data");
  expect(claim?.spec.accessModes).toEqual(["ReadWriteOnce"]);
  expect(
    registry.spec.template.spec.volumes.find((volume: { name: string }) => volume.name === "data"),
  ).toEqual({ name: "data", persistentVolumeClaim: { claimName: "registry-data" } });
  expect(registry.spec.strategy).toEqual({ type: "Recreate" });
  expect(registry.spec.template.spec.containers[0].image).toBe(
    "docker.io/library/registry:3@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33",
  );
});

test("publication refuses destructive temporary-storage conversion before restarting the Registry", () => {
  const labels = { "app.kubernetes.io/name": "open-factory-registry" };
  const current = {
    metadata: { name: "registry", uid: "owned-registry", labels },
    spec: { template: { spec: { volumes: [{ name: "data", emptyDir: {} }] } } },
  };
  expect(() => requireSafeRegistryStorage(current, null)).toThrow("Preserve its existing data");
});

test("new Registry setup and retained owned storage are accepted, but missing or foreign claims are not", () => {
  const labels = {
    "app.kubernetes.io/name": "open-factory-registry",
    "app.kubernetes.io/managed-by": "open-software-factory",
  };
  const pvc = { metadata: { name: "registry-data", uid: "owned-claim", labels } };
  const current = {
    metadata: { name: "registry", uid: "owned-registry", labels },
    spec: {
      template: {
        spec: {
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: "registry-data" } }],
        },
      },
    },
  };
  expect(() => requireSafeRegistryStorage(null, null)).not.toThrow();
  expect(() => requireSafeRegistryStorage(current, pvc)).not.toThrow();
  expect(() => requireSafeRegistryStorage(current, null)).toThrow("missing");
  expect(() =>
    requireSafeRegistryStorage(current, { metadata: { ...pvc.metadata, labels: {} } }),
  ).toThrow("foreign");
});
