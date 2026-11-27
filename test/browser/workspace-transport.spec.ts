import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import type { DeveloperIDEState } from "#workspace-domain/developer-ide";
import type { WorkspaceSourceState } from "#workspace-domain/source";
import { CommandError } from "../../apps/factory/src/command-error";
import { developerIDEOrigin } from "../../apps/factory/src/workspace/client";
import { test } from "../fixtures/browser-test";
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

test("the warm hidden editor selects no Workspace until it is deliberately opened", async ({
  page,
}) => {
  const workspaceID = "10000000-0000-4000-8000-000000000003";
  const source = {
    workspaceID,
    label: "Owned source",
    serviceID: "owned-source",
    epoch: 1,
    state: "ready" as const,
    failure: null,
  };
  const editor = { serviceID: "owned-editor", epoch: 1, state: "ready" as const, failure: null };
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => source,
      getSource: async () => source,
      ensureEditor: async () => editor,
      getEditor: async () => editor,
    },
  });
  const editorURL = `${developerIDEOrigin(origin, "10000000-0000-4000-8000-000000000001", 1)}/owned-editor/`;
  await page.route("**/api/developer-ide/access?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>location.replace(${JSON.stringify(editorURL)})</script>`,
    }),
  );
  await page.route(editorURL, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><output aria-label="Workspace selections">0</output><script>
        const factoryOrigin=${JSON.stringify(origin)};
        let selections=0;
        window.addEventListener("message",event=>{
          if(event.source!==parent||event.origin!==factoryOrigin||
             event.data?.type!=="factory:select-workspace")return;
          document.querySelector("output").value=String(++selections);
          parent.postMessage({type:"factory:workspace-selected",workspaceID:event.data.workspaceID},factoryOrigin);
        });
        parent.postMessage({type:"factory:ide-ready"},factoryOrigin);
      </script></body></html>`,
    }),
  );
  await page.goto(`${origin}/workspace-transport.html?hidden`);
  const frame = page.frameLocator('iframe[title="Factory IDE"]');
  const selections = frame.locator("output");
  await page.waitForLoadState("networkidle");
  expect(await selections.textContent()).toBe("0");
  await expect(page.getByRole("button", { name: "Show editor", exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/hidden-editor-no-selection.png` });
  await page.getByRole("button", { name: "Show editor", exact: true }).click();
  await expect(selections).toHaveText("1");
  await expect(page.locator("iframe")).toHaveAttribute("data-workspace-id", workspaceID);
  await page.getByRole("button", { name: "Hide editor", exact: true }).click();
  await expect(selections).toHaveText("1");
  await page.getByRole("button", { name: "Show editor", exact: true }).click();
  await expect(selections).toHaveText("2");
});

