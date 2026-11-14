import { expect, test } from "bun:test";
import { nativeInstallationFixture } from "../fixtures/native-installation";
import { nativeRegistryInputs } from "../fixtures/native-registry-inputs";

const owner = "11111111-1111-4111-8111-111111111111";
const prefix = `registry.test/open-factory/native-fixtures/${owner}`;
const configuration = {
  ...nativeInstallationFixture(),
  prebuildRegistry: "registry.test",
  egressHosts: ["registry.test"],
};
const deployment = configuration.workerSelector["factory.dev/deployment"];
if (!deployment) throw Error("Owned native fixture deployment is missing");
const fixture = {
  owner,
  deployment,
  host: "registry.test",
  username: "owned",
  password: "owned-private",
  certificate: "-----BEGIN CERTIFICATE-----\nowned\n-----END CERTIFICATE-----",
  developmentImage: `${prefix}/development@sha256:${"a".repeat(64)}`,
  feature: `${prefix}/feature@sha256:${"b".repeat(64)}`,
};
test("native registry inputs use exact fixture-owned immutable images and the admitted TLS origin", () => {
  expect(nativeRegistryInputs(fixture, configuration)).toEqual(fixture);
});
test("native registry input refuses another deployment, host, namespace, mutable image or private key", () => {
  for (const changed of [
    { ...fixture, deployment: "other" },
    { ...fixture, host: "127.0.0.1" },
    { ...fixture, host: "registry.test:5000" },
    { ...fixture, developmentImage: "registry.test/user/data:latest" },
    { ...fixture, feature: `registry.test/other/feature@sha256:${"b".repeat(64)}` },
    { ...fixture, developmentImage: `${prefix}/../foreign@sha256:${"a".repeat(64)}` },
    { ...fixture, certificate: `${fixture.certificate}\n-----BEGIN PRIVATE KEY-----` },
  ])
    expect(() => nativeRegistryInputs(changed, configuration)).toThrow();
  expect(() => nativeRegistryInputs(fixture, { ...configuration, egressHosts: [] })).toThrow();
});
