import { expect, type Page } from "@playwright/test";

type SettingsScope = "project" | "libraries" | "personal" | "system";

async function openSettingsNavigation(page: Page) {
  const workspace = page
    .getByRole("region", { name: "Settings", exact: true })
    .and(page.locator(".settings-workspace"));
  const navigation = workspace.getByRole("navigation", { name: "Settings navigation" });
  await expect(workspace).toBeVisible();
  if (!(await navigation.isVisible()))
    await workspace.getByRole("button", { name: /choose settings page$/i }).click();
  await expect(navigation).toBeVisible();
  return navigation;
}

/** Ensure the requested Settings section is visible, including on narrow screens. */
export async function chooseSettingsScope(page: Page, scope: SettingsScope) {
  const navigation = await openSettingsNavigation(page);
  await expect(navigation.locator(`section[data-settings-scope="${scope}"]`)).toBeVisible();
}

/** Use the desktop sidebar or the small-screen title menu. */
export async function chooseSettingsPage(page: Page, label: string, group?: string) {
  const navigation = await openSettingsNavigation(page);
  const section = group
    ? navigation
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: group, exact: true }) })
    : navigation;
  await section.getByRole("button", { name: label, exact: true }).click();
}

export async function openSetupRecovery(page: Page, group?: string) {
  await chooseSettingsPage(page, "Environments", group);
  const disclosure = page.locator(".settings-setup-recovery");
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
  await expect(
    page.getByRole("region", { name: "Project setup settings", exact: true }),
  ).toBeVisible();
}
