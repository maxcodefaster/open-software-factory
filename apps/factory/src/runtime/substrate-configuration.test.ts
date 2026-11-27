import { expect, test } from "bun:test";
import { fixtureRuntime } from "../../../../test/fixtures/substrate";
import { substrateResourceReservation } from "./substrate-resources";
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

test("Substrate installation configuration cannot select a Project, setup draft or retired producer", () => {
  expect(substrateInstallationConfiguration(configuration)).toEqual({
    ...configuration,
    resources: { cpuMilli: 1500, memoryMiB: 3072 },
  });
  for (const extra of [
    { projectID: crypto.randomUUID() },
    { setupID: crypto.randomUUID() },
    { prebuildRegistry: "registry.test" },
  ])
    expect(() => substrateInstallationConfiguration({ ...configuration, ...extra })).toThrow();
});

test("fresh native defaults are explicit without changing retained Actor limits", () => {
  const projectID = crypto.randomUUID();
  const retained = substrateWorkspaceConfiguration({ ...configuration, projectID });
  const desired = substrateWorkspaceConfiguration({
    ...substrateInstallationConfiguration(configuration),
    projectID,
  });
  expect(desired.resources).toEqual({ cpuMilli: 1500, memoryMiB: 3072 });
  expect(substrateResourceReservation(desired)).toEqual({ cpuMilli: 1500, memoryMiB: 3072 });
  expect(retainedSubstrateConfiguration(desired, retained)).toEqual(retained);
  expect(substrateResourceReservation(retained)).toEqual({ cpuMilli: 1500, memoryMiB: 1024 });
  expect(
    substrateInstallationConfiguration({
      ...configuration,
      resources: { cpuMilli: 2000, memoryMiB: 4096 },
    }).resources,
  ).toEqual({ cpuMilli: 2000, memoryMiB: 4096 });
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

test("admitting new egress hosts keeps retained owners on their original exact policy", () => {
  const original = substrateWorkspaceConfiguration({
    ...configuration,
    projectID: crypto.randomUUID(),
    egressHosts: ["mcr.microsoft.com"],
  });
  const admitted = {
    ...original,
    egressHosts: ["mcr.microsoft.com", "westeurope.data.mcr.microsoft.com"],
  };
  expect(retainedSubstrateConfiguration(admitted, original)).toEqual(original);
  expect(original.egressHosts).toEqual(["mcr.microsoft.com"]);
  expect(admitted.egressHosts).toEqual(["mcr.microsoft.com", "westeurope.data.mcr.microsoft.com"]);
  for (const egressHosts of [[], ["westeurope.data.mcr.microsoft.com"]])
    expect(() => retainedSubstrateConfiguration({ ...original, egressHosts }, original)).toThrow(
      "immutable intent",
    );
  expect(() =>
    retainedSubstrateConfiguration(
      {
        ...admitted,
        connection: { ...admitted.connection, endpoint: "another-cluster.invalid:443" },
      },
      original,
    ),
  ).toThrow("immutable intent");
});
