import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { type BrowserContext, expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const directory = ".factory/test-results/learning-browser";
const cache = resolve(".factory/test-results/vite", `learning-${crypto.randomUUID()}`);
let server: ViteDevServer, origin: string;
const reactivityDiagnostics = new WeakMap<BrowserContext, string[]>();
function watchReactivity(context: BrowserContext) {
  const messages: string[] = [];
  context.on("console", (message) => {
    if (/\[(?:STRICT_[A-Z_]+|EFFECT_RELAY_TEAR)\]/.test(message.text()))
      messages.push(message.text());
  });
  return messages;
}
test.setTimeout(45_000);
test.use({ contextOptions: { reducedMotion: "reduce" } });
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["learning.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
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
test.beforeEach(async ({ page, context }) => {
  reactivityDiagnostics.set(context, watchReactivity(context));
  await page.addInitScript(() => {
    const messages: string[] = [];
    Object.assign(window, { learningBrowserErrors: messages });
    window.addEventListener("error", (event) => messages.push(event.message));
  });
});
test.afterEach(({ context }) => {
  expect(reactivityDiagnostics.get(context)).toEqual([]);
});
for (const width of [1440, 768, 390]) {
  test(`monitoring trends, evidence and improvement decisions at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/learning.html`);
    await expect(page.getByRole("heading", { name: "Work, quality & cost" })).toBeVisible();
    await expect
      .poll(async () =>
        page
          .locator(".work-chart svg")
          .evaluate((svg) =>
            Math.abs(
              (svg as SVGSVGElement).viewBox.baseVal.width - svg.getBoundingClientRect().width,
            ),
          ),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${directory}/monitoring-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Reviewed quality", exact: true }).click();
    await expect(page.getByRole("group", { name: "Reviewed quality by day" })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.locator(".work-chart").getByRole("img").first().focus();
    await expect(page.locator(".work-chart-reading")).toContainText("Oct 1. 0 supported");
    await page.getByRole("button", { name: "Model cost", exact: true }).click();
    await expect(page.getByText("Incomplete cost", { exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.locator(".work-chart").getByRole("img").first().focus();
    await expect(page.locator(".work-chart-reading")).toContainText("plus unknown costs");
    await page.getByText("View daily data", { exact: true }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByText("View daily data", { exact: true }).click();
    await page.getByText("Why this change, and how to check it", { exact: true }).click();
    await expect(
      page.getByText("Expected effect, not measured yet", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Evidence defect:check", exact: true }).click();
    const citedSource = page.locator('[id^="work-evidence-"]').filter({ hasText: "defect:check" });
    await expect(citedSource).toBeFocused();
    await expect(citedSource).toHaveAttribute("open", "");
    await expect(page.getByText("research · completed", { exact: true })).toBeVisible();
    const scope = page
      .locator(".work-case-result")
      .filter({ hasText: "calibration:scope-mismatch" });
    await expect(scope).toContainText("Insufficient evidence");
    await expect(scope).toContainText("Verification problem");
    await expect(
      page.locator(".work-case-result").filter({ hasText: "calibration:coverage-preserved" }),
    ).toContainText("Verification supported");
    await page.screenshot({ path: `${directory}/evidence-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Pause learning", exact: true }).click();
    await expect(page.getByText("Learning paused", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create improvement Ticket", exact: true }).click();
    await expect(page.getByLabel("Fixture action")).toHaveText("Improvement Ticket created");
    await page
      .getByRole("button", {
        name: "Stop rebuilding the app for documentation-only changes",
        exact: true,
      })
      .click();
    await expect(page.getByLabel("Fixture action")).toHaveText("Ticket opened");
    expect(errors).toEqual([]);
  });
}
test.describe("touch review evidence", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("fulfillment and verification remain separate when opening a review by touch", async ({
    page,
  }) => {
    await page.goto(`${origin}/learning.html`);
    await page.getByText("Review history & evidence", { exact: false }).tap();
    await page.getByText("8 work cases", { exact: true }).tap();
    const scope = page
      .locator(".work-case-result")
      .filter({ hasText: "calibration:scope-mismatch" });
    await expect(scope).toContainText("Insufficient evidence");
    await expect(scope).toContainText("Verification problem");
    await scope.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/verification-touch-390.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
});
test("empty, read-only and private learning states are truthful", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${origin}/learning.html?empty`);
  await expect(
    page.getByRole("heading", { name: "Learning starts with completed work" }),
  ).toBeVisible();
  await page.screenshot({ path: `${directory}/empty-390.png`, fullPage: true });
  await page.goto(`${origin}/learning.html?readonly`);
  await expect(page.getByRole("button", { name: "Pause learning" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create improvement Ticket" })).toHaveCount(0);
  await page.goto(`${origin}/learning.html?private`);
  await page.getByText("Why this change, and how to check it", { exact: true }).click();
  await expect(page.getByText(/Your source packet and private chat are not shared/)).toBeVisible();
  await page.getByRole("button", { name: "Share proposal as Ticket", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText(
    "Explicit private proposal released as Ticket",
  );
});
test("automatic updates require an explicit scoped permission, separate from default-on review", async ({
  page,
}) => {
  await page.goto(`${origin}/learning.html`);
  await page.getByText("Automatic Skill updates · Off", { exact: true }).click();
  await expect(
    page.getByText(/two observed method failures and a separate healthy task/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow compared Skill updates", exact: true }).click();
  await expect(page.getByText("Automatic Skill updates · Allowed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause learning", exact: true }).click();
  await page.getByRole("button", { name: "Stop automatic Skill updates", exact: true }).click();
  await expect(page.getByText("Automatic Skill updates · Off", { exact: true })).toBeVisible();
  await expect(page.getByText("Learning paused", { exact: true })).toBeVisible();
});
for (const width of [1440, 390]) {
  test(`compared changes expose actual baseline, candidate and source evidence at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/learning.html?comparison`);
    await page.getByText("Compared changes · 1", { exact: true }).click();
    await page
      .getByText("Use pinned values rather than cached values · Adoption · applied", {
        exact: true,
      })
      .click();
    await page.getByText("Compared instruction & exact revision", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Baseline instruction", exact: true }),
    ).toBeVisible();
    await page.getByText("Task 1 · synthetic:task:1", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Baseline response", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Candidate response", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("MAX_RETRIES is 3. Source artifact:0.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${directory}/comparison-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
for (const width of [1440, 768, 390]) {
  test(`exact edit review and protected Undo at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/learning.html?edit&private`);
    await page.getByText("Review exact edit", { exact: true }).click();
    const apply = page.getByRole("button", { name: "Apply exact edit", exact: true });
    await expect(apply).toBeDisabled();
    await expect(page.getByText(/This edit has not been benchmarked/)).toBeVisible();
    await page
      .getByRole("checkbox", { name: /Share this exact edit outside my private work/ })
      .check();
    await expect(apply).toBeEnabled();
    await page.screenshot({ path: `${directory}/edit-${width}.png`, fullPage: true });
    await apply.click();
    await expect(page.getByLabel("Fixture action")).toHaveText(
      "Exact private edit applied with release",
    );
    await page.getByText("Accepted edit & revision", { exact: true }).click();
    await page.getByText("Inspect latest sampled uses · 1 of 1", { exact: true }).click();
    await page.getByText("research · supported · synthetic:later:1", { exact: true }).click();
    await page.getByText("outcome · later:answer", { exact: true }).click();
    await expect(
      page.getByText("The answer used the documented hostname without asking again.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: `${directory}/applied-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Undo this edit", exact: true }).click();
    await expect(
      page.locator(".work-application").getByText("Reverted", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo this edit", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}
test("own private methods need no public release; blocked managers can request an exact settings edit", async ({
  page,
}) => {
  await page.goto(`${origin}/learning.html?edit&private&personal-target`);
  await page.getByText("Review exact edit", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Share this exact edit/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply exact edit", exact: true })).toBeEnabled();
  await page.goto(`${origin}/learning.html?edit&blocked`);
  await page.getByText("Review exact edit", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply exact edit", exact: true })).toHaveCount(0);
  await expect(
    page.getByText("The owning Factory administrator must apply this edit.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Request settings edit in Ticket", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText("Improvement Ticket created");
});

for (const width of [1440, 768, 390, 320]) {
  test(`learning stream keeps real decisions inspectable at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/learning.html?flow`);
    const flow = page.getByRole("region", { name: "Learning history overview" });
    const detail = flow.locator(".learning-flow-detail");
    await expect(flow.getByRole("button", { pressed: true })).toHaveAccessibleName(
      "Oct 26: Read sources before asking again. Adopted v4",
    );
    await expect(detail).toContainText("not causal proof");
    await expect(flow.locator(".learning-flow-node")).toHaveCount(4);
    await expect(flow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(flow.getByRole("heading", { name: "Learning history", exact: true })).toHaveCSS(
      "font-family",
      await page
        .getByRole("heading", { name: "Work, quality & cost", exact: true })
        .evaluate((element) => getComputedStyle(element).fontFamily),
    );
    await expect
      .poll(() =>
        flow
          .locator("svg")
          .evaluate((svg) =>
            Math.abs(
              (svg as SVGSVGElement).viewBox.baseVal.width - svg.getBoundingClientRect().width,
            ),
          ),
      )
      .toBeLessThanOrEqual(1);
    await flow.screenshot({ path: `${directory}/flow-${width}.png` });
    const layout = await flow.evaluate((element) => {
      function fixtureValue<T>(value: T, description: string): NonNullable<T> {
        if (value === undefined || value === null)
          throw new Error(`Missing fixture value: ${description}`);
        return value;
      }

      const field = fixtureValue(
        element.querySelector(".learning-flow-field"),
        'element.querySelector(".learning-flow-field")',
      ).getBoundingClientRect();
      const boxes = [...element.querySelectorAll(".learning-flow-label")].map((label) => {
        const r = label.getBoundingClientRect();
        return {
          left: r.left - field.left,
          right: r.right - field.left,
          top: r.top - field.top,
          bottom: r.bottom - field.top,
        };
      });
      return {
        width: field.width,
        height: field.height,
        boxes,
        overlaps: boxes.flatMap((a, index) =>
          boxes
            .slice(index + 1)
            .filter(
              (b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
            ),
        ),
      };
    });
    expect(layout.overlaps).toEqual([]);
    for (const box of layout.boxes) {
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(layout.width + 1);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(layout.height);
    }
    const kept = flow.getByRole("button", { name: /Shorten source citations/ });
    await kept.click();
    await expect(kept).toBeFocused();
    await expect(detail.locator(".learning-flow-outcome")).toHaveText("Kept current");
    await flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }).click();
    const comparison = page.locator(".work-comparisons .work-review");
    await expect(comparison).toHaveAttribute("open", "");
    await expect(comparison.locator(":scope > summary")).toBeFocused();
    const pending = flow.getByRole("button", { name: /Clarify incomplete Input/ });
    await pending.click();
    await expect(detail).toContainText("Proposed change, not applied");
    const contrast = await flow.evaluate((element) => {
      function fixtureValue<T>(value: T, description: string): NonNullable<T> {
        if (value === undefined || value === null)
          throw new Error(`Missing fixture value: ${description}`);
        return value;
      }

      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = fixtureValue(canvas.getContext("2d"), 'canvas.getContext("2d")');
      function color(value: string) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      }
      const ancestors: Element[] = [];
      for (let parent: Element | null = element; parent; parent = parent.parentElement)
        ancestors.unshift(parent);
      const paper = ancestors.reduce(
        (background, parent) => {
          const layer = color(getComputedStyle(parent).backgroundColor);
          const alpha = fixtureValue(layer[3], "layer[3]") / 255;
          return background.map(
            (value, index) =>
              value * (1 - alpha) + fixtureValue(layer[index], "layer[index]") * alpha,
          );
        },
        [255, 255, 255],
      );
      const luminance = (rgb: number[]) =>
        rgb
          .slice(0, 3)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce(
            (total, value, index) =>
              total +
              value *
                fixtureValue([0.2126, 0.7152, 0.0722][index], "[0.2126, 0.7152, 0.0722][index]"),
            0,
          );
      return [
        ".learning-flow-node[aria-pressed=true] .learning-flow-name",
        ".learning-flow-outcome",
      ].map((selector) => {
        const style = getComputedStyle(
          fixtureValue(element.querySelector(selector), "element.querySelector(selector)"),
        );
        const foreground = color(style.color);
        const background = color(style.backgroundColor);
        const alpha = fixtureValue(background[3], "background[3]") / 255;
        const actual = paper.map(
          (value, index) =>
            value * (1 - alpha) + fixtureValue(background[index], "background[index]") * alpha,
        );
        const fg = luminance(foreground),
          bg = luminance(actual);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
    });
    expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
    await flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }).click();
    await expect(page.locator("#work-proposal-10000000-0000-4000-8000-000000000035")).toBeFocused();
    await flow.getByRole("button", { name: /documentation-only changes/ }).click();
    await flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }).click();
    const review = page.locator("#work-review-10000000-0000-4000-8000-000000000023");
    await expect(review).toHaveAttribute("open", "");
    await expect(review.locator(":scope > summary")).toBeFocused();
    await flow.getByRole("button", { name: /Read sources before asking again/ }).click();
    await flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }).click();
    await expect(page.locator(".work-application")).toBeFocused();
    await expect(page.getByLabel("Fixture action")).toHaveText("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, "learningBrowserErrors"))).toEqual([]);
  });
}

test("stream selection survives local updates and reaches evidence by keyboard", async ({
  page,
}) => {
  await page.goto(`${origin}/learning.html?flow`);
  const flow = page.getByRole("region", { name: "Learning history overview" });
  const pending = flow.getByRole("button", { name: /Clarify incomplete Input/ });
  const button = await pending.elementHandle();
  await pending.focus();
  await page.keyboard.press("Enter");
  await expect(pending).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Pause learning", exact: true }).click();
  await expect(page.getByText("Learning paused", { exact: true })).toBeVisible();
  expect(await button.evaluate((node) => node.isConnected)).toBe(true);
  await expect(pending).toHaveAttribute("aria-pressed", "true");
  await pending.focus();
  await page.keyboard.press("Tab");
  await expect(
    flow.getByRole("button", { name: /Read sources before asking again/ }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("#work-proposal-10000000-0000-4000-8000-000000000035")).toBeFocused();
});

test("stream has truthful empty, unchanged, uncertain and bounded history states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const flow = page.getByRole("region", { name: "Learning history overview" });
  await page.goto(`${origin}/learning.html?empty`);
  await expect(flow.locator(".learning-flow-node")).toHaveCount(0);
  await expect(flow.getByRole("img")).toHaveCount(0);
  await expect(flow).toContainText("Opening this page starts no AI call");
  await flow.screenshot({ path: `${directory}/flow-empty-390.png` });
  await page.goto(`${origin}/learning.html?calibration`);
  await expect(flow.locator(".learning-flow-node")).toHaveCount(0);
  await page.goto(`${origin}/learning.html?no-change`);
  await expect(flow.locator(".learning-flow-node")).toHaveCount(1);
  await expect(flow.locator(".learning-flow-outcome")).toHaveText("No change proposed");
  await page.goto(`${origin}/learning.html?flow&uncertain&readonly&paused`);
  await flow.getByRole("button", { name: /Shorten source citations/ }).click();
  await expect(flow.locator(".learning-flow-outcome")).toHaveText("Unconfirmed");
  await expect(flow.locator(".learning-flow-description")).toContainText("No automatic retry");
  await expect(page.getByRole("button", { name: "Resume learning", exact: true })).toHaveCount(0);
  await expect(
    flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }),
  ).toBeEnabled();
  await flow.screenshot({ path: `${directory}/flow-uncertain-390.png` });
  await page.goto(`${origin}/learning.html?flow&many&long`);
  await expect(flow).toContainText("Latest 4 of 7 records");
  await expect(flow.locator(".learning-flow-node")).toHaveCount(4);
  await expect(flow.locator(".learning-flow-detail h4")).toContainText(
    "environment-specific overrides",
  );
  await flow.screenshot({ path: `${directory}/flow-long-390.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("stream touch targets remain usable at 320px without decorative motion", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 1000 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const diagnostics = watchReactivity(context);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/learning.html?flow`);
    const flow = page.getByRole("region", { name: "Learning history overview" });
    await flow.getByRole("button", { name: /Clarify incomplete Input/ }).tap();
    await expect(flow.locator(".learning-flow-outcome")).toHaveText("Proposed");
    const targets = await flow.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          animation: getComputedStyle(button).animationName,
        };
      }),
    );
    for (const target of targets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.animation).toBe("none");
    }
    await flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }).tap();
    await expect(page.locator("#work-proposal-10000000-0000-4000-8000-000000000035")).toBeFocused();
    expect(diagnostics).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an unavailable applied revision keeps its source review inspectable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`${origin}/learning.html?flow&missing-revision`);
  const flow = page.getByRole("region", { name: "Learning history overview" });
  await expect(flow.locator(".learning-flow-outcome")).toHaveText("Revision unavailable");
  await expect(flow.locator(".learning-flow-description")).toContainText(
    "exact applied revision is not included",
  );
  await flow.screenshot({ path: `${directory}/flow-missing-revision-390.png` });
  await flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }).click();
  const review = page.locator("#work-review-10000000-0000-4000-8000-000000000026");
  await expect(review).toHaveAttribute("open", "");
  await expect(review.locator(":scope > summary")).toBeFocused();
  await expect(page.getByLabel("Fixture action")).toHaveText("");
});

test("hover previews the record and its wave segment without changing selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/learning.html?flow`);
  const flow = page.getByRole("region", { name: "Learning history overview" });
  const field = flow.locator(".learning-flow-field");
  const selected = await field.getAttribute("data-active-record");
  const kept = flow.getByRole("button", { name: /Shorten source citations/ });
  const popup = flow.locator(".learning-flow-preview");
  await kept.hover();
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("Both claimed baseline failures did not reproduce");
  await expect(popup).toContainText("Comparison started");
  await expect(kept).toHaveAttribute("aria-pressed", "false");
  await expect(kept).toHaveAttribute("data-preview", "true");
  await expect(kept).toHaveAttribute("aria-describedby", (await popup.getAttribute("id")) ?? "");
  await expect(flow.locator(".learning-flow-detail h4")).toHaveText(
    "Read sources before asking again",
  );
  expect(await field.getAttribute("data-active-record")).not.toBe(selected);
  await page.screenshot({ path: `${directory}/flow-hover-1440.png` });
  await popup.hover();
  // The preview must remain readable after crossing the small pointer gap.
  await page.waitForTimeout(180);
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(field).toHaveAttribute("data-active-record", fixtureValue(selected, "selected"));
  await expect(page.getByLabel("Fixture action")).toHaveText("");
});

test("keyboard previews remain non-modal and selection exposes the same information", async ({
  page,
}) => {
  await page.goto(`${origin}/learning.html?flow`);
  const flow = page.getByRole("region", { name: "Learning history overview" });
  const popup = flow.locator(".learning-flow-preview");
  const pending = flow.getByRole("button", { name: /Clarify incomplete Input/ });
  await flow.getByRole("button", { name: /Read sources before asking again/ }).hover();
  await pending.focus();
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("Ask for the missing Project reference");
  await expect(pending).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(pending).toBeFocused();
  await expect(pending).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await expect(pending).toHaveAttribute("aria-pressed", "true");
  await expect(flow.locator(".learning-flow-detail")).toContainText(
    "Ask for the missing Project reference",
  );
  await expect(popup).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(
    flow.getByRole("button", { name: /Read sources before asking again/ }),
  ).toBeFocused();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    flow.getByRole("button", { name: "Inspect decision & evidence", exact: true }),
  ).toBeFocused();
  await expect(popup).toBeHidden();
});

test("the stream reflows on live resizing and dismisses obsolete hover geometry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${origin}/learning.html?flow`);
  const flow = page.getByRole("region", { name: "Learning history overview" });
  await flow.getByRole("button", { name: /Shorten source citations/ }).hover();
  await expect(flow.locator(".learning-flow-preview")).toBeVisible();
  for (const width of [640, 320, 1000]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(flow.locator(".learning-flow-preview")).toBeHidden();
    await expect
      .poll(() =>
        flow
          .locator("svg")
          .evaluate((svg) =>
            Math.abs(
              (svg as SVGSVGElement).viewBox.baseVal.width - svg.getBoundingClientRect().width,
            ),
          ),
      )
      .toBeLessThanOrEqual(1);
    const field = flow.locator(".learning-flow-field");
    const measured = await field.evaluate((element) => element.clientWidth);
    await expect(field).toHaveAttribute("data-mobile", measured < 520 ? "true" : "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await expect
    .poll(() =>
      flow
        .locator("svg")
        .evaluate((svg) =>
          Math.abs(
            (svg as SVGSVGElement).viewBox.baseVal.width - svg.getBoundingClientRect().width,
          ),
        ),
    )
    .toBeLessThanOrEqual(1);
  const pending = flow.getByRole("button", { name: /Clarify incomplete Input/ });
  await pending.focus();
  const popup = flow.locator(".learning-flow-preview");
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox();
  expect(fixtureValue(box, "box").x).toBeGreaterThanOrEqual(11);
  expect(fixtureValue(box, "box").x + fixtureValue(box, "box").width).toBeLessThanOrEqual(309);
  expect(fixtureValue(box, "box").y).toBeGreaterThanOrEqual(11);
  expect(fixtureValue(box, "box").y + fixtureValue(box, "box").height).toBeLessThanOrEqual(989);
  await page.screenshot({ path: `${directory}/flow-keyboard-preview-320.png` });
});

test("history replacement removes previews and adapts from no records to a full stream", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/learning.html?flow&refresh`);
  const flow = page.getByRole("region", { name: "Learning history overview" });
  await flow.getByRole("button", { name: /Shorten source citations/ }).hover();
  await expect(flow.locator(".learning-flow-preview")).toBeVisible();
  // Dispatch the fixture's incoming data update without moving the pointer away first.
  const replace = page.getByRole("button", { name: "Replace synthetic history", exact: true });
  await replace.dispatchEvent("click");
  await expect(flow.locator(".learning-flow-node")).toHaveCount(0);
  await expect(flow.locator(".learning-flow-preview")).toBeHidden();
  await expect(flow.locator(".learning-flow-detail")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await replace.dispatchEvent("click");
  await expect(flow.locator(".learning-flow-node")).toHaveCount(4);
  await expect(flow.locator(".learning-flow-detail h4")).toHaveText(
    "Read sources before asking again",
  );
  await expect(flow.locator(".learning-flow-preview")).toBeHidden();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, "learningBrowserErrors"))).toEqual([]);
});

test("motion is a finite interaction response and respects reduced motion", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: "no-preference",
  });
  const diagnostics = watchReactivity(context);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/learning.html?flow&refresh`);
    const flow = page.getByRole("region", { name: "Learning history overview" });
    await expect(flow.locator(".learning-flow-trace")).toHaveCount(0);
    await flow.getByRole("button", { name: /Shorten source citations/ }).hover();
    const trace = flow.locator(".learning-flow-trace");
    await expect(trace).toHaveCSS("animation-name", "learning-flow-trace");
    await expect(trace).toHaveCSS("animation-iteration-count", "1");
    expect(
      await trace.evaluate((element) => element.getAnimations()[0]?.effect?.getTiming().iterations),
    ).toBe(1);
    await expect.poll(() => trace.evaluate((element) => element.getAnimations().length)).toBe(0);
    const replace = page.getByRole("button", { name: "Replace synthetic history", exact: true });
    await replace.dispatchEvent("click");
    await expect(flow.locator(".learning-flow-node")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await replace.dispatchEvent("click");
    await expect(flow.locator(".learning-flow-node")).toHaveCount(4);
    await expect(trace).toHaveCount(0);
    await expect(flow.locator(".learning-flow-preview")).toBeHidden();
    await flow.getByRole("button", { name: /Clarify incomplete Input/ }).hover();
    await expect(flow.locator(".learning-flow-preview")).toContainText("missing Project reference");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(flow.locator(".learning-flow-trace")).toHaveCSS("animation-name", "none");
    expect(
      await flow
        .locator(".learning-flow-trace")
        .evaluate((element) => element.getAnimations().length),
    ).toBe(0);
    await expect(flow.getByRole("button", { name: /Clarify incomplete Input/ })).toHaveAttribute(
      "data-preview",
      "true",
    );
    await expect(page.getByLabel("Fixture action")).toHaveText("");
    expect(diagnostics).toEqual([]);
  } finally {
    await context.close();
  }
});
