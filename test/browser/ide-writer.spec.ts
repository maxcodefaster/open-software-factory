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
    test("editing stays asleep after Stop or Pause until an explicit compute action", async ({
      page,
    }) => {
      const activate = (control: Locator) => (width === 390 ? control.tap() : control.click());
      await page.goto(`${origin}/ide-writer.html?compute`);
      const status = page.getByRole("status", { name: "Compute state" });
      const starts = page.getByRole("status", { name: "Start commands" });
      await expect(status).toHaveText("ready");
      await activate(page.getByRole("button", { name: "Observe external Stop", exact: true }));
      await expect(status).toHaveText("stopped");
      await activate(page.getByRole("button", { name: "Observe editing grant", exact: true }));
      await expect(status).toHaveText("stopped");
      await expect(starts).toHaveText("0");
      await page.screenshot({ path: resolve(evidence, `stopped-without-restart-${width}.png`) });
      await activate(page.getByRole("button", { name: "Continue editing", exact: true }));
      await page.keyboard.press("ArrowRight");
      await expect(status).toHaveText("stopped");
      await expect(starts).toHaveText("0");
      await activate(page.getByRole("button", { name: "Start compute", exact: true }));
      await expect(status).toHaveText("ready");
      await expect(starts).toHaveText("1");
      await activate(page.getByRole("button", { name: "Observe external Pause", exact: true }));
      await expect(status).toHaveText("paused");
      await activate(page.getByRole("button", { name: "Continue editing", exact: true }));
      await page.keyboard.press("ArrowLeft");
      await expect(status).toHaveText("paused");
      await expect(starts).toHaveText("1");
      await page.screenshot({ path: resolve(evidence, `paused-without-resume-${width}.png`) });
      await activate(page.getByRole("button", { name: "Resume compute", exact: true }));
      await expect(status).toHaveText("ready");
      await expect(starts).toHaveText("2");
    });
  });
}

for (const width of [1440, 900, 620, 390]) {
  test(`IDE status entries never overlap at ${width}px and long Factory text truncates from the right`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`${origin}/ide-writer.html?statusbar`);
    const entries = page.locator("#theia-statusBar .element:visible");
    const boxes = await entries.evaluateAll((elements) =>
      elements.map((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { id: element.id, left, right, top, bottom };
      }),
    );
    // A phone keeps the writer status and drops the passive entries.
    expect(boxes.length).toBeGreaterThanOrEqual(width <= 600 ? 1 : 2);
    expect(boxes.map((box) => box.id)).toContain("status-bar-factory-writing");
    const sorted = [...boxes].sort((a, b) => a.left - b.left);
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (!previous || !current) throw new Error("Missing status entry geometry");
      expect(previous.right, `${previous.id} overlaps ${current.id}`).toBeLessThanOrEqual(
        current.left + 0.5,
      );
    }
    const save = page.locator("#status-bar-session-preference-status");
    if (await save.isVisible()) {
      const box = await save.boundingBox();
      // The session override keeps only its icon so it cannot crowd out the writer status.
      expect(box?.width).toBeGreaterThan(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    }
    const writing = page.locator("#status-bar-factory-writing > span");
    expect(
      await writing.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          clipped: element.scrollWidth > element.clientWidth,
          ellipsis: style.textOverflow,
          nowrap: style.whiteSpace,
        };
      }),
    ).toEqual({ clipped: true, ellipsis: "ellipsis", nowrap: "nowrap" });
    await expect(page.locator("#status-bar-factory-writing")).toHaveAttribute(
      "title",
      /Files remain available to read\./,
    );
    await page.screenshot({ path: resolve(evidence, `status-bar-${width}.png`) });
  });
}

for (const width of [1150, 900, 390]) {
  test(`the full IDE status bar keeps the writer status and language tools in view at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`${origin}/ide-writer.html?statusbar=full`);
    const boxes = await page.locator("#theia-statusBar .element").evaluateAll((elements) =>
      elements.map((element) => {
        const { left, right, width } = element.getBoundingClientRect();
        return { id: element.id, left, right, width };
      }),
    );
    for (const box of boxes.filter((entry) => entry.width > 0))
      expect(box.right, `${box.id} is cut off by the right edge`).toBeLessThanOrEqual(width + 0.5);
    const writing = boxes.find((box) => box.id === "status-bar-factory-writing");
    expect(writing?.width ?? 0).toBeGreaterThanOrEqual(120);
    const tools = boxes.find((box) => box.id === "status-bar-factory-language-tools");
    expect(tools?.width ?? 0).toBeGreaterThan(100);
    await page.screenshot({ path: resolve(evidence, `status-bar-full-${width}.png`) });
  });
}
