import type { Page } from "@playwright/test";

export async function invalidateFixtureRead(page: Page, scope: "inputs" | "sources" | "releases") {
  await page.evaluate((scope) => {
    window.dispatchEvent(new CustomEvent("factory:test-read", { detail: { scope } }));
  }, scope);
}
