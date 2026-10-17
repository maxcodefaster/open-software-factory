import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  conformanceLabel,
  conformanceManifest,
  ownedConformanceResource,
} from "./conformance-resources";

test("conformance owns unique Pod/claim, keeps the shared namespace and registry intact", async () => {
  const owner = crypto.randomUUID();
  const template = await readFile("deploy/runtime-smoke/envbox.yaml", "utf8");
  const resources = conformanceManifest(
    template,
    owner,
    `registry.invalid/host@sha256:${"a".repeat(64)}`,
  );
  expect(resources.map((resource) => resource.kind)).toEqual(["PersistentVolumeClaim", "Pod"]);
  expect(
    resources.every(
      (resource) =>
        resource.metadata.name === `conformance-${owner}` &&
        resource.metadata.labels[conformanceLabel] === owner,
    ),
  ).toBe(true);
  const pod = resources[1]!;
  expect(
    pod.spec.volumes.find((volume: { name: string }) => volume.name === "runtime-data")
      .persistentVolumeClaim.claimName,
  ).toBe(`conformance-${owner}`);
  expect(
    pod.spec.volumes.find((volume: { name: string }) => volume.name === "registry-ca").secret
      .secretName,
  ).toBe("registry-tls");
  expect(
    ownedConformanceResource(
      {
        metadata: {
          name: `conformance-${owner}`,
          uid: "original",
          labels: { [conformanceLabel]: owner },
        },
      },
      owner,
    ).uid,
  ).toBe("original");
  for (const name of ["registry", "runtime-data", "envbox-smoke"])
    expect(() =>
      ownedConformanceResource(
        { metadata: { name, uid: "shared", labels: { [conformanceLabel]: owner } } },
        owner,
      ),
    ).toThrow("ownership");
});
