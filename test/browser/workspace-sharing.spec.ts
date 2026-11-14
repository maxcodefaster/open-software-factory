import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { test } from "../fixtures/browser-test";

const cache = resolve(".factory/test-results/vite", `sharing-${crypto.randomUUID()}`);
const evidence = ".factory/test-results/workspace-sharing-controls";
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    optimizeDeps: { entries: ["workspace-sharing.html"] },
    plugins: [
      {
        name: "owned-workspace-sharing-commands",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            source === "./server-functions/workspaces" &&
            importer?.endsWith("/workspace-sharing.tsx")
          )
            return resolve("test/fixtures/workspace-sharing-commands.ts");
        },
      },
      solid({ ssr: false }),
    ],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw Error("Owned sharing fixture address is unavailable");
  origin = address.replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "narrow", width: 390, height: 844, touch: false },
  { name: "touch", width: 768, height: 1024, touch: true },
]) {
  test.describe(viewport.name, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
    });
    test("the selected Workspace survives asynchronously loaded options", async ({ page }) => {
      await page.goto(`${origin}/workspace-sharing.html`);
      const selector = page.getByRole("combobox", { name: "Choose shared Workspace" });
      await expect(selector.locator("option")).toHaveCount(1);
      await page.getByRole("button", { name: "Load available Workspaces" }).click();
      await expect(selector.locator("option")).toHaveCount(3);
      await expect(selector).toHaveValue("workspace-shared");
      await selector.selectOption("workspace-owner");
      await expect(page.getByLabel("Opened Workspace")).toHaveText("workspace-owner");
      await expect(selector).toHaveValue("workspace-owner");
      await selector.selectOption("workspace-shared");
      await expect(page.getByLabel("Opened Workspace")).toHaveText("workspace-shared");
      await expect(selector).toHaveValue("workspace-shared");
      await selector.focus();
      await expect(selector).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await page.screenshot({ path: `${evidence}/workspace-${viewport.name}.png`, fullPage: true });
    });

    test("the sharing dialog displays saved permissions before any decision", async ({ page }) => {
      await page.goto(`${origin}/workspace-sharing.html?workspace=workspace-owner`);
      await page.getByRole("button", { name: "Load available Workspaces" }).click();
      const opener = page.getByRole("button", { name: "Share Workspace", exact: true });
      await opener.click();
      const observer = page.getByRole("combobox", { name: "Access for Observer Developer" });
      const collaborator = page.getByRole("combobox", {
        name: "Access for Collaborating Developer",
      });
      await expect(observer).toHaveValue("observe");
      await expect(collaborator).toHaveValue("collaborate");
      await observer.selectOption("collaborate");
      await expect(observer).toHaveValue("collaborate");
      await page.screenshot({
        path: `${evidence}/permissions-${viewport.name}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect(opener).toBeFocused();
      await opener.click();
      await page.getByRole("button", { name: "Close workspace", exact: true }).click();
      await expect(opener).toBeFocused();
    });
  });
}
