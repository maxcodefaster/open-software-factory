import { expect } from "bun:test";
import { type Browser, expect as visible } from "@playwright/test";
import { runtimeAccessCookie } from "./runtime-access";

export async function starterPreviewBrowser(input: {
  browser: Browser;
  base: string;
  cookie: string;
  previewID: string;
  heading: string;
  screenshot: string;
}) {
  const { browser, base, cookie, previewID, heading, screenshot } = input;
  const origin = `http://${previewID.replaceAll("-", "")}-app.runtime.localhost:${new URL(base).port}`;
  const grant = await runtimeAccessCookie(base, cookie, previewID, "app");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.addCookies(
      grant.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: origin,
      })),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    expect((await page.goto(`${origin}/runtime/${previewID}/app/`))?.status()).toBe(200);
    await page.getByRole("button", { name: "Create an account", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Delivered Starter member");
    await page.getByLabel("Email", { exact: true }).fill(`${crypto.randomUUID()}@starter.test`);
    await page.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await visible(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.reload();
    await visible(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await visible(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}
