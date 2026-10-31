import { expect, test } from "bun:test";
import {
  factoryboxExportRetirementRequest,
  retireFactoryboxExports,
} from "./factorybox-export-retention";
import { factoryboxLocation } from "./factorybox-location";
import type { FactoryboxRuntimeInput } from "./factorybox-runtime";
import type { FactoryboxWorkerIdentity } from "./factorybox-worker";

const workerID = "01234567-89ab-4def-8123-456789abcdef";
const admissionID = "11234567-89ab-4def-8123-456789abcdef";
const input: FactoryboxRuntimeInput = {
  ...factoryboxLocation(workerID, admissionID),
  attemptID: workerID,
  sandboxID: `runtime-${workerID.replaceAll("-", "")}`,
  runtimeOwnerID: workerID,
  labels: {},
  runtimeHostImage: `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
  sharedSource: false,
  profile: {
    image: `registry.invalid/worker@sha256:${"b".repeat(64)}`,
    executableSHA256: "c".repeat(64),
    architecture: "arm64",
    nodeName: "source-node",
    kernel: "6.12.0",
    boundedBytes: 8 * 1024 ** 3,
    claimGiB: 32,
    retainedStore: {
      storeID: "d".repeat(32),
      initializedByPodUID: "original",
      boundedBytes: 8 * 1024 ** 3,
    },
  },
};
const identity: FactoryboxWorkerIdentity = {
  version: 1,
  namespaceUID: "namespace",
  podUID: "current",
  claimUID: "claim",
  storeID: "d".repeat(32),
  epoch: "e".repeat(32),
  bootID: "boot",
  nodeBootID: "node-boot",
  executableSHA256: input.profile.executableSHA256,
  controllerRoot: "/controller",
};
const previous = {
  admissionID: workerID.replaceAll("-", ""),
  podUID: "original",
  epoch: "f".repeat(32),
  image: input.runtimeHostImage,
  seedNamespace: null,
  terminal: { podUID: "original", phase: "Succeeded" as const },
};

test("export retirement binds the exact retired admission without accepting arbitrary filesystem paths", () => {
  const request = factoryboxExportRetirementRequest(input, identity, previous);
  expect(request.admissionID).toBe(admissionID.replaceAll("-", ""));
  expect(request.previous).toEqual(previous);
  expect(request.storeID).toBe(identity.storeID);
  expect(JSON.stringify(request)).not.toContain("/var/");
  for (const changed of [
    { ...previous, admissionID: request.admissionID },
    { ...previous, podUID: identity.podUID },
    { ...previous, epoch: identity.epoch },
    { ...previous, seedNamespace: request.admissionID },
    { ...previous, terminal: { ...previous.terminal, podUID: "replacement" } },
  ])
    expect(() => factoryboxExportRetirementRequest(input, identity, changed)).toThrow();
});

test("ordinary workers and an empty retirement inventory never dispatch cleanup", async () => {
  const run = async () => {
    throw new Error("Cleanup must not dispatch");
  };
  await retireFactoryboxExports(input, identity, [], run);
  const profile = { ...input.profile };
  delete profile.retainedStore;
  await retireFactoryboxExports({ ...input, profile }, identity, [previous], run);
});
