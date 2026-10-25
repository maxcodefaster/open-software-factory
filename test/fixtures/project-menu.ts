import type { Page } from "@playwright/test";

/** Desktop has a direct selector; phones keep Project switching in Settings. */
export async function openProjectMenu(page: Page) {
  const switcher = page.getByRole("button", { name: "Open project menu", exact: true });
  if (!(await switcher.isVisible()))
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await switcher.click();
}