async function retainedPausedFixture(page: Page) {
  const workspaceID = "10000000-0000-4000-8000-000000000003";
  const source = {
    workspaceID,
    label: "Owned paused Workspace",
    serviceID: "owned-source",
    epoch: 1,
    state: "paused" as const,
    failure: null,
  };
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => source,
      getSource: async () => source,
      ensureSource: async () => {
        throw new Error("Selecting a paused Workspace must not prepare or replace Source");
      },
      ensureEditor: async () => ({
        serviceID: "owned-editor",
        epoch: 1,
        state: "ready" as const,
        failure: null,
      }),
    },
  });
  const editorURL = `${developerIDEOrigin(origin, "10000000-0000-4000-8000-000000000001", 1)}/owned-editor/`;
  await page.route("**/api/developer-ide/access?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>location.replace(${JSON.stringify(editorURL)})</script>`,
    }),
  );
  await page.route(editorURL, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <p>Cached file tree</p><pre>README.md\nsrc/\npackage.json</pre>
        <script>
          const factoryOrigin=${JSON.stringify(origin)};
          window.addEventListener("message",event=>{
            if(event.source!==parent||event.origin!==factoryOrigin||
               event.data?.type!=="factory:select-workspace")return;
            parent.postMessage({type:"factory:workspace-selected",workspaceID:event.data.workspaceID},factoryOrigin);
          });
          parent.postMessage({type:"factory:ide-ready"},factoryOrigin);
        </script></body></html>`,
    }),
  );
  await page.goto(`${origin}/workspace-transport.html`);
  const frame = page.locator('iframe[title="Factory IDE"]');
  await expect(frame).toHaveAttribute("data-workspace-id", workspaceID);
  await expect(
    page.frameLocator('iframe[title="Factory IDE"]').getByText("Cached file tree", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".runtime-frame")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".editor-paused-status")).toContainText(
    "Files and unsaved edits are kept.",
  );
  await expect(page.getByText("Opening Workspace…", { exact: true })).toHaveCount(0);
  return frame;
}

test("paused Source selects the retained editor without waiting for Work or App readiness", async ({
  page,
}) => {
  const frame = await retainedPausedFixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(frame).toBeVisible();
    const editorBox = await frame.boundingBox();
    const noticeBox = await page.locator(".editor-paused-status").boundingBox();
    if (!editorBox || !noticeBox) throw new Error("Paused editor or notice is missing");
    expect(noticeBox.y).toBeGreaterThanOrEqual(editorBox.y + editorBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: `${directory}/paused-source-${width}.png`, fullPage: true });
  }
  const toggle = page.getByRole("button", { name: "Hide editor", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Show editor", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame).toBeVisible();
});

test("touch can open the retained paused editor without a destructive recovery action", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    const frame = await retainedPausedFixture(page);
    await page.getByRole("button", { name: "Hide editor", exact: true }).tap();
    await page.getByRole("button", { name: "Show editor", exact: true }).tap();
    await expect(frame).toBeVisible();
    await expect(
      page
        .frameLocator('iframe[title="Factory IDE"]')
        .getByText("Cached file tree", { exact: true }),
    ).toBeVisible();
    // Let the retained cross-origin iframe paint after display:none, not only
    // pass a DOM visibility check before capturing the touch result.
    await page.evaluate(
      () =>
        new Promise<void>((complete) =>
          requestAnimationFrame(() => requestAnimationFrame(() => complete())),
        ),
    );
    await expect(page.getByRole("button", { name: /Restart (file access|Source)/ })).toHaveCount(0);
    await page.screenshot({ path: `${directory}/paused-source-touch.png`, fullPage: true });
  } finally {
    await context.close();
  }
});

async function fixture(page: Page, unconfirmedEditor = false) {
  const calls: string[] = [];
  let sourceState: WorkspaceSourceState = "failed";
  const sourceEpoch = 1;
  let editorState: DeveloperIDEState = "failed",
    editorEpoch = 1,
    editorReads = 0;
  const source = () => ({
    workspaceID: "10000000-0000-4000-8000-000000000003",
    label: "Owned source",
    serviceID: "owned-source",
    epoch: sourceEpoch,
    state: sourceState,
    failure: sourceState === "failed" ? "The current Source owner is unavailable." : null,
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
        calls.push(`source-read:${sourceState}`);
        return source();
      },
      async ensureSource() {
        calls.push(`source-ensure:${sourceState}`);
        sourceState = "ready";
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
  await expect(page.getByRole("button", { name: "Restart file access", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Retry file access", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart editor", exact: true })).toBeVisible();
  return calls;
}

test("a rejected editor keeps its recovery action right under its message", async ({ page }) => {
  const source = () => ({
    workspaceID: "10000000-0000-4000-8000-000000000003",
    label: "Owned source",
    serviceID: "owned-source",
    epoch: 1,
    state: "ready" as const,
    failure: null,
  });
  const editor = () => ({
    serviceID: "owned-editor",
    epoch: 1,
    state: "ready" as DeveloperIDEState,
    failure: null,
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      async ensurePersonalSource() {
        return source();
      },
      async getSource() {
        return source();
      },
      async ensureSource() {
        return source();
      },
      async getEditor() {
        return editor();
      },
      async ensureEditor() {
        return editor();
      },
      async stopEditor() {},
    },
  });
  await page.route("**/api/developer-ide/access?*", (route) =>
    route.fulfill({ status: 403, json: { error: "Owned editor access was rejected." } }),
  );
  await page.goto(`${origin}/workspace-transport.html`);
  const retry = page.getByRole("button", { name: "Retry editor connection", exact: true });
  await expect(retry).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const message = await page
      .getByText("Editor access was rejected. Retry opening it.", { exact: true })
      .boundingBox();
    const action = await retry.boundingBox();
    if (!message || !action) throw new Error("The rejected editor shows no message or action");
    expect(action.y).toBeGreaterThan(message.y + message.height);
    expect(action.y - (message.y + message.height)).toBeLessThan(120);
    expect(Math.abs(action.x + action.width / 2 - (message.x + message.width / 2))).toBeLessThan(
      40,
    );
    await page.screenshot({ path: `${directory}/editor-rejected-${width}.png` });
  }
});

test("native file access offers retry without a separate Source teardown", async ({ page }) => {
  await fixture(page);
  await expect(page.getByRole("button", { name: "Restart file access", exact: true })).toHaveCount(
    0,
  );
});

test("native file-access retry rechecks the same Source without restarting the editor", async ({
  page,
}) => {
  const calls = await fixture(page);
  await page.getByRole("button", { name: "Retry file access", exact: true }).click();
  await expect.poll(() => calls.includes("source-ensure:failed")).toBe(true);
  expect(calls.some((call) => call.includes("stop") && call.startsWith("source-"))).toBe(false);
  expect(calls.filter((call) => call.startsWith("source-ensure:"))).toEqual([
    "source-ensure:failed",
  ]);
  expect(calls.filter((call) => call.startsWith("editor-ensure:"))).toEqual([
    "editor-ensure:failed",
  ]);
  await page.screenshot({ path: `${directory}/source-recovered-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${directory}/source-recovered-narrow.png`, fullPage: true });
});

test("touch file-access retry offers no destructive Source action", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    const calls = await fixture(page);
    await page.screenshot({ path: `${directory}/source-unavailable-touch.png`, fullPage: true });
    await page.getByRole("button", { name: "Retry file access", exact: true }).tap();
    await expect.poll(() => calls.includes("source-ensure:failed")).toBe(true);
    expect(calls.some((call) => call.includes("stop") && call.startsWith("source-"))).toBe(false);
  } finally {
    await context.close();
  }
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
