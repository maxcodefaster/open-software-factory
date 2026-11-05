import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { test } from "../fixtures/browser-test";
import { factoryFixtureStart } from "../fixtures/start-plugins";

const directory = ".factory/test-results/wiki-conversations";
const cache = resolve(".factory/test-results/vite", `wiki-conversations-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;
test.setTimeout(60_000);

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["wiki-workspace.html", "conversation-shapes.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!url) throw new Error("Wiki and conversation component server did not expose a local URL");
  origin = url;
  await mkdir(directory, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const;

async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
}
async function openNavigation(page: Page, narrow: boolean) {
  if (narrow) await page.getByRole("button", { name: /browse wiki pages$/i }).click();
}

for (const size of sizes) {
  const narrow = size.name === "narrow";
  test.describe(`${size.name} viewport`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("a long Wiki page scrolls wide tables and code instead of clipping or overflowing", async ({
      page,
    }) => {
      await page.goto(`${origin}/wiki-workspace.html?s=populated`);
      const table = page.locator(".knowledge-article table").first();
      await expect(table).toBeVisible();
      await expect(table).toHaveAttribute("tabindex", "0");
      const geometry = await table.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
        article: element.closest(".knowledge-article")?.clientWidth ?? 0,
      }));
      expect(geometry.client).toBeLessThanOrEqual(geometry.article);
      if (narrow) expect(geometry.scroll).toBeGreaterThan(geometry.client);
      await noSidewaysScroll(page);
      await table.focus();
      await expect(table).toBeFocused();
      await page.screenshot({ path: `${directory}/long-page-${size.name}.png` });
    });

    test("Update progress and failure name the saved phase and keep the Wiki readable", async ({
      page,
    }) => {
      await page.goto(`${origin}/wiki-workspace.html?s=writing`);
      await expect(page.getByRole("status").filter({ hasText: "Updating Wiki" })).toBeVisible();
      await expect(page.locator(".generation-detail")).toContainText(
        "Writing guide 4 of 7: Lokal entwickeln",
      );
      await expect(page.locator(".generation-detail")).toContainText("3 pages published so far");
      await expect(page.locator(".knowledge-article")).toBeVisible();
      await noSidewaysScroll(page);
      await page.getByRole("button", { name: "Page options", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Update Project Wiki" })).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.goto(`${origin}/wiki-workspace.html?s=empty-pending`);
      await expect(page.locator(".generation-detail")).toContainText("Queued");
      await expect(page.getByRole("button", { name: "Create Project Wiki" })).toHaveCount(0);
      await page.goto(`${origin}/wiki-workspace.html?s=failed`);
      const alert = page.getByRole("alert");
      await expect(alert).toHaveText("Update failed. Your saved pages are still available.");
      await expect(alert).toHaveCSS("color", /^rgb\(/);
      await expect(page.getByRole("button", { name: "Retry update" })).toBeEnabled();
      await page.getByText("Update details").click();
      await expect(page.locator(".knowledge-update-error pre")).toContainText("HTTP 429");
      await noSidewaysScroll(page);
      await page.goto(`${origin}/wiki-workspace.html?s=empty-failed`);
      await expect(page.getByRole("alert")).toHaveText("Wiki creation failed.");
      await expect(page.getByText("No Wiki pages have been published yet.")).toBeVisible();
      await page.goto(`${origin}/wiki-workspace.html?s=empty`);
      await expect(page.getByRole("button", { name: "Create Project Wiki" })).toBeEnabled();
      await page.goto(`${origin}/wiki-workspace.html?s=empty&pending`);
      await expect(page.getByRole("button", { name: "Create Project Wiki" })).toBeDisabled();
    });

    test("links between pages navigate, and a link to a missing page explains itself", async ({
      page,
    }) => {
      await page.goto(`${origin}/wiki-workspace.html?s=populated`);
      await page.getByRole("link", { name: "Unbekannte Seite" }).click();
      await expect(page.getByRole("status").filter({ hasText: "not available" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Betrieb und CI" })).toBeVisible();
      await page.goto(
        `${origin}/wiki-workspace.html?s=populated&page=20000000-0000-4000-8000-000000000001`,
      );
      await page.getByRole("link", { name: "Betrieb und CI" }).click();
      await expect(page.getByRole("heading", { name: "Betrieb und CI" })).toBeVisible();
      await expect(page.locator(".knowledge-link-notice")).toHaveCount(0);
      await expect(page.locator(".knowledge-article").first()).toHaveAttribute("lang", "de");
    });

    test("search names its pending and failed states and restores focus on close", async ({
      page,
    }) => {
      await page.goto(`${origin}/wiki-workspace.html?s=populated&delay=800`);
      await openNavigation(page, narrow);
      const opener = page.getByRole("button", { name: "Search Wiki", exact: true });
      await opener.click();
      const box = page.getByRole("searchbox", { name: "Search Wiki" });
      await box.fill("Betrieb");
      await expect(page.getByRole("status").filter({ hasText: "Searching" })).toBeVisible();
      await expect(page.getByText("No matching pages.")).toHaveCount(0);
      await expect(page.locator(".wiki-search-result").first()).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Searching" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Search Wiki" })).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: narrow ? /browse wiki pages$/i : "Search Wiki",
          ...(narrow ? {} : { exact: true }),
        }),
      ).toBeFocused();

      await page.goto(`${origin}/wiki-workspace.html?s=populated&search=fail`);
      await openNavigation(page, narrow);
      await page.getByRole("button", { name: "Search Wiki", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search Wiki" }).fill("Betrieb");
      await expect(page.getByRole("alert")).toContainText("Search failed");
      await expect(page.locator(".wiki-search-result")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await noSidewaysScroll(page);

      await page.goto(`${origin}/wiki-workspace.html?s=populated&search=none`);
      await openNavigation(page, narrow);
      await page.getByRole("button", { name: "Search Wiki", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search Wiki" }).fill("Zzzz");
      await expect(page.getByText("No matching pages.")).toBeVisible();
    });

    test("a failed save keeps the draft and ends its message with a full stop", async ({
      page,
    }) => {
      await page.goto(`${origin}/wiki-workspace.html?s=populated&save=fail`);
      await page.getByRole("button", { name: "Page options", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit page" }).click();
      await page.getByRole("textbox", { name: "Wiki page title" }).fill("Neuer Titel");
      const alert = page.getByRole("alert").filter({ hasText: "could not be saved" });
      await expect(alert).toContainText("The Wiki could not be saved.");
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Wiki page title" })).toHaveValue(
        "Neuer Titel",
      );
      await noSidewaysScroll(page);
    });

    test("tool activity is one labeled group per run of calls and long calls stay inside the panel", async ({
      page,
    }) => {
      await page.goto(`${origin}/conversation-shapes.html`);
      const groups = page.getByRole("group", { name: "Grouped tool activity" });
      await expect(groups).toHaveCount(2);
      await expect(page.getByRole("region", { name: "Grouped tool activity" })).toHaveCount(0);
      const panel = page.locator(".agent-messages");
      await expect(panel).toBeVisible();
      for (const element of await page.locator(".agent-messages pre, .agent-messages table").all())
        await expect(element).toHaveAttribute("tabindex", "0");
      const overflow = await panel.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await noSidewaysScroll(page);
      await page.goto(`${origin}/conversation-shapes.html?stopped`);
      await expect(page.getByText("Interrupted").first()).toBeVisible();
      await expect(page.getByText("Running")).toHaveCount(0);
    });
  });
}

test.describe("touch viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Wiki tree and search controls are at least 44px wide and tall", async ({ page }) => {
    await page.goto(`${origin}/wiki-workspace.html?s=populated`);
    await page.getByRole("button", { name: /browse wiki pages$/i }).click();
    const controls = [
      page.locator(".knowledge-tree .tree-search-button"),
      page.locator(".knowledge-tree .tree-toggle").first(),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Search Wiki", exact: true }).click();
    const close = page.getByRole("button", { name: "Close search" });
    const box = await close.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
