import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { developerIDEOrigin } from "../../apps/factory/src/developer-ide-origin";
import { previewBridge } from "../../apps/factory/src/review/preview-bridge";
import { previewAttachmentFailure } from "../../apps/factory/src/runtime/preview-attachment-failure";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { protocolFailure } from "../../apps/factory/src/server/protocols/failure";
import { observeBrowserErrors } from "../fixtures/browser-errors";
import { test } from "../fixtures/browser-test";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const evidence = ".factory/test-results/runtime-attachment";
const cacheDir = resolve(".factory/test-results/vite", `runtime-attachment-${crypto.randomUUID()}`);
const attemptID = "11111111-1111-4111-8111-111111111111";
let frontend: ViteDevServer;
let origin: string;
let bridgeGate: ReturnType<typeof Promise.withResolvers<void>>;
let imageGate: ReturnType<typeof Promise.withResolvers<void>>;
let documents = 0;
test.setTimeout(45_000);
test.beforeAll(async () => {
  frontend = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir,
    publicDir: resolve("apps/factory/public"),
    plugins: [
      {
        name: "owned-source-action-availability",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            importer?.endsWith("/workspace-sharing.tsx") &&
            [
              "./server-functions/workspaces",
              "./server-functions/runtime",
              "./server-functions/writer",
            ].includes(source)
          )
            return resolve("test/fixtures/workspace-sharing-commands.ts");
        },
      },
      factoryFixtureStart(),
      solid({ ssr: false }),
      {
        name: "owned-preview-document",
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            const path = request.url?.split("?")[0];
            if (
              [
                "/document",
                "/failed-document",
                "/starting-document",
                "/late-failure-document",
                "/app-503-document",
              ].includes(path ?? "")
            ) {
              documents++;
              if (path === "/late-failure-document" && documents === 1) {
                const failure = previewAttachmentFailure(
                  new Request(`${origin}/runtime/${attemptID}/preview/app/`, {
                    headers: { "sec-fetch-mode": "navigate" },
                  }),
                  origin,
                  Response.json({ error: "Runtime transport is not ready" }, { status: 503 }),
                );
                response.writeHead(failure.status, Object.fromEntries(failure.headers));
                // Deliver the real failed document first. The test posts its
                // failure from that same frame only after iframe load fires.
                return response.end((await failure.text()).replace(/<script>.*?<\/script>/s, ""));
              }
              if (path === "/starting-document" && documents <= 2) {
                const navigation = new Request(`${origin}/runtime/${attemptID}/preview/app/`, {
                  headers: { "sec-fetch-mode": "navigate" },
                });
                const failure = previewAttachmentFailure(
                  navigation,
                  origin,
                  protocolFailure(navigation, new Error("channel request failed")),
                );
                response.writeHead(failure.status, Object.fromEntries(failure.headers));
                return response.end(await failure.text());
              }
              if (path === "/failed-document" && documents === 1) {
                const failure = previewAttachmentFailure(
                  new Request(`${origin}/runtime/${attemptID}/preview/app/`, {
                    headers: { "sec-fetch-mode": "navigate" },
                  }),
                  origin,
                  Response.json({ error: "Factory command failed" }, { status: 500 }),
                );
                response.writeHead(failure.status, Object.fromEntries(failure.headers));
                return response.end(await failure.text());
              }
              if (path === "/app-503-document") {
                response.writeHead(503, {
                  "content-type": "text/html",
                  "cache-control": "no-store",
                });
                return response.end(
                  '<!doctype html><html><body><p>Service Unavailable from the App</p><script src="/bridge.js"></script></body></html>',
                );
              }
              response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
              return response.end(
                '<!doctype html><html><body><p>Usable Preview document</p><img src="/slow-image" alt="Pending illustration"><script src="/bridge.js"></script></body></html>',
              );
            }
            if (path === "/bridge.js") {
              await bridgeGate.promise;
              response.writeHead(200, { "content-type": "text/javascript" });
              return response.end(previewBridge(origin));
            }
            if (path === "/slow-image") {
              await imageGate.promise;
              response.writeHead(404);
              return response.end();
            }
            next();
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  await frontend.listen();
  origin = fixtureValue(
    fixtureValue(frontend.resolvedUrls, "frontend.resolvedUrls").local[0],
    "frontend.resolvedUrls!.local[0]",
  ).replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(() => {
  bridgeGate = Promise.withResolvers<void>();
  imageGate = Promise.withResolvers<void>();
  documents = 0;
});
test.afterEach(() => {
  bridgeGate.resolve();
  imageGate.resolve();
});
test.afterAll(async () => {
  await frontend?.close();
  await rm(cacheDir, { recursive: true, force: true });
});

test("Ticket source actions require confirmed file access and a human writer", async ({ page }) => {
  for (const [query, explanation] of [
    ["source-access=unavailable", "File access is not ready"],
    ["source-access=unknown", "File access is unavailable"],
    ["source-access=mismatch", "File access is unavailable"],
    ["writer-access=unknown", "Editing status unavailable"],
    ["writer-access=agent-preparing", "Agent preparing"],
    ["writer-access=agent", "Agent working"],
    ["writer-access=agent&writer-settled=1", "Agent work settled"],
    ["writer-access=handoff", "Editing handoff is not confirmed"],
    ["writer-access=unassigned", "Take over editing"],
    ["writer-denied=1", "Take over editing"],
    ["writer-stop-pending=1", "Agent Stop is unconfirmed"],
    ["source-access=unavailable&compute-access=starting", "Compute is starting or resuming"],
  ] as const) {
    await page.goto(
      `${origin}/workspace-sharing.html?workspace=workspace-source-access-ticket&${query}`,
    );
    await page.getByRole("button", { name: "Load available Workspaces" }).click();
    await expect(
      page.getByRole("button", { name: "Enable shared editing", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Submit saved checkout", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("status", { name: "Workspace action availability" })).toContainText(
      explanation,
    );
  }
  await page.goto(`${origin}/workspace-sharing.html?workspace=workspace-source-access-ticket`);
  await page.getByRole("button", { name: "Load available Workspaces" }).click();
  await expect(
    page.getByRole("button", { name: "Enable shared editing", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Submit saved checkout", exact: true }),
  ).toBeEnabled();
  await page.goto(
    `${origin}/workspace-sharing.html?workspace=workspace-source-access-ticket&compute-access=starting`,
  );
  await page.getByRole("button", { name: "Load available Workspaces" }).click();
  await expect(
    page.getByRole("button", { name: "Enable shared editing", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Submit saved checkout", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status", { name: "Workspace action availability" })).toContainText(
    "The Ticket Workspace must be running",
  );
});

test("a later unavailable writer read withdraws Ticket actions without changing authority", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`${origin}/workspace-sharing.html?workspace=workspace-source-access-ticket`);
  await page.getByRole("button", { name: "Load available Workspaces" }).click();
  const submit = page.getByRole("button", { name: "Submit saved checkout", exact: true });
  await expect(submit).toBeEnabled();
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.set("writer-access", "unknown");
    history.replaceState(null, "", url);
  });
  await page.clock.fastForward(5000);
  await expect(submit).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Enable shared editing", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status", { name: "Workspace action availability" })).toContainText(
    "Editing status unavailable",
  );
  await page.screenshot({
    path: `${evidence}/source-actions-writer-unavailable.png`,
    fullPage: true,
  });
});

async function unavailableSourceFixture(page: Page) {
  const workspaceID = "10000000-0000-4000-8000-000000000003";
  let reachable = false;
  let checks = 0;
  const source = () => ({
    workspaceID,
    label: "Owned source",
    serviceID: "owned-source",
    epoch: 1,
    state: reachable ? ("ready" as const) : ("preparing" as const),
    failure: reachable
      ? null
      : "The current Source owner is frozen or unavailable. Compute was not started; keep your editor buffer.",
  });
  const editor = { serviceID: "owned-editor", epoch: 1, state: "ready" as const, failure: null };
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => source(),
      getSource: async () => source(),
      async ensureSource() {
        checks++;
        return source();
      },
      ensureEditor: async () => editor,
      getEditor: async () => editor,
    },
  });
  const editorURL = `${developerIDEOrigin(origin, "10000000-0000-4000-8000-000000000001", 1)}/source-access-editor/`;
  let editorLoads = 0;
  await page.route("**/api/developer-ide/access?*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }),
  );
  await page.route(editorURL, (route) => {
    editorLoads++;
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><textarea aria-label="Retained editor buffer">unsaved draft</textarea><script>
        const factoryOrigin=${JSON.stringify(origin)};
        parent.postMessage({type:"factory:ide-ready"},factoryOrigin);
        addEventListener("message",event=>{
          if(event.origin===factoryOrigin&&event.source===parent&&event.data?.type==="factory:select-workspace")
            parent.postMessage({type:"factory:workspace-selected",workspaceID:event.data.workspaceID},factoryOrigin);
        });
      </script>`,
    });
  });
  await page.goto(`${origin}/workspace-transport.html`);
  const frame = page.locator('iframe[title="Factory IDE"]');
  const embedded = await (await frame.elementHandle())?.contentFrame();
  if (!embedded) throw Error("Owned source access editor is unavailable");
  await embedded.goto(editorURL);
  return {
    workspaceID,
    checks: () => checks,
    editorLoads: () => editorLoads,
    makeReachable: () => {
      reachable = true;
    },
  };
}

test("unavailable Source Retry reports every check without claiming a freeze or replacing the editor", async ({
  page,
}) => {
  const fixture = await unavailableSourceFixture(page);
  await expect(
    page.getByText("The Workspace may still be starting or reconnecting", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("The current Source owner is frozen", { exact: false })).toHaveCount(
    0,
  );
  const retry = page.getByRole("button", { name: "Retry file access", exact: true });
  for (let check = 1; check <= 3; check++) {
    await retry.focus();
    await retry.press("Enter");
    await expect.poll(fixture.checks).toBe(check);
    await expect(page.getByRole("status", { name: "File access check" })).toContainText(
      `File access check ${check}: still unavailable.`,
    );
    await expect(retry).toBeEnabled();
    await expect(page.locator(".editor-source-status")).toHaveCount(0);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: `${evidence}/source-retry-unavailable-${width}.png`,
      fullPage: true,
    });
  }
  fixture.makeReachable();
  await retry.click();
  await expect(page.locator('iframe[title="Factory IDE"]')).toHaveAttribute(
    "data-workspace-id",
    fixture.workspaceID,
  );
  await expect(
    page.frameLocator('iframe[title="Factory IDE"]').getByLabel("Retained editor buffer"),
  ).toHaveValue("unsaved draft");
  expect(fixture.editorLoads()).toBe(1);
});

test("unavailable Source actions and independent Retry remain clear on touch", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(
      `${origin}/workspace-sharing.html?workspace=workspace-source-access-ticket&writer-access=unknown`,
    );
    await page.getByRole("button", { name: "Load available Workspaces" }).tap();
    await expect(
      page.getByRole("button", { name: "Enable shared editing", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Submit saved checkout", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("status", { name: "Workspace action availability" })).toContainText(
      "Editing status unavailable",
    );
    await page.screenshot({
      path: `${evidence}/source-actions-writer-unavailable-touch.png`,
      fullPage: true,
    });
    const fixture = await unavailableSourceFixture(page);
    const retry = page.getByRole("button", { name: "Retry file access", exact: true });
    await expect(retry).toBeEnabled();
    expect(
      await retry.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await retry.tap();
    await expect.poll(fixture.checks).toBe(1);
    await expect(page.getByRole("status", { name: "File access check" })).toContainText(
      "File access check 1: still unavailable.",
    );
    await page.screenshot({
      path: `${evidence}/source-retry-unavailable-touch.png`,
      fullPage: true,
    });
    expect(fixture.editorLoads()).toBe(1);
  } finally {
    await context.close();
  }
});

test("Preview accepts its parsed document, not a spoofed sender, while an image remains pending", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`${origin}/runtime-attachment.html`, { waitUntil: "domcontentloaded" });
  const connection = page.getByRole("status", { name: "Preview connection" });
  await expect(connection).toBeVisible();
  await page.evaluate(
    (runtimeOrigin) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: runtimeOrigin,
          source: window,
          data: { type: "factory-preview-document-ready" },
        }),
      ),
    appRuntimeOrigin(origin, attemptID, "app"),
  );
  await expect(connection).toBeVisible();
  await page.evaluate(() => {
    function fixtureValue<T>(value: T, description: string): NonNullable<T> {
      if (value === undefined || value === null)
        throw new Error(`Missing fixture value: ${description}`);
      return value;
    }
    return window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://unrelated.example",
        source: fixtureValue(
          document.querySelector<HTMLIFrameElement>('iframe[title="Factory Preview"]'),
          "document.querySelector<HTMLIFrameElement>('iframe[title=\"Factory Preview\"]')",
        ).contentWindow,
        data: { type: "factory-preview-document-ready" },
      }),
    );
  });
  await expect(connection).toBeVisible();
  bridgeGate.resolve();
  await expect(connection).toHaveCount(0, { timeout: 3000 });
  await expect(
    page.frameLocator('iframe[title="Factory Preview"]').getByText("Usable Preview document"),
  ).toBeVisible();
  expect(documents).toBe(1);
  await page.clock.fastForward(31_000);
  await expect(connection).toHaveCount(0);
  expect(documents).toBe(1);
  await page.screenshot({ path: `${evidence}/preview-parsed-before-image.png` });
});

test("a slow initial document stays loading and can finish without a reload", async ({
  browser,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  for (const [label, width, touch] of [
    ["desktop", 1440, false],
    ["narrow", 390, false],
    ["touch", 390, true],
  ] as const) {
    documents = 0;
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: touch,
      isMobile: touch,
      reducedMotion: "reduce",
    });
    const documentGate = Promise.withResolvers<void>();
    try {
      const page = await context.newPage();
      const errors = observeBrowserErrors(page);
      await page.clock.install();
      await page.route("**/document", async (route) => {
        documents++;
        await documentGate.promise;
        await route
          .fulfill({
            contentType: "text/html",
            body: '<!doctype html><p>Usable Preview document</p><script src="/bridge.js"></script>',
          })
          .catch(() => {});
      });
      await page.goto(`${origin}/runtime-attachment.html`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => documents).toBe(1);
      await page.clock.fastForward(31_000);
      const connection = page.getByRole("status", { name: "Preview connection" });
      await expect(connection).toContainText("Preview is taking longer to open");
      await expect(connection).not.toContainText("Could not open");
      await expect(page.locator(".runtime-frame")).toHaveAttribute("aria-busy", "true");
      const reload = connection.getByRole("button", { name: "Reload view", exact: true });
      await expect(reload).toBeVisible();
      if (touch)
        expect(
          await reload.evaluate((element) => element.getBoundingClientRect().height),
        ).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `${evidence}/preview-slow-document-${label}.png` });
      documentGate.resolve();
      await expect(connection).toHaveCount(0, { timeout: 3000 });
      await expect(
        page.frameLocator('iframe[title="Factory Preview"]').getByText("Usable Preview document"),
      ).toBeVisible();
      await expect(page.locator(".runtime-frame")).toHaveAttribute("aria-busy", "false");
      await expect(page.locator("iframe")).toHaveAttribute("data-runtime-attempt-id", attemptID);
      await page.clock.fastForward(31_000);
      expect(documents).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      documentGate.resolve();
      await context.close();
    }
  }
});

test("a delivered Preview is visible while deferred App modules are still loading", async ({
  browser,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  for (const [label, width, touch] of [
    ["desktop", 1440, false],
    ["narrow", 390, false],
    ["touch", 390, true],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: touch,
      isMobile: touch,
      reducedMotion: "reduce",
    });
    const moduleGate = Promise.withResolvers<void>();
    let modules = 0;
    try {
      const page = await context.newPage();
      await page.route("**/document", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><body><p>Usable Preview document</p><script type="module" src="/delayed-module.js"></script><p>Final document content</p><script src="/bridge.js"></script></body></html>',
        }),
      );
      await page.route("**/delayed-module.js", async (route) => {
        modules++;
        await moduleGate.promise;
        await route.fulfill({ contentType: "text/javascript", body: "" }).catch(() => {});
      });
      await page.goto(`${origin}/runtime-attachment.html`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => modules).toBe(1);
      await expect(page.getByRole("status", { name: "Preview connection" })).toHaveCount(0, {
        timeout: 3000,
      });
      const preview = page.frameLocator('iframe[title="Factory Preview"]');
      await expect(preview.getByText("Final document content")).toBeVisible();
      await expect(page.locator(".runtime-frame")).toHaveAttribute("aria-busy", "false");
      expect(modules).toBe(1);
      await page.screenshot({ path: `${evidence}/preview-before-deferred-module-${label}.png` });
    } finally {
      moduleGate.resolve();
      await context.close();
    }
  }
});

test("reloading a delayed Preview rearms its waiting hint without automatic replay", async ({
  page,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  const documentGate = Promise.withResolvers<void>();
  await page.clock.install();
  await page.route("**/document", async (route) => {
    documents++;
    await documentGate.promise;
    await route
      .fulfill({
        contentType: "text/html",
        body: '<!doctype html><p>Usable Preview document</p><script src="/bridge.js"></script>',
      })
      .catch(() => {});
  });
  try {
    await page.goto(`${origin}/runtime-attachment.html`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => documents).toBe(1);
    await page.clock.fastForward(31_000);
    const connection = page.getByRole("status", { name: "Preview connection" });
    await connection.getByRole("button", { name: "Reload view", exact: true }).click();
    await expect.poll(() => documents).toBe(2);
    await expect(connection).toHaveText("Opening Preview…");
    await page.clock.fastForward(29_000);
    await expect(connection.getByRole("button", { name: "Reload view" })).toHaveCount(0);
    await page.clock.fastForward(2000);
    await expect(connection).toContainText("Preview is taking longer to open");
    await expect(page.locator(".runtime-frame")).toHaveAttribute("aria-busy", "true");
    expect(documents).toBe(2);
    documentGate.resolve();
    await expect(connection).toHaveCount(0, { timeout: 3000 });
    await expect(
      page.frameLocator('iframe[title="Factory Preview"]').getByText("Usable Preview document"),
    ).toBeVisible();
    await expect(page.locator("iframe")).toHaveAttribute("data-runtime-attempt-id", attemptID);
  } finally {
    documentGate.resolve();
  }
});

test("a cold App reconnects its initial Preview document without another Start", async ({
  page,
  browser,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  await page.clock.install();
  for (const width of [1440, 390]) {
    documents = 0;
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/runtime-attachment.html?starting=1`);
    const connection = page.getByRole("status", { name: "Preview connection" });
    await expect(connection).toContainText("Preview could not be reached. Reconnecting", {
      timeout: 3000,
    });
    expect(documents).toBe(1);
    await page.screenshot({ path: `${evidence}/preview-cold-connecting-${width}.png` });
    await page.clock.fastForward(1000);
    await expect.poll(() => documents).toBe(2);
    await expect(connection).toContainText("Reconnecting");
    await page.clock.fastForward(2000);
    await expect(connection).toHaveCount(0, { timeout: 3000 });
    await expect(
      page.frameLocator('iframe[title="Factory Preview"]').getByText("Usable Preview document"),
    ).toBeVisible();
    await expect(page.locator("iframe")).toHaveAttribute("data-runtime-attempt-id", attemptID);
    expect(documents).toBe(3);
    await page.clock.fastForward(31_000);
    expect(documents).toBe(3);
    await page.screenshot({ path: `${evidence}/preview-cold-connected-${width}.png` });
  }
  const touch = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    documents = 0;
    const phone = await touch.newPage();
    await phone.clock.install();
    await phone.goto(`${origin}/runtime-attachment.html?starting=1`);
    const connection = phone.getByRole("status", { name: "Preview connection" });
    const reload = connection.getByRole("button", { name: "Reload view", exact: true });
    await expect(connection).toContainText("Reconnecting");
    expect(
      await reload.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await phone.screenshot({ path: `${evidence}/preview-cold-connecting-touch.png` });
    await reload.tap();
    await expect.poll(() => documents).toBe(2);
    await expect(connection).toContainText("Reconnecting");
    await phone.clock.fastForward(1000);
    await expect(connection).toHaveCount(0, { timeout: 3000 });
    expect(documents).toBe(3);
  } finally {
    await touch.close();
  }
});

