import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { luminance, rgb } from "../support/visual-contrast";

const evidence = ".factory/test-results/ui-controls";
const cache = resolve(".factory/test-results/vite", `controls-${crypto.randomUUID()}`);
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    optimizeDeps: { entries: ["ui-controls.html"] },
    plugins: [solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("Shared controls fixture address is missing");
  origin = address.replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

for (const { width, desktop } of [
  { width: 1440, desktop: false },
  { width: 390, desktop: false },
  { width: 320, desktop: false },
  { width: 1440, desktop: true },
  { width: 390, desktop: true },
  { width: 320, desktop: true },
]) {
  test(`shared controls retain their native behavior and compact geometry at ${width}px ${desktop ? "inside the desktop" : "in isolation"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${origin}/ui-controls.html${desktop ? "?desktop" : ""}`);
    const save = page.getByRole("button", { name: "Save draft", exact: true });
    const input = page.getByRole("textbox", { name: "Project name", exact: true });
    const select = page.getByRole("combobox", { name: "Delivery mode", exact: true });
    const geometry = await Promise.all(
      [
        save,
        input,
        select,
        page.getByRole("combobox", { name: "Unavailable selection", exact: true }),
        page.getByRole("textbox", { name: "Required name", exact: true }),
        page.getByRole("button", { name: "Inspect", exact: true }),
        page.getByRole("button", { name: "Run check", exact: true }),
        page.getByRole("button", { name: "Delete draft", exact: true }),
      ].map((control) =>
        control.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            radius: style.borderRadius,
            font: style.fontFamily,
            size: style.fontSize,
          };
        }),
      ),
    );
    for (const control of geometry) {
      expect(control.height).toBeCloseTo(32, 0);
      expect(control.radius).toBe("10px");
      expect(control.font).toContain("Inter");
      expect(control.size).toBe("13px");
    }
    expect(await save.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
    expect(
      await page
        .getByRole("button", { name: "Inspect", exact: true })
        .evaluate((element) => getComputedStyle(element).borderTopWidth),
    ).toBe("1px");
    await save.focus();
    await expect(save).toBeFocused();
    expect(await save.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe("2px");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "Actions", exact: true }).getByRole("status"),
    ).toHaveText("Draft saved in this fixture.");
    await input.fill("Invoices");
    await expect(input).toHaveValue("Invoices");
    await select.selectOption("automatic");
    await expect(page.getByLabel("Selected delivery mode", { exact: true })).toHaveText(
      "automatic",
    );
    const checkbox = page.getByRole("checkbox");
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    expect(await checkbox.evaluate((element) => element.getBoundingClientRect().width)).toBe(16);
    await expect(page.getByRole("button", { name: "Unavailable", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Saving…", exact: true })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(
      page.getByRole("combobox", { name: "Unavailable selection", exact: true }),
    ).toBeDisabled();
    const invalid = page.getByRole("textbox", { name: "Required name", exact: true });
    await expect(invalid).toHaveAttribute("aria-describedby", "control-name-error");
    expect(await invalid.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(
      "rgb(148, 85, 77)",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: `${evidence}/controls-${desktop ? "desktop-" : ""}${width}.png`,
      fullPage: true,
    });
  });
}

test("primary actions retain contrast on hover and follow the Project accent", async ({ page }) => {
  const colors = new Set<string>();
  for (const background of ["river-landscape", "the-harvesters"]) {
    await page.goto(`${origin}/ui-controls.html?background=${background}`);
    const primary = page.getByRole("button", { name: "Run check", exact: true });
    const before = await primary.evaluate((element) => getComputedStyle(element).backgroundColor);
    const foreground = await primary.evaluate((element) => getComputedStyle(element).color);
    const backgroundLuminance = luminance(rgb(before).channels);
    const foregroundLuminance = luminance(rgb(foreground).channels);
    expect(
      (Math.max(backgroundLuminance, foregroundLuminance) + 0.05) /
        (Math.min(backgroundLuminance, foregroundLuminance) + 0.05),
    ).toBeGreaterThanOrEqual(4.5);
    colors.add(before);
    await primary.hover();
    expect(await primary.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      before,
    );
    const action = page.getByRole("button", { name: "Save draft", exact: true });
    expect(await action.evaluate((element) => getComputedStyle(element).color)).toBe(before);
  }
  expect(colors.size).toBe(2);
});

test("touch controls keep adequate targets and text fields do not trigger mobile zoom", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/ui-controls.html`);
    const controls = page.locator("button, select, input:not([type=checkbox]), .control-check");
    for (const control of await controls.all())
      expect(
        await control.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
    expect(
      await page
        .getByLabel("Project name", { exact: true })
        .evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe("16px");
    await page.screenshot({ path: `${evidence}/controls-touch.png`, fullPage: true });
  } finally {
    await context.close();
  }
});
