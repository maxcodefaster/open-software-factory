// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Assertions inspect literal TypeScript source.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  browserNetworkCalls,
  browserProtocolDecision,
  editorProtocolDecision,
  inventoryBrowserTransports,
} from "./browser-transports";

test("the entire SPA import graph has only classified, necessary browser HTTP protocols", async () => {
  const inventory = await inventoryBrowserTransports(resolve(import.meta.dir, "../.."));
  for (const module of [
    "access",
    "agent",
    "attachments",
    "bootstrap",
    "conversations",
    "delivery",
    "environments",
    "inbox",
    "inputs",
    "knowledge",
    "learning",
    "mcp",
    "models",
    "releases",
    "review",
    "runtime",
    "setup",
    "skills",
    "tickets",
    "usage",
    "workspaces",
    "writer",
  ])
    expect(inventory.serverFunctionModules).toContain(
      `apps/factory/src/server-functions/${module}.ts`,
    );
  const unclassified = inventory.calls.filter((call) => !call.decision);
  expect(unclassified).toEqual([]);
  // Exercise the real protocol kinds without freezing their number of call sites.
  expect(inventory.calls.map((call) => call.operation)).toEqual(
    expect.arrayContaining(["fetch", "XMLHttpRequest", "apiUpload", "protocolRequest"]),
  );
}, 30_000);

test("the transport guard catches aliased helpers, native fetch, XHR, SSE and WebSockets", () => {
  const calls = browserNetworkCalls(
    "apps/factory/src/new-ui.tsx",
    `
    import { apiRequest as request } from "./api-client";
    request(schema, "/api/projects");
    fetch("/api/projects");
    window.fetch("/api/tickets");
    globalThis.fetch("/api/changes");
    new XMLHttpRequest();
    new EventSource("/api/changes/owned/agent/activity");
    new WebSocket("ws://factory/commands");
  `,
  );
  expect(calls).toHaveLength(7);
  expect(calls.every((call) => browserProtocolDecision(call) === undefined)).toBe(true);
});

test("an allowlisted module cannot introduce another logical API or helper alias", () => {
  for (const file of [
    "apps/factory/src/access/security-settings.tsx",
    "apps/factory/src/review/media-client.ts",
    "apps/factory/src/api-client.ts",
  ]) {
    const calls = browserNetworkCalls(
      file,
      `
      import { protocolRequest as send } from "./api-client";
      send(schema, "/api/changes/owned/agent/start");
      fetch("/api/projects");
    `,
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => browserProtocolDecision(call) === undefined)).toBe(true);
  }
});

test("the source-watch guard follows an immutable local endpoint through its callback", () => {
  const file = "deploy/theia-ide/factory-ide-extension/src/browser/factory-source-client.ts";
  for (const text of [
    `const eventsURL = this.url(workspaceID, "events"); new EventSource(eventsURL);`,
    `function watch(workspaceID: string) {
      const eventsURL = this.url(workspaceID, "events");
      const connect = () => new EventSource(eventsURL);
    }`,
  ]) {
    const calls = browserNetworkCalls(file, text);
    expect(calls).toHaveLength(1);
    for (const call of calls) expect(editorProtocolDecision(call)).toContain("source/file-watch");
  }
});

test("the source-watch guard rejects mutable, shadowed and different endpoints", () => {
  const file = "deploy/theia-ide/factory-ide-extension/src/browser/factory-source-client.ts";
  for (const text of [
    `let url = this.url(workspaceID, "events"); new EventSource(url);`,
    `const url = "/api/projects"; new EventSource(url);`,
    `const url = this.url(workspaceID, "commands"); new EventSource(url);`,
    `const url = this.url(workspaceID, "events");
      function connect(url: string) { new EventSource(url); }`,
    `const url = this.url(workspaceID, "events");
      { const url = "/api/projects"; new EventSource(url); }`,
    `function connect(url: string) { new EventSource(url); }`,
  ]) {
    const calls = browserNetworkCalls(file, text);
    expect(calls).toHaveLength(1);
    for (const call of calls) expect(editorProtocolDecision(call)).toBeUndefined();
  }
});

test("the separately granted embedded IDE has only explicitly classified native protocols", async () => {
  const root = resolve(import.meta.dir, "../..");
  const prefix = "deploy/theia-ide/factory-ide-extension/src/browser";
  const calls = [];
  for await (const name of new Bun.Glob("**/*.ts").scan(resolve(root, prefix))) {
    const file = `${prefix}/${name}`;
    calls.push(...browserNetworkCalls(file, await readFile(resolve(root, file), "utf8")));
  }
  expect(calls.map((call) => call.operation)).toEqual(
    expect.arrayContaining(["fetch", "EventSource", "WebSocket"]),
  );
  expect(calls.filter((call) => !editorProtocolDecision(call))).toEqual([]);
  const context = await readFile(resolve(root, prefix, "factory-runtime-context.ts"), "utf8");
  expect(context).toContain("__factory/workspaces/${workspaceID}/runtime");
  expect(context).not.toContain("/api/");
  const collaboration = await readFile(resolve(root, prefix, "factory-collaboration.ts"), "utf8");
  expect(collaboration).toContain(
    "__factory/workspaces/${identity.workspaceID}/collaboration/${action}",
  );
  for (const call of browserNetworkCalls(
    `${prefix}/factory-collaboration.ts`,
    'fetch("/api/projects")',
  ))
    expect(editorProtocolDecision(call)).toBeUndefined();
  expect(
    calls.some((call) => call.arguments.some((argument) => argument.includes("/_server/"))),
  ).toBe(false);
});
