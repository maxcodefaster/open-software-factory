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
    "inputs",
    "knowledge",
    "mcp",
    "models",
    "projects",
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
  expect(inventory.modules).toBeGreaterThan(100);
  const unclassified = inventory.calls.filter((call) => !call.decision);
  expect(unclassified).toEqual([]);
  // Assert the allowlist still reflects real sites, not a vacuous traversal.
  expect(inventory.calls).toHaveLength(6);
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

test("the separately granted embedded IDE has only explicitly classified native protocols", async () => {
  const root = resolve(import.meta.dir, "../..");
  const prefix = "deploy/theia-ide/factory-ide-extension/src/browser";
  const calls = [];
  for await (const name of new Bun.Glob("**/*.ts").scan(resolve(root, prefix))) {
    const file = `${prefix}/${name}`;
    calls.push(...browserNetworkCalls(file, await readFile(resolve(root, file), "utf8")));
  }
  expect(calls).toHaveLength(10);
  expect(calls.filter((call) => !editorProtocolDecision(call))).toEqual([]);
  const context = await readFile(resolve(root, prefix, "factory-runtime-context.ts"), "utf8");
  expect(context).toContain("__factory/workspaces/${workspaceID}/runtime");
  expect(context).not.toContain("/api/");
  expect(
    calls.some((call) => call.arguments.some((argument) => argument.includes("/_server/"))),
  ).toBe(false);
});