test("a failed Preview document can report after iframe load without losing its initial retry", async ({
  page,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  await page.clock.install();
  await page.goto(`${origin}/runtime-attachment.html?late-failure=1`);
  const connection = page.getByRole("status", { name: "Preview connection" });
  const errorDocument = page
    .frameLocator('iframe[title="Factory Preview"]')
    .getByText("Could not open Preview. Reload this view to retry.", { exact: true });
  await expect(errorDocument).toBeVisible();
  await errorDocument.evaluate((_, factoryOrigin) => {
    window.parent.postMessage(
      { type: "factory-preview-document-failed", retryable: true },
      factoryOrigin,
    );
  }, origin);
  await expect(connection).toContainText("Reconnecting");
  expect(documents).toBe(1);
  await page.screenshot({ path: `${evidence}/preview-failure-after-load.png` });
  await page.clock.fastForward(1000);
  await expect(connection).toHaveCount(0, { timeout: 3000 });
  await expect(
    page.frameLocator('iframe[title="Factory Preview"]').getByText("Usable Preview document"),
  ).toBeVisible();
  expect(documents).toBe(2);
  await expect(page.locator("iframe")).toHaveAttribute("data-runtime-attempt-id", attemptID);
  await page.screenshot({ path: `${evidence}/preview-reconnected-after-load.png` });
});

test("an inactive Preview does not keep retrying its unavailable attachment", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${origin}/runtime-attachment.html?starting=1&inactive=1`);
  const connection = page.getByRole("status", { name: "Preview connection" });
  await expect(connection).toContainText("Reconnecting");
  await page.clock.fastForward(31_000);
  expect(documents).toBe(1);
});

test("a previously attached Preview never reloads automatically over human work", async ({
  page,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  await page.clock.install();
  await page.goto(`${origin}/runtime-attachment.html`);
  const connection = page.getByRole("status", { name: "Preview connection" });
  await expect(connection).toHaveCount(0);
  await page
    .frameLocator('iframe[title="Factory Preview"]')
    .getByText("Usable Preview document")
    .evaluate((_, factoryOrigin) => {
      window.parent.postMessage(
        { type: "factory-preview-document-failed", retryable: true },
        factoryOrigin,
      );
    }, origin);
  await expect(connection).toContainText("Could not open Preview.");
  await page.clock.fastForward(31_000);
  expect(documents).toBe(1);
});

test("a permanent cross-origin Preview failure reloads only on request", async ({
  page,
  browser,
}) => {
  await page.clock.install();
  for (const width of [1440, 390]) {
    documents = 0;
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/runtime-attachment.html?connection-error=1`);
    const connection = page.getByRole("status", { name: "Preview connection" });
    await expect(connection).toContainText("Could not open Preview.");
    await expect(connection).toContainText("Factory refused the Preview request");
    await expect(page.locator('iframe[title="Factory Preview"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.locator('iframe[title="Factory Preview"]')).toBeHidden();
    await page.clock.fastForward(31_000);
    await expect(connection).toBeVisible();
    expect(documents).toBe(1);
    await page.screenshot({ path: `${evidence}/preview-connection-error-${width}.png` });
    bridgeGate.resolve();
    imageGate.resolve();
    await connection.getByRole("button", { name: "Reload view", exact: true }).click();
    await expect(connection).toHaveCount(0);
    await expect(
      page.frameLocator('iframe[title="Factory Preview"]').getByText("Usable Preview document"),
    ).toBeVisible();
    expect(documents).toBe(2);
  }
  const touch = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    documents = 0;
    const phone = await touch.newPage();
    await phone.goto(`${origin}/runtime-attachment.html?connection-error=1`);
    const connection = phone.getByRole("status", { name: "Preview connection" });
    const reload = connection.getByRole("button", { name: "Reload view", exact: true });
    await expect(reload).toBeVisible();
    expect(
      await reload.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await phone.screenshot({ path: `${evidence}/preview-connection-error-touch.png` });
    await reload.tap();
    await expect(connection).toHaveCount(0);
    expect(documents).toBe(2);
  } finally {
    await touch.close();
  }
});

