import { expect, test } from "bun:test";
import {
  conformanceLabel,
  conformanceNamespaceRemoved,
  conformanceResources,
  ownedConformanceNamespace,
} from "./factorybox-conformance";
import { fixtureValue } from "../../test/fixtures/value";

test.each(["arm64", "amd64"] as const)(
  "Factorybox %s conformance owns a separate worker/store and uses real product preparation",
  (architecture) => {
    const owner = crypto.randomUUID();
    const resources = conformanceResources(
      owner,
      `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
      {
        image: `registry.invalid/worker@sha256:${"b".repeat(64)}`,
        executableSHA256: "c".repeat(64),
        architecture,
        nodeName: "owned-node",
        kernel: "owned-kernel",
        boundedBytes: 8589934592,
        claimGiB: 32,
      },
      "owned public certificate",
    );
    expect(resources.items.map((resource) => resource.kind)).toEqual([
      "Namespace",
      "PersistentVolumeClaim",
      "PersistentVolumeClaim",
      "Secret",
      "Secret",
      "Pod",
    ]);
    expect(
      resources.items.every((resource) => resource.metadata.labels[conformanceLabel] === owner),
    ).toBe(true);
    expect(
      resources.items.find(
        (resource) => resource.kind === "Secret" && resource.metadata.name === "registry-ca",
      )?.metadata.labels,
    ).toMatchObject({
      "factory.dev/factorybox-worker": owner,
      "factory.dev/shared-resource": "true",
    });
    const assignment = resources.items.find(
      (resource) => resource.kind === "Secret" && resource.metadata.name.startsWith("assignment-"),
    );
    expect(
      assignment &&
        "stringData" in assignment &&
        JSON.parse(
          fixtureValue(assignment.stringData["slot.json"], 'assignment.stringData["slot.json"]'),
        ),
    ).toMatchObject({
      version: 1,
      id: owner,
      role: "staging",
      images: [],
    });
    expect(resources.input.namespace).toBe(`factory-box-${owner.replaceAll("-", "")}`);
    const pod = resources.declaration.pod;
    expect(fixtureValue(pod.spec.containers[0], "pod.spec.containers[0]").name).toBe("worker");
    expect(fixtureValue(pod.spec.containers[0], "pod.spec.containers[0]").resources.limits).toEqual(
      { cpu: "3", memory: "3Gi" },
    );
    expect(pod.spec.nodeSelector["kubernetes.io/arch"]).toBe(architecture);
    expect(JSON.stringify(resources.items)).not.toMatch(/envbox|workspace_cvm|docker.sock/);
    expect(pod.spec.volumes.filter((volume) => "hostPath" in volume)).toEqual([]);
    expect(JSON.stringify(pod)).not.toContain("/lib/modules");
    const namespace = {
      metadata: {
        name: resources.input.namespace,
        uid: "original",
        labels: { [conformanceLabel]: owner },
      },
    };
    expect(ownedConformanceNamespace(namespace, owner).uid).toBe("original");
    for (const invalid of [
      { ...namespace, metadata: { ...namespace.metadata, name: "factory-system" } },
      {
        ...namespace,
        metadata: { ...namespace.metadata, labels: { [conformanceLabel]: crypto.randomUUID() } },
      },
      { ...namespace, metadata: { ...namespace.metadata, uid: "" } },
    ])
      expect(() => ownedConformanceNamespace(invalid, owner)).toThrow();
  },
);

test("lost namespace Delete output settles only through original-UID observation", () => {
  const owner = crypto.randomUUID();
  const original = {
    metadata: {
      name: `factory-box-${owner.replaceAll("-", "")}`,
      uid: "original",
      labels: { [conformanceLabel]: owner },
    },
  };
  expect(conformanceNamespaceRemoved(original, owner, "original")).toBe(false);
  expect(conformanceNamespaceRemoved(undefined, owner, "original")).toBe(true);
  expect(() =>
    conformanceNamespaceRemoved(
      { ...original, metadata: { ...original.metadata, uid: "replacement" } },
      owner,
      "original",
    ),
  ).toThrow("UID changed");
  expect(() =>
    conformanceNamespaceRemoved(
      { ...original, metadata: { ...original.metadata, labels: {} } },
      owner,
      "original",
    ),
  ).toThrow();
});
