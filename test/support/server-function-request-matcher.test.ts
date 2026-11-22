import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { factoryFunctionRequestMatcher } from "../fixtures/server-functions";

const commands = [
  "implementTicket",
  "startCoding",
  "resumeCoding",
  "sendCodingPrompt",
  "requestCodingChanges",
  "sendConversationMessage",
  "answerConversationQuestion",
  "setConversationMode",
  "startPersonalWorkspace",
  "startTicketWorkspace",
  "generateKnowledge",
] as const;
const reads = [
  "getBootstrap",
  "getConversation",
  "getAgentView",
  "getRuntimeAttempts",
  "getWorkspaceSource",
  "getDeveloperIDE",
  "getKnowledgeGeneration",
] as const;
const identities = Object.fromEntries(
  [...commands, ...reads].map((name, index) => [name, `owned-compiler-identity-${index}`]),
);
const originalBuildDirectory = process.env["FACTORY_BUILD_DIRECTORY"];
let directory = "";

beforeAll(async () => {
  const parent = resolve(".factory/test-results");
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(resolve(parent, "function-request-matcher-"));
  await mkdir(resolve(directory, "server"));
  // Identity-only compiler-entry double. It has no handler and cannot call the product.
  await writeFile(
    resolve(directory, "server/entry.js"),
    `export const factoryFunctions = Object.fromEntries(
      Object.entries(${JSON.stringify(identities)}).map(([name, id]) => [
        name, Object.assign(() => { throw new Error("Identity fixture cannot execute"); },
          { serverFnMeta: { id } })
      ])
    );
    export function compiledFunctionID(fn) { return fn.serverFnMeta.id; }\n`,
  );
  process.env["FACTORY_BUILD_DIRECTORY"] = directory;
});

afterAll(async () => {
  if (originalBuildDirectory === undefined) delete process.env["FACTORY_BUILD_DIRECTORY"];
  else process.env["FACTORY_BUILD_DIRECTORY"] = originalBuildDirectory;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function request(path: string, method = "POST") {
  return {
    method: () => method,
    url: () => `https://owned-navigation.test${path}`,
  };
}

test("named request matching detects compiled admissions, messages, prompts and workspace starts", async () => {
  const match = await factoryFunctionRequestMatcher(commands);
  for (const name of commands) {
    const path = `/_server/data/${identities[name]}`;
    expect(match(request(path)), name).toBe(name);
    expect(match(request(`${path}?flight=1`)), name).toBe(name);
    for (const method of ["GET", "HEAD", "OPTIONS"])
      expect(match(request(path, method)), `${method} ${name}`).toBeUndefined();
  }
});

test("named request matching accepts development file/export identities", async () => {
  const match = await factoryFunctionRequestMatcher(commands);
  for (const name of commands) {
    const id = Buffer.from(
      JSON.stringify({
        file: "/owned-isolated-root/apps/factory/src/server-functions/commands.ts",
        export: `${name}_createServerFn_handler`,
      }),
    ).toString("base64url");
    expect(match(request(`/_server/data/${id}`)), name).toBe(name);
  }
});

test("POST reads and unrelated or unknown requests are not commissioned work", async () => {
  const match = await factoryFunctionRequestMatcher(commands);
  for (const name of reads)
    expect(match(request(`/_server/data/${identities[name]}`)), name).toBeUndefined();
  const known = identities["startCoding"];
  for (const path of [
    `/api/${known}`,
    `/_server/other/${known}`,
    `/_server/data/nested/${known}`,
    `/_server/data/${known}/`,
    "/_server/data/unknown-identity",
    `/_server/data/${Buffer.from(JSON.stringify({ export: "retiredStart" })).toString("base64url")}`,
    "/conversation/message",
    "/agent/start",
    "/runtime-attempts/owned/start",
  ])
    expect(match(request(path)), path).toBeUndefined();
});

test("a missing named function fails observation setup instead of silently passing", async () => {
  for (const name of [
    "retiredStart",
    "createRequirementRevision",
    "approveRequirementRevision",
    "startTicketChange",
  ])
    await expect(factoryFunctionRequestMatcher([name])).rejects.toThrow(
      `Compiled Factory function is missing: ${name}`,
    );
});
