import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { previewBridge } from "../../apps/factory/src/review/preview-bridge";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { test } from "../fixtures/browser-test";
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
      factoryFixtureStart(),
      solid({ ssr: false }),
      {
        name: "owned-preview-document",
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            const path = request.url?.split("?")[0];
            if (path === "/document") {
              documents++;
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
  await expect(page.getByText("Workspace starting", { exact: true })).toBeVisible();
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
    reducedMotion: "reduce",
  });
  try {
    const phone = await touch.newPage();
    await phone.goto(`${origin}/runtime-attachment.html?failed=1`);
    await phone.screenshot({ path: `${evidence}/main-error-touch.png`, fullPage: true });
    await phone.getByRole("button", { name: "Retry Main Preview", exact: true }).tap();
    await expect(phone.getByText("Scripted Main Preview starts: 1", { exact: true })).toBeVisible();
    await expect(phone.getByText("Workspace starting", { exact: true })).toBeVisible();
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
