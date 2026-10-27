import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { CommandError } from "../../apps/factory/src/command-error";
import type { WorkspaceSourceState } from "../../packages/workspace-domain/src/source";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const cache = resolve(".factory/test-results/vite", `workspace-transport-${crypto.randomUUID()}`);
const directory = ".factory/test-results/workspace-transport";
let server: ViteDevServer, origin: string;
test.setTimeout(60_000);
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["workspace-transport.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = fixtureValue(
    fixtureValue(server.resolvedUrls, "server.resolvedUrls").local[0],
    "server.resolvedUrls!.local[0]",
  ).replace(/\/$/, "");
  await mkdir(directory, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

async function fixture(page: Page, unconfirmedEditor = false) {
  const calls: string[] = [];
  let sourceState: WorkspaceSourceState = "failed",
    sourceEpoch = 1,
    sourceReads = 0;
  let editorState: WorkspaceSourceState = "failed",
    editorEpoch = 1,
    editorReads = 0;
  const source = () => ({
    workspaceID: "10000000-0000-4000-8000-000000000003",
    label: "Owned source",
    serviceID: "owned-source",
    epoch: sourceEpoch,
    state: sourceState,
    failure: sourceState === "failed" ? "Owned source needs an explicit restart." : null,
  });
  const editor = () => ({
    serviceID: "owned-editor",
    epoch: editorEpoch,
    state: editorState,
    failure: editorState === "failed" ? "Owned editor needs an explicit restart." : null,
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      async ensurePersonalSource() {
        return source();
      },
      async getSource() {
        if (sourceState === "stop-intended" && ++sourceReads >= 2) sourceState = "stopped";
        calls.push(`source-read:${sourceState}`);
        return source();
      },
      async stopSource() {
        calls.push("source-stop");
        sourceState = "stop-intended";
      },
      async ensureSource() {
        calls.push(`source-ensure:${sourceState}`);
        if (sourceState !== "stopped") throw new Error("Source Stop must be confirmed");
        sourceState = "ready";
        sourceEpoch++;
        return source();
      },
      async getEditor() {
        if (editorState === "stop-intended" && ++editorReads >= 2) editorState = "stopped";
        calls.push(`editor-read:${editorState}`);
        return editor();
      },
      async ensureEditor() {
        calls.push(`editor-ensure:${editorState}`);
        if (editorState === "stopped") {
          editorState = "ready";
          editorEpoch++;
        }
        return editor();
      },
      async stopEditor() {
        calls.push("editor-stop");
        if (unconfirmedEditor)
          throw new CommandError(
            "unavailable",
            "Owned editor Stop is unconfirmed. Nothing was restarted.",
          );
        editorState = "stop-intended";
      },
    },
  });
  await page.route("**/api/developer-ide/access?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><p>Owned editor document</p>",
    }),
  );
  await page.goto(`${origin}/workspace-transport.html`);
  await expect(
    page.getByRole("button", { name: "Restart file access", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart editor", exact: true })).toBeVisible();
  return calls;
}

test("Workspace source restart observes confirmed Stop before preparing another access epoch", async ({
  page,
}) => {
  const calls = await fixture(page);
  await page.getByRole("button", { name: "Restart file access", exact: true }).click();
  await expect.poll(() => calls.includes("source-ensure:stopped")).toBe(true);
  expect(calls.filter((call) => call === "source-stop")).toHaveLength(1);
  const start = calls.indexOf("source-stop");
  expect(calls.slice(start, start + 4)).toEqual([
    "source-stop",
    "source-read:stop-intended",
    "source-read:stopped",
    "source-ensure:stopped",
  ]);
  expect(calls.filter((call) => call.startsWith("editor-ensure:"))).toEqual([
    "editor-ensure:failed",
  ]);
  await page.screenshot({ path: `${directory}/source-recovered-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/source-recovered-narrow.png`, fullPage: true });
});

test("Workspace editor restart waits for Stop and leaves source lifecycle alone", async ({
  page,
}) => {
  const calls = await fixture(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restart editor", exact: true }).click();
  await expect.poll(() => calls.includes("editor-ensure:stopped")).toBe(true);
  const start = calls.indexOf("editor-stop");
  expect(calls.slice(start, start + 4)).toEqual([
    "editor-stop",
    "editor-read:stop-intended",
    "editor-read:stopped",
    "editor-ensure:stopped",
  ]);
  expect(calls.some((call) => call === "source-stop" || call.startsWith("source-ensure:"))).toBe(
    false,
  );
});

test("Workspace editor never starts another epoch after an unconfirmed Stop response", async ({
  page,
}) => {
  const calls = await fixture(page, true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restart editor", exact: true }).click();
  await expect(
    page.getByText("Owned editor Stop is unconfirmed. Nothing was restarted."),
  ).toBeVisible();
  expect(calls.filter((call) => call.startsWith("editor-ensure:"))).toEqual([
    "editor-ensure:failed",
  ]);
  expect(calls.filter((call) => call === "editor-stop")).toHaveLength(1);
});
