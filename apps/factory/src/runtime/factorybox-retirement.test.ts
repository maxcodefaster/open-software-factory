import { expect, test } from "bun:test";
import {
  type FactoryboxRuntimeInput,
  factoryboxSandboxID,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import type { FactoryboxWorkerIdentity } from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import { retainedFactoryboxBackingOperation } from "./factorybox-retirement";

const workerID = "11111111-2222-4333-8444-555555555555";
const attemptID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const storeRoot = "/var/lib/sysbox/fixed-store/data/store";
const current = {
  request: {
    attemptID,
    workerID,
    sandboxID: factoryboxSandboxID(attemptID),
    runtimeOwnerID: attemptID,
    namespace: `factory-box-${workerID.replaceAll("-", "")}`,
    podName: "worker-current",
    labels: {},
    sharedSource: false,
    runtimeHostImage: `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
    profile: {
      image: `registry.invalid/worker@sha256:${"b".repeat(64)}`,
      executableSHA256: "c".repeat(64),
      architecture: "arm64",
      nodeName: "owned-node",
      kernel: "7.0.14",
      boundedBytes: 8589934592,
      claimGiB: 32,
    },
  } satisfies FactoryboxRuntimeInput,
  identity: {
    version: 1,
    podUID: "current-pod",
    namespaceUID: "retained-namespace",
    claimUID: "retained-claim",
    storeID: workerID.replaceAll("-", ""),
    epoch: "f".repeat(32),
    bootID: "original-native-boot",
    nodeBootID: "original-node-boot",
    executableSHA256: "c".repeat(64),
    controllerRoot: `${storeRoot}/epochs/${"f".repeat(32)}/controller`,
  } satisfies FactoryboxWorkerIdentity,
};
const source = {
  workerID,
  sandboxID: "old-sandbox",
  identity: {
    ...current.identity,
    podUID: "original-pod",
    epoch: "e".repeat(32),
    executableSHA256: "d".repeat(64),
    controllerRoot: `${storeRoot}/epochs/${"e".repeat(32)}/controller`,
  },
  terminal: {
    kind: "operator-recovery",
    podUID: "original-pod",
    namespaceUID: current.identity.namespaceUID,
    phase: "Succeeded",
  },
};
const request = {
  sandbox_id: source.sandboxID,
  sandbox_owner: "a".repeat(32),
  input_sha256: "b".repeat(64),
};

test("retained backing uses an upgraded worker only as the metadata cleanup executor", () => {
  expect(retainedFactoryboxBackingOperation(current, source, request)).toEqual({
    action: "retire-sandbox",
    sourceRoot: source.identity.controllerRoot,
    sandboxID: request.sandbox_id,
    sandboxOwner: request.sandbox_owner,
    inputSHA256: request.input_sha256,
  });
  expect(source.identity.executableSHA256).not.toBe(current.identity.executableSHA256);
  expect(source.identity.podUID).toBe("original-pod");
});

test.each([
  "worker",
  "sandbox",
  "store",
  "claim",
  "namespace",
  "native boot",
  "node boot",
  "capacity",
  "current pod",
  "current epoch",
  "controller",
  "missing terminal",
  "running terminal",
  "foreign terminal",
  "foreign namespace terminal",
  "bootstrap terminal",
] as const)("retained backing refuses changed %s authority", (scenario) => {
  const changed = structuredClone(source);
  if (scenario === "worker") changed.workerID = crypto.randomUUID();
  if (scenario === "sandbox") changed.sandboxID = "other-sandbox";
  if (scenario === "store") changed.identity.storeID = "1".repeat(32);
  if (scenario === "claim") changed.identity.claimUID += "-replacement";
  if (scenario === "namespace") changed.identity.namespaceUID += "-replacement";
  if (scenario === "native boot") changed.identity.bootID += "-replacement";
  if (scenario === "node boot") changed.identity.nodeBootID += "-replacement";
  if (scenario === "capacity") Reflect.set(changed.identity, "boundedBytes", 8589934592);
  if (scenario === "current pod") changed.identity.podUID = current.identity.podUID;
  if (scenario === "current epoch") changed.identity.epoch = current.identity.epoch;
  if (scenario === "controller") changed.identity.controllerRoot += "/..";
  if (scenario === "missing terminal") Reflect.deleteProperty(changed.terminal, "phase");
  if (scenario === "running terminal") changed.terminal.phase = "Running";
  if (scenario === "foreign terminal") changed.terminal.podUID += "-replacement";
  if (scenario === "foreign namespace terminal") changed.terminal.namespaceUID += "-replacement";
  if (scenario === "bootstrap terminal") changed.terminal.kind = "bootstrap-recovery";
  expect(() => retainedFactoryboxBackingOperation(current, changed, request)).toThrow();
});
