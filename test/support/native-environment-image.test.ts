import { expect, test } from "bun:test";
import { runtimeArtifactNames } from "../../scripts/factory/artifacts";
import { nativeEnvironmentImage } from "../fixtures/native-environment-image";
import { nativeInstallationFixture } from "../fixtures/native-installation";
import { fixtureValue } from "../fixtures/value";

const prefix = "registry.test/open-factory";
const artifacts = Object.fromEntries(
  runtimeArtifactNames.map((role) => [role, `${prefix}/${role}@sha256:${"a".repeat(64)}`]),
);
const configuration = {
  ...nativeInstallationFixture(),
  workloadImage: artifacts["substrate-runtime"] ?? "",
  egressHosts: ["registry.test"],
};
test("native Environment proof uses the published immutable Starter image and admitted TLS origin", () => {
  expect(nativeEnvironmentImage(artifacts, configuration)).toBe(
    fixtureValue(artifacts["starter-work"], "artifacts.starter-work"),
  );
});
test("native Environment image refuses mutable, unadmitted or non-TLS-registry references", () => {
  for (const image of [
    "registry.test/user/data:latest",
    `127.0.0.1/open-factory/work@sha256:${"a".repeat(64)}`,
    `registry.test:5000/open-factory/work@sha256:${"a".repeat(64)}`,
    `registry.localhost/open-factory/work@sha256:${"a".repeat(64)}`,
    `other.registry.test/open-factory/work@sha256:${"a".repeat(64)}`,
    `${prefix}/../foreign@sha256:${"a".repeat(64)}`,
  ])
    expect(() =>
      nativeEnvironmentImage({ ...artifacts, "starter-work": image }, configuration),
    ).toThrow();
  expect(() => nativeEnvironmentImage(artifacts, { ...configuration, egressHosts: [] })).toThrow();
  expect(() =>
    nativeEnvironmentImage(artifacts, { ...configuration, egressHosts: ["*.test"] }),
  ).toThrow();
});
test("native Environment image rejects another Actor generation or an obsolete artifact role", () => {
  expect(() =>
    nativeEnvironmentImage(
      { ...artifacts, "substrate-runtime": `${prefix}/other@sha256:${"b".repeat(64)}` },
      configuration,
    ),
  ).toThrow("exact Actor image");
  expect(() =>
    nativeEnvironmentImage(
      { ...artifacts, feature: `${prefix}/feature@sha256:${"b".repeat(64)}` },
      configuration,
    ),
  ).toThrow();
});
