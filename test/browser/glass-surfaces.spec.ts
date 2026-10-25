import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";

const directory = ".factory/test-results/glass-surfaces";
const cache = resolve(".factory/test-results/vite", `glass-surfaces-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["glass-surfaces.html"] },
    plugins: [
      solid({
        ssr: false,
        serverFunctions: {
          devMiddleware: false,
          filter: { include: resolve("apps/factory/src/server-functions/**/*.{ts,tsx}") },
        },
      }),
    ],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!url) throw new Error("Glass materials component server did not expose a local URL");
  origin = url;
  await mkdir(directory, { recursive: true });
});

test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

async function expectGlass(element: Locator) {
  await expect(element).toHaveCSS("background-color", /^rgba\(.+, 0\.68\)$/);
  await expect(element).toHaveCSS("backdrop-filter", /blur\(28px\)/);
}

async function capture(page: Page, name: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}

for (const width of [1440, 768, 390]) {
  test(`Wiki, archive and sign-in share window glass at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${origin}/glass-surfaces.html?surface=wiki`);
    const title = page.getByRole("button", { name: "Edit Knowledge title", exact: true });
    await expect(title).toHaveText("Invoice exports");
    const navigation = page.getByRole("complementary", { name: "Wiki navigation" });
    await expectGlass(page.locator(".workspace-window"));
    if (width <= 760) {
      await page.getByRole("button", { name: "Browse Wiki pages", exact: true }).click();
      await expect(navigation).toBeVisible();
      await expect(navigation).toHaveCSS("background-color", "rgb(252, 252, 248)");
      await capture(page, `wiki-menu-${width}`);
    } else {
      await expect(navigation).toBeVisible();
      await expect(navigation).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await navigation.getByRole("button", { name: "Billing rules", exact: true }).click();
    await expect(title).toHaveText("Billing rules");
    if (width <= 760) await expect(navigation).toBeHidden();
    await capture(page, `wiki-${width}`);
    await page.getByRole("button", { name: "Page options", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Page options", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("background-color", "rgb(252, 252, 248)");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.goto(`${origin}/glass-surfaces.html?surface=archive`);
    const archive = page.getByRole("region", { name: "history", exact: true });
    await expectGlass(archive);
    await expect(archive.getByRole("button")).toHaveCount(3);
    await archive.getByRole("button", { name: /Export invoices as CSV/ }).click();
    await expect(page.getByRole("status")).toHaveText("Archived Ticket selected");
    await capture(page, `archive-${width}`);

    await page.goto(`${origin}/glass-surfaces.html?surface=signin`);
    const form = page.locator(".signin-form");
    await expectGlass(form);
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await capture(page, `signin-${width}`);
    await page.getByLabel("Email", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("standalone glass panels become opaque when reduced transparency is requested", async ({
  page,
}) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  for (const background of [
    { key: "river-landscape", color: "rgb(250, 250, 247)" },
    { key: "moonlit-landscape", color: "rgb(251, 247, 252)" },
  ]) {
    for (const [surface, selector] of [
      ["signin", ".signin-form"],
      ["archive", ".ticket-archive"],
    ] as const) {
      await page.goto(
        `${origin}/glass-surfaces.html?surface=${surface}&background=${background.key}`,
      );
      await expect(page.locator(selector)).toHaveCSS("background-color", background.color);
      await expect(page.locator(selector)).toHaveCSS("backdrop-filter", "none");
    }
  }
  await session.detach();
});

test("standalone glass follows a different Project background", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [surface, selector] of [
    ["signin", ".signin-form"],
    ["archive", ".ticket-archive"],
  ] as const) {
    await page.goto(
      `${origin}/glass-surfaces.html?surface=${surface}&background=moonlit-landscape`,
    );
    await expectGlass(page.locator(selector));
    await capture(page, `${surface}-moonlit`);
  }
});

for (const width of [1440, 768, 390]) {
  test(`link editing stays anchored without moving dense document content at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${origin}/glass-surfaces.html?surface=editor&dense=1`);
    const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
    await expect(editor).toBeVisible();
    const offset =
      "Release context stays readable while formatting the approved delivery scope. ".length * 30;
    const wordBounds = () =>
      editor
        .locator("p")
        .first()
        .evaluate((element, start) => {
          const text = element.firstChild;
          if (!text || text.nodeType !== Node.TEXT_NODE)
            throw new Error("Missing dense editor text");
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + 7);
          const rectangles = [...range.getClientRects()];
          const first = rectangles[0];
          const last = rectangles.at(-1);
          if (!first || !last) throw new Error("Missing selected word geometry");
          return {
            top: first.top,
            x: first.left + 0.5,
            y: (first.top + first.bottom) / 2,
            endX: last.right - 0.5,
            endY: (last.top + last.bottom) / 2,
          };
        }, offset);
    const viewport = page.locator(".ticket-workspace");
    const bounds = await viewport.boundingBox();
    if (!bounds) throw new Error("Missing document viewport");
    const before = await wordBounds();
    await viewport.evaluate(
      (element, delta) => {
        element.scrollTop += delta;
      },
      before.top - bounds.y - 200,
    );
    const word = await wordBounds();
    await page.mouse.move(word.x, word.y);
    await page.mouse.down();
    await page.mouse.move(word.endX, word.endY, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => editor.evaluate(() => getSelection()?.toString())).toBe("Release");
    const toolbar = page.getByRole("toolbar", { name: "Text formatting", exact: true });
    const beforeOpening = await wordBounds();
    const scrollTop = await viewport.evaluate((element) => element.scrollTop);
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const link = toolbar.getByRole("textbox", { name: "Link URL", exact: true });
    await expect(link).toBeFocused();
    await expect(toolbar).toHaveAttribute("data-placement", "floating");
    await expect(page.locator(".editor-popover-shelf")).toHaveCount(0);
    await expect(toolbar).toHaveCSS("background-color", "rgb(252, 252, 248)");
    const selected = await wordBounds();
    expect(selected.top).toBe(beforeOpening.top);
    expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    await expect
      .poll(async () => {
        const box = await toolbar.boundingBox();
        return box ? Math.abs(box.y + box.height - selected.top) : Infinity;
      })
      .toBeLessThanOrEqual(9);
    const box = await toolbar.boundingBox();
    if (!box) throw new Error("Missing anchored link editor");
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    await capture(page, `editor-link-dense-${width}`);
    await link.press("Escape");
    await expect(toolbar).toBeHidden();
    await expect(editor).toBeFocused();
    await expect.poll(() => editor.evaluate(() => getSelection()?.toString())).toBe("Release");
    expect(errors).toEqual([]);
  });
}

async function selectFirstWord(page: Page, editor: Locator, length: number, text: string) {
  await editor.press("ArrowRight");
  await expect(page.locator(".selection-toolbar")).toBeHidden();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const box = await editor
    .locator("p")
    .first()
    .evaluate((element, count) => {
      const node = element.firstChild;
      if (!node) throw new Error("Missing document text");
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, count);
      return range.getBoundingClientRect().toJSON();
    }, length);
  await page.mouse.move(box.left + 0.5, (box.top + box.bottom) / 2);
  await page.mouse.down();
  await page.mouse.move(box.right - 0.5, (box.top + box.bottom) / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => editor.evaluate(() => getSelection()?.toString())).toBe(text);
  return box;
}

for (const width of [1440, 768, 390]) {
  test(`link editor uses shared controls, validates, cancels and inserts with Enter at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${origin}/glass-surfaces.html?surface=editor`);
    await page.evaluate(() => document.fonts.ready);
    const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
    await expect(editor).toBeVisible();
    const original = await editor.innerText();
    const selected = await selectFirstWord(page, editor, 9, "Customers");
    const toolbar = page.getByRole("toolbar", { name: "Text formatting", exact: true });
    await expect(toolbar).toHaveCSS("background-color", "rgb(252, 252, 248)");
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const link = toolbar.getByRole("textbox", { name: "Link URL", exact: true });
    await expect(link).toBeFocused();
    const insert = toolbar.getByRole("button", { name: "Insert link", exact: true });
    await expect(insert).toBeDisabled();
    await expect
      .poll(async () => {
        const box = await toolbar.boundingBox();
        return box
          ? Math.min(Math.abs(box.y - selected.bottom), Math.abs(box.y + box.height - selected.top))
          : Infinity;
      })
      .toBeLessThanOrEqual(9);
    const box = await toolbar.boundingBox();
    const viewport = await page.locator(".ticket-workspace").boundingBox();
    if (!box || !viewport) throw new Error("Missing link editor geometry");
    expect(box.y).toBeGreaterThanOrEqual(viewport.y);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    await link.fill("https://example.com/invoices");
    await capture(page, `editor-link-${width}`);
    await toolbar.getByRole("button", { name: "Cancel link", exact: true }).click();
    await expect(toolbar).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText(original, { useInnerText: true });
    await expect.poll(() => editor.evaluate(() => getSelection()?.toString())).toBe("Customers");
    await selectFirstWord(page, editor, 9, "Customers");
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    await link.fill("http://[");
    await link.press("Enter");
    await expect(toolbar.getByRole("alert")).toHaveText("Enter a valid web address.");
    await expect(link).toHaveAttribute("aria-invalid", "true");
    await expect(editor.locator("a")).toHaveCount(0);
    await link.fill("example.com/invoices");
    await expect(toolbar.getByRole("alert")).toHaveCount(0);
    await expect(link).not.toHaveAttribute("aria-invalid", "true");
    await link.press("Enter");
    await expect(toolbar).toBeHidden();
    await expect(editor.locator("a")).toHaveText("Customers");
    await expect(editor.locator("a")).toHaveAttribute("href", "https://example.com/invoices");
    await editor.press("ControlOrMeta+z");
    await expect(editor.locator("a")).toHaveCount(0);
    await expect(editor).toHaveText(original, { useInnerText: true });
    await selectFirstWord(page, editor, 9, "Customers");
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    await page.locator(".workspace-tabbar").click();
    await expect(toolbar).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test("Wiki uses the same link editor and restores its selection on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/glass-surfaces.html?surface=wiki`);
  await page.getByLabel("Edit Knowledge body", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Knowledge body", exact: true });
  await expect(editor).toBeVisible();
  const selected = await selectFirstWord(page, editor, 6, "Choose");
  const toolbar = page.getByRole("toolbar", { name: "Knowledge selection formatting" });
  await toolbar.getByRole("button", { name: "Link", exact: true }).click();
  const link = toolbar.getByRole("textbox", { name: "Link address", exact: true });
  await expect(link).toBeFocused();
  await expect(toolbar).toHaveCSS("background-color", "rgb(252, 252, 248)");
  await expect
    .poll(async () => {
      const box = await toolbar.boundingBox();
      return box
        ? Math.min(Math.abs(box.y - selected.bottom), Math.abs(box.y + box.height - selected.top))
        : Infinity;
    })
    .toBeLessThanOrEqual(9);
  const box = await toolbar.boundingBox();
  if (!box) throw new Error("Missing Wiki link controls");
  expect(box.y >= selected.bottom || box.y + box.height <= selected.top).toBe(true);
  await link.fill("https://example.com/billing");
  await capture(page, "wiki-link-1440");
  await link.press("Escape");
  await expect(toolbar).toBeHidden();
  await expect(editor).toBeFocused();
  await expect.poll(() => editor.evaluate(() => getSelection()?.toString())).toBe("Choose");
});

test.describe("touch link editing", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("keeps link controls touch-sized without overflowing the phone", async ({ page }) => {
    await page.goto(`${origin}/glass-surfaces.html?surface=editor`);
    const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
    await expect(editor).toBeVisible();
    await selectFirstWord(page, editor, 9, "Customers");
    const toolbar = page.getByRole("toolbar", { name: "Text formatting", exact: true });
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const link = toolbar.getByRole("textbox", { name: "Link URL", exact: true });
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS("font-size", "16px");
    for (const control of [
      link,
      toolbar.getByRole("button", { name: "Insert link", exact: true }),
      toolbar.getByRole("button", { name: "Cancel link", exact: true }),
    ]) {
      const bounds = await control.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await link.fill("https://example.com/invoices");
    await capture(page, "editor-link-touch-390");
    await toolbar.getByRole("button", { name: "Insert link", exact: true }).tap();
    await expect(editor.locator("a")).toHaveText("Customers");
  });
});
