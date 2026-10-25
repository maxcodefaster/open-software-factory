import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executeFactoryboxOperation,
  factoryboxOperation,
  factoryboxWorkerIdentity,
  factoryboxWorkerRequest,
  inspectFactoryboxWorker,
  renderFactoryboxWorker,
} from "../../packages/runtime-kubernetes/src/factorybox-worker";

async function readJSON(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 ** 2)
      throw new Error("Expected one bounded regular JSON file");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

async function saveNew(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(resolve(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// Explicit operator use only. No app, Reserve controller or Workspace Start
// selects this path until canonical shared source has a native pause proof.
export async function main(
  args: string[],
  ports = {
    inspect: inspectFactoryboxWorker,
    execute: executeFactoryboxOperation,
  },
) {
  const [action, requestPath, identityPath, operationPath] = args;
  if (
    !requestPath ||
    !["render", "inspect", "run"].includes(action ?? "") ||
    (action === "render"
      ? args.length !== 2
      : action === "inspect"
        ? args.length !== 3
        : args.length !== 4)
  )
    throw new Error(
      "Usage: factorybox:worker render REQUEST | inspect REQUEST NEW_IDENTITY | run REQUEST IDENTITY OPERATION",
    );
  const request = factoryboxWorkerRequest.parse(await readJSON(requestPath));
  if (action === "render") {
    console.log(
      JSON.stringify(
        { apiVersion: "v1", kind: "List", items: renderFactoryboxWorker(request) },
        null,
        2,
      ),
    );
    return;
  }
  if (!identityPath) throw new Error("Missing identity path");
  if (action === "inspect") {
    const identity = await ports.inspect(request);
    await saveNew(identityPath, identity);
    console.log(JSON.stringify(identity));
    return;
  }
  if (!operationPath) throw new Error("Missing operation path");
  const identity = factoryboxWorkerIdentity.parse(await readJSON(identityPath));
  const operation = factoryboxOperation.parse(await readJSON(operationPath));
  // Create and fsync immutable intent before invoking the first external command.
  // Repeating a request requires an explicit new journal path and the same IDs.
  const journalPath = `${operationPath}.intent.json`;
  await saveNew(journalPath, { version: 1, request, identity, operation });
  try {
    const result = await ports.execute(request, identity, operation);
    await saveNew(`${operationPath}.result.json`, result);
    console.log(JSON.stringify(result));
    if (!result.confirmed) process.exitCode = 1;
  } catch (cause) {
    await saveNew(`${operationPath}.result.json`, {
      confirmed: false,
      error: cause instanceof Error ? cause.message : "Unconfirmed Factorybox operation",
    });
    throw cause;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
