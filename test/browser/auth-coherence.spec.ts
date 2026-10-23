import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { luminance, rgb } from "../support/visual-contrast";
import { desktopBackgroundKeys } from "../../packages/interface-domain/src/background";

for (const width of [1440, 900, 390]) {
  test(`signed-out supporting text has a contrast floor at ${width}px`, async ({ page }) => {
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator(".signin-copy")).toHaveText("Open your Factory workspace.", {
      timeout: 2_000,
    });
    await expect(page.locator(".managed-access")).toHaveText(
      "Use the account provided by your Factory administrator.",
    );
    await page.waitForLoadState("networkidle");
    expect(
      scripts.filter((url) =>
        /\/(?:document-engine|document-highlighting|factory)-[^/]+\.js/.test(url),
      ),
    ).toEqual([]);

    for (const background of desktopBackgroundKeys) {
      // Presentation-only variants in a signed-out fixture; no persisted user preference changes.
      await page.locator(".signin").evaluate((element, key) => {
        element.setAttribute("data-background", key);
      }, background);
      await page.locator(".signin").evaluate(async (element) => {
        const art = getComputedStyle(element).getPropertyValue("--desktop-art");
        const path = art.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
        if (!path) throw new Error("Selected artwork is absent");
        const image = new Image();
        image.src = path;
        await image.decode();
      });
      const contrast = await page.locator(".signin").evaluate((element) => {
        const style = getComputedStyle(element);
        const opacity = Number.parseFloat(style.getPropertyValue("--auth-brand-scrim-opacity"));
        const paper = style.getPropertyValue("--color-paper").trim();
        const veil = getComputedStyle(element, "::after").backgroundImage;
        const brand = element.querySelector(".signin-brand");
        if (!brand) throw new Error("Sign-in brand is absent");
        return {
          opacity,
          paper,
          veil,
          art: getComputedStyle(element, "::before").backgroundImage,
          brandRight: brand.getBoundingClientRect().right,
          colors: [...brand.querySelectorAll("p, .runtime-diagram span")].map(
            (text) => getComputedStyle(text).color,
          ),
        };
      });
      expect(contrast.opacity).toBeGreaterThanOrEqual(0.86);
      expect(contrast.art).toContain(`${background}.jpg`);
      expect(contrast.veil).toContain("0.86");
      if (width > 760) expect(contrast.brandRight).toBeLessThanOrEqual(width * 0.65);
      const paper = contrast.paper.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
      if (!paper) throw new Error("Expected the opaque Factory paper token");
      // Even a black artwork pixel must stay readable beneath the brand's minimum veil.
      const darkestBackground = paper
        .slice(1)
        .map((hex) => Number.parseInt(hex, 16) * contrast.opacity);
      for (const color of contrast.colors) {
        const channels = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
        if (!channels) throw new Error(`Expected opaque supporting text, received ${color}`);
        const ratio =
          (luminance(darkestBackground) + 0.05) / (luminance(channels.slice(1).map(Number)) + 0.05);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
      const form = await page.locator(".signin-form").evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        colors: [...element.querySelectorAll(".signin-copy, .managed-access, label")].map(
          (text) => getComputedStyle(text).color,
        ),
      }));
      const formBackground = rgb(form.background);
      const formFloor = luminance(
        formBackground.channels.map((channel) => channel * formBackground.alpha),
      );
      for (const color of form.colors) {
        const ratio = (formFloor + 0.05) / (luminance(rgb(color).channels) + 0.05);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
      await mkdir(".factory/test-results/auth-coherence", { recursive: true });
      await page.screenshot({
        path: `.factory/test-results/auth-coherence/sign-in-${background}-${width}.png`,
        fullPage: true,
      });
    }
  });
}
