import { expect, type Page } from "@playwright/test";

/** Use the desktop sidebar or the small-screen title menu. */
export async function chooseSettingsPage(page: Page, label: string, group?: string) {
  const workspace = page
    .getByRole("region", { name: "Settings", exact: true })
    .and(page.locator(".settings-workspace"));
  const navigation = workspace.getByRole("navigation", { name: "Settings navigation" });
  await expect(workspace).toBeVisible();
  if (!(await navigation.isVisible()))
    await workspace.getByRole("button", { name: "Choose settings page", exact: true }).click();
  await expect(navigation).toBeVisible();
  const section = group
    ? navigation
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: group, exact: true }) })
    : navigation;
  await section.getByRole("button", { name: label, exact: true }).click();
}
