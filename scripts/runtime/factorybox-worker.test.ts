import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { main } from "./factorybox-worker";

test("operator CLI persists exact intent before execution and never overwrites an uncertain journal", async () => {
  const root = resolve(".factory/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/factorybox-cli-`);
  const requestPath = `${directory}/request.json`;
  const identityPath = `${directory}/identity.json`;
  const operationPath = `${directory}/operation.json`;
  const request = {
    version: 1,
    namespace: "factorybox-test",
    podName: "worker",
    storeID: "a".repeat(32),
    trustDomainID: "b".repeat(32),
    image: `registry.invalid/worker@sha256:${"c".repeat(64)}`,
    executableSHA256: "d".repeat(64),
    architecture: "amd64",
    nodeName: "owned-node",
    kernel: "7.2.8-9-omarchy",
    boundedBytes: 4 * 1024 ** 3,
    claimGiB: 32,
  } as const;
  const identity = {
    version: 1,
    namespaceUID: "namespace",
    podUID: "pod",
    claimUID: "claim",
    storeID: request.storeID,
    epoch: "e".repeat(32),
    bootID: "boot",
    nodeBootID: "node-boot",
    executableSHA256: request.executableSHA256,
    controllerRoot: `/var/lib/sysbox/fixed-store/data/store/epochs/${"e".repeat(32)}/controller`,
  } as const;
  const operation = { action: "pause", sandboxID: "owned", snapshotID: "f".repeat(32) };
  let calls = 0;
  const ports: Parameters<typeof main>[1] = {
    inspect: async () => identity,
    execute: async (actualRequest, actualIdentity, actualOperation) => {
      calls++;
      expect(JSON.parse(await readFile(`${operationPath}.intent.json`, "utf8"))).toEqual({
        version: 1,
        request: actualRequest,
        identity: actualIdentity,
        operation: actualOperation,
      });
      throw new Error("outcome is unconfirmed");
    },
  };
  try {
    for (const [path, value] of [
      [requestPath, request],
      [identityPath, identity],
      [operationPath, operation],
    ] as const)
      await writeFile(path, JSON.stringify(value));
    await expect(main(["run", requestPath, identityPath, operationPath], ports)).rejects.toThrow(
      "unconfirmed",
    );
    const intent = await readFile(`${operationPath}.intent.json`, "utf8");
    const result = await readFile(`${operationPath}.result.json`, "utf8");
    expect(JSON.parse(result)).toEqual({ confirmed: false, error: "outcome is unconfirmed" });
    await expect(main(["run", requestPath, identityPath, operationPath], ports)).rejects.toThrow(
      "EEXIST",
    );
    expect(calls).toBe(1);
    expect(await readFile(`${operationPath}.intent.json`, "utf8")).toBe(intent);
    expect(await readFile(`${operationPath}.result.json`, "utf8")).toBe(result);
  } finally {
    await rm(directory, { recursive: true });
  }
});