test("a failed Main Preview exposes its actual cause instead of an empty failure label", async ({
  page,
}) => {
  await page.goto(`${origin}/runtime-attachment.html?failed=1`);
  await expect(
    page.getByText('channel "app" process "app" exited with code 7: missing configuration', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Main Preview", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByText("Scripted Main Preview starts: 0", { exact: true })).toBeVisible();
});

test("Main Preview retry is explicit, deduplicated and leaves the old attempt until confirmed", async ({
  page,
}) => {
  await page.goto(`${origin}/runtime-attachment.html?failed=1&defer=1`);
  const retry = page.getByRole("button", { name: "Retry Main Preview", exact: true });
  await retry.click();
  const pending = page.getByRole("button", { name: "Starting Main Preview…", exact: true });
  await expect(pending).toBeDisabled();
  await expect(page.getByText("Scripted Main Preview starts: 1", { exact: true })).toBeVisible();
  await expect(page.getByText("missing configuration", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Finish scripted start", exact: true }).click();
  await expect(page.getByText("Starting compute for the Preview…", { exact: true })).toBeVisible();
  await expect(page.getByText("Scripted Main Preview starts: 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Main Preview", exact: true })).toHaveCount(
    0,
  );
});

test("Main Preview uncertainty, historical attempts and Ticket compute offer no new Start", async ({
  page,
}) => {
  for (const query of [
    "state=cleanup-failed",
    "state=starting",
    "state=stopping",
    "historical=1",
    "ticket=1",
  ]) {
    await page.goto(`${origin}/runtime-attachment.html?failed=1&${query}`);
    await expect(page.getByRole("button", { name: "Retry Main Preview", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText("Scripted Main Preview starts: 0", { exact: true })).toBeVisible();
  }
});

test("a failed retry keeps its recorded cause and exposes the command uncertainty", async ({
  page,
}) => {
  await page.goto(`${origin}/runtime-attachment.html?failed=1&retry-error=1`);
  await page.getByRole("button", { name: "Retry Main Preview", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Start response is unconfirmed.");
  await expect(page.getByText("missing configuration", { exact: false })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("Main Preview errors wrap on desktop, narrow and synthetic touch layouts", async ({
  page,
  browser,
}) => {
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/runtime-attachment.html?failed=1&long=1`);
    await expect(
      page.getByRole("button", { name: "Retry Main Preview", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: `${evidence}/main-error-${width}.png`, fullPage: true });
  }
  const touch = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    const phone = await touch.newPage();
    await phone.goto(`${origin}/runtime-attachment.html?failed=1`);
    expect(
      await phone
        .getByRole("button", { name: "Retry Main Preview", exact: true })
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await phone.screenshot({ path: `${evidence}/main-error-touch.png`, fullPage: true });
    await phone.getByRole("button", { name: "Retry Main Preview", exact: true }).tap();
    await expect(phone.getByText("Scripted Main Preview starts: 1", { exact: true })).toBeVisible();
    await expect(
      phone.getByText("Starting compute for the Preview…", { exact: true }),
    ).toBeVisible();
  } finally {
    await touch.close();
  }
});

test("saved bare Wiki references navigate at desktop and phone widths without rewriting human text", async ({
  page,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/runtime-attachment.html`);
    await expect(page.getByLabel("Wiki fixture")).toContainText("Saved human note.");
    await page.screenshot({ path: `${evidence}/wiki-reference-before-${width}.png` });
    await page.getByRole("link", { name: "Managing tasks", exact: true }).focus();
    await page.getByRole("link", { name: "Managing tasks", exact: true }).press("Enter");
    await expect(page.getByLabel("Wiki fixture")).toHaveText("Verified linked guidance.");
    expect(new URL(page.url()).hash).toBe("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: `${evidence}/wiki-reference-${width}.png` });
  }
});

test("an App that answers 503 is shown as the App's own response, not a Factory failure", async ({
  page,
}) => {
  bridgeGate.resolve();
  imageGate.resolve();
  await page.goto(`${origin}/runtime-attachment.html?app=1&app-503=1`);
  const frame = page.frameLocator('iframe[title="Factory Preview"]');
  await expect(frame.getByText("Service Unavailable from the App")).toBeVisible();
  await expect(page.getByRole("status", { name: "Preview connection" })).toHaveCount(0);
  const notice = page.locator(".runtime-app-notice");
  await expect(notice).toContainText("The App on port 3000 answered HTTP 503");
  await expect(notice).toContainText("App's own response");
  await expect(page.getByText("Could not open Preview")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/preview-app-503.png` });
});

test("a Preview that waits names the stage, the App port and then admits the App is silent", async ({
  page,
}) => {
  const documentGate = Promise.withResolvers<void>();
  await page.route("**/document", async (route) => {
    await documentGate.promise;
    await route.fulfill({ contentType: "text/html", body: "<p>late</p>" }).catch(() => {});
  });
  await page.clock.install();
  await page.goto(`${origin}/runtime-attachment.html?app=1`, { waitUntil: "domcontentloaded" });
  const connection = page.getByRole("status", { name: "Preview connection" });
  await expect(connection).toContainText("Waiting for the App on port 3000…");
  await page.clock.fastForward(12_000);
  await expect(connection).toContainText("Waiting for 12 s");
  await page.clock.fastForward(20_000);
  await expect(connection).toContainText("The App on port 3000 has not answered yet.");
  await expect(connection).toContainText("Factory keeps waiting");
  await expect(connection.getByRole("button", { name: "Reload view", exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/preview-waiting-stages.png` });
  documentGate.resolve();
});

test("a paused Preview says it is resuming compute, not that compute is running", async ({
  page,
}) => {
  const documentGate = Promise.withResolvers<void>();
  await page.route("**/document", async (route) => {
    await documentGate.promise;
    await route.fulfill({ contentType: "text/html", body: "<p>late</p>" }).catch(() => {});
  });
  await page.clock.install();
  for (const state of ["paused", "resuming"]) {
    await page.goto(`${origin}/runtime-attachment.html?app=1&attempt-state=${state}`, {
      waitUntil: "domcontentloaded",
    });
    const connection = page.getByRole("status", { name: "Preview connection" });
    await expect(connection).toContainText("Resuming compute for the Preview…");
    await expect(connection).not.toContainText("Compute is running");
    await expect(connection).not.toContainText("Waiting for the App on port");
  }
  documentGate.resolve();
});

test("a confirmed failed restore explains itself and offers one idempotent Start fresh", async ({
  page,
}) => {
  await page.goto(`${origin}/runtime-attachment.html?failed=1&ticket=1&restore=confirmed&defer=1`);
  await expect(
    page.getByText("The paused Sandbox could not be restored.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Your files are unchanged. Start fresh to continue; the paused memory and private container data are discarded.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  // The native cause stays one click away instead of repeating the headline in a log.
  await expect(page.getByText("restore backend exited before its pre-resume hold")).toBeHidden();
  await page.getByText("Technical cause", { exact: true }).click();
  await expect(page.getByText("restore backend exited before its pre-resume hold")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Main Preview" })).toHaveCount(0);
  const fresh = page.getByRole("button", { name: "Start fresh", exact: true });
  await fresh.click();
  const pending = page.getByRole("button", { name: "Starting fresh…", exact: true });
  await expect(pending).toBeDisabled();
  await expect(
    page.getByText(/Discarding the paused Sandbox, then starting a new one/),
  ).toBeVisible();
  await pending.click({ force: true }).catch(() => {});
  await expect(page.getByText("Scripted Start fresh commands: 1", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/restore-failed-starting-fresh.png` });
  await page.getByRole("button", { name: "Finish scripted start", exact: true }).click();
  await expect(page.getByText("Starting compute for the Preview…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start fresh|Starting fresh/ })).toHaveCount(0);
  await expect(page.getByText("Scripted Start fresh commands: 1", { exact: true })).toBeVisible();
});

test("an unknown restore outcome is explained and offers no action", async ({ page }) => {
  await page.goto(`${origin}/runtime-attachment.html?failed=1&ticket=1&restore=unknown`);
  await expect(
    page.getByText("Restoring the paused Sandbox could not be confirmed.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/keeps the paused Sandbox untouched/)).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/restore-unknown.png` });
});

test("a failed Start fresh keeps the explanation and can be tried again", async ({ page }) => {
  await page.goto(
    `${origin}/runtime-attachment.html?failed=1&ticket=1&restore=confirmed&fresh-error=1`,
  );
  const fresh = page.getByRole("button", { name: "Start fresh", exact: true });
  await fresh.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Discarding the paused Sandbox could not be confirmed.",
  );
  await expect(fresh).toBeEnabled();
  await expect(
    page.getByText("The paused Sandbox could not be restored.", { exact: true }),
  ).toBeVisible();
  await fresh.click();
  await expect(page.getByText("Scripted Start fresh commands: 2", { exact: true })).toBeVisible();
});

test("the restore recovery fits desktop, narrow and touch layouts", async ({ page, browser }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/runtime-attachment.html?failed=1&ticket=1&restore=confirmed`);
    await expect(page.getByRole("button", { name: "Start fresh", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: `${evidence}/restore-failed-${width}.png`, fullPage: true });
  }
  const touch = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const phone = await touch.newPage();
    await phone.goto(`${origin}/runtime-attachment.html?failed=1&ticket=1&restore=confirmed`);
    expect(
      await phone
        .getByRole("button", { name: "Start fresh", exact: true })
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await phone.screenshot({ path: `${evidence}/restore-failed-touch.png`, fullPage: true });
  } finally {
    await touch.close();
  }
});

test("an exited App process is named as the cause when the Preview cannot open", async ({
  page,
}) => {
  await page.goto(`${origin}/runtime-attachment.html?app=1&exited=1&connection-error=1`);
  const connection = page.getByRole("status", { name: "Preview connection" });
  await expect(connection).toContainText("Could not open Preview.");
  await expect(connection).toContainText("The App process exited with code 1.");
  await expect(connection.getByRole("button", { name: "Reload view", exact: true })).toBeVisible();
});

test("starting compute is a named stage with elapsed time and no failure wording", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`${origin}/runtime-attachment.html?ticket=1&state=starting&failed=1`);
  await expect(page.getByText("Starting compute for the Preview…", { exact: true })).toBeVisible();
  await page.clock.fastForward(11_000);
  await expect(page.getByText(/Starting for 1\d s/)).toBeVisible();
  await expect(page.getByText("Could not open")).toHaveCount(0);
});
