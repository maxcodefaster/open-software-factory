import type { Page } from "@playwright/test";

/** Project switching is a secondary action in the desktop Settings menu. */
export async function openProjectMenu(page: Page) {
  const switcher = page.getByRole("button", { name: "Open project menu", exact: true });
  if (!(await switcher.isVisible()))
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await switcher.click();
}
