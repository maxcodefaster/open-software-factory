import { expect, test } from "bun:test";
import { fixtureRuntime } from "../../../../test/fixtures/substrate";
import {
  retainedSubstrateConfiguration,
  type SubstrateInstallationConfiguration,
  substrateInstallationConfiguration,
  substrateWorkspaceConfiguration,
} from "./substrate-workspaces";

const configuration: SubstrateInstallationConfiguration = {
  deployment: "fresh-workspaces",
  database: "factory",
  connection: {
    bridge: "/usr/local/bin/factory-substrate-control",
    endpoint: "api.ate-system.svc:443",
    serverName: "api.ate-system.svc",
    caFile: "/run/factory/substrate-control/ca.pem",
    tokenFile: "/run/factory/substrate-control/token",
  },
  provisioner: {
    bridge: "/usr/local/bin/factory-substrate-control",
    endpoint: "api.ate-system.svc:443",
    serverName: "api.ate-system.svc",
    caFile: "/run/factory/substrate-control/ca.pem",
    tokenFile: "/run/factory/substrate-provisioner/token",
  },
  editorPrincipal: "user:system:serviceaccount:factory:factory-control",
  connectorURL: "wss://factory.test/internal/runtime-connect",
  factoryCAFile: "/run/factory/substrate-configuration/factory-ca.pem",
  workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
  profile: "nightly-20261109-975fb172241c",
  runtime: fixtureRuntime,
  workerSelector: {
    "factory.runtime/profile": "nightly-20261109-975fb172241c",
    "factory.dev/deployment": "owned-installation",
  },
  egressHosts: [],
};

test("Substrate installation configuration cannot select a Project or setup draft", () => {
  expect(substrateInstallationConfiguration(configuration)).toEqual(configuration);
  for (const extra of [{ projectID: crypto.randomUUID() }, { setupID: crypto.randomUUID() }])
    expect(() => substrateInstallationConfiguration({ ...configuration, ...extra })).toThrow();
});

test("Project bindings freeze their own identity under one installation configuration", () => {
  const projectID = crypto.randomUUID();
  const original = substrateWorkspaceConfiguration({ ...configuration, projectID });
  const changedImage = {
    ...original,
    workloadImage: `registry.test/native@sha256:${"b".repeat(64)}`,
    resources: { cpuMilli: 2000, memoryMiB: 4096 },
  };
  expect(retainedSubstrateConfiguration(changedImage, original)).toEqual(original);
  const another = substrateWorkspaceConfiguration({
    ...configuration,
    projectID: crypto.randomUUID(),
  });
  expect(another.projectID).not.toBe(original.projectID);
  expect(() => retainedSubstrateConfiguration(another, original)).toThrow("immutable intent");
  expect(() => substrateWorkspaceConfiguration(configuration)).toThrow();
});
