import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { test } from "../fixtures/browser-test";

const evidence = resolve(".factory/test-results/ide-writer");
const cache = resolve(".factory/test-results/vite", `ide-writer-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    optimizeDeps: { entries: ["ide-writer.html"] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("IDE editing access fixture address is missing");
  origin = address.replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

for (const width of [1440, 900, 390]) {
  test.describe(`IDE editing access at ${width}px`, () => {
    test.use({ viewport: { width, height: 760 }, hasTouch: width === 390 });
    test("keeps Run unobscured and opens editing actions only on request", async ({ page }) => {
      const activate = (control: Locator) => (width === 390 ? control.tap() : control.click());
      await page.goto(`${origin}/ide-writer.html`);
      const dialog = page.getByRole("dialog", { name: "Editing access" });
      const opener = page.getByRole("button", { name: "Observation mode" });
      const commands = page.getByRole("status", { name: "Editing commands" });
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "Take over editing" })).toBeHidden();
      await activate(page.getByRole("button", { name: "Preview", exact: true }));
      await expect(commands).toHaveText("0");
      await page.screenshot({ path: resolve(evidence, `unobscured-${width}.png`) });

      await activate(opener);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Agent working");
      await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await expect(commands).toHaveText("0");
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({ path: resolve(evidence, `editing-access-${width}.png`) });

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      await expect(commands).toHaveText("0");
      await activate(opener);
      if (width === 390) await page.touchscreen.tap(4, 4);
      else await page.mouse.click(4, 4);
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      await activate(opener);
      await activate(page.getByRole("button", { name: "Take over editing", exact: true }));
      await expect(commands).toHaveText("1");
      await activate(page.getByRole("button", { name: "Close", exact: true }));
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    });
  });
}
