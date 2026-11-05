import { expect, type Page } from "@playwright/test";

type SettingsScope = "project" | "libraries" | "personal" | "system";

/** Select the same explicit scope offered to a person, including on narrow screens. */
export async function chooseSettingsScope(page: Page, scope: SettingsScope) {
  const workspace = page
    .getByRole("region", { name: "Settings", exact: true })
    .and(page.locator(".settings-workspace"));
  const navigation = workspace.getByRole("navigation", { name: "Settings navigation" });
  await expect(workspace).toBeVisible();
  if (!(await navigation.isVisible()))
    await workspace.getByRole("button", { name: /choose settings page$/i }).click();
  const picker = navigation.getByRole("combobox", { name: "Settings scope", exact: true });
  await expect(picker).toBeVisible();
  if ((await picker.inputValue()) === scope) return;
  // selectOption dispatches change without focusing the native select. A real
  // person keeps focus here while the old scope's buttons are replaced.
  await picker.focus();
  expect(await picker.selectOption(scope)).toEqual([scope]);
  // The chosen scope can lazy-load its first page and replace the temporary
  // header. Reopen the current page's control, not a now-hidden loading header.
  await expect(
    workspace.getByRole("status").filter({ hasText: /^Opening settings…$/ }),
  ).toHaveCount(0);
  if (await workspace.getByRole("button", { name: /choose settings page$/i }).isVisible())
    await expect(workspace.locator('nav[aria-label="Settings navigation"]')).toHaveAttribute(
      "data-navigation-open",
      "false",
    );
}

/** Use the desktop sidebar or the small-screen title menu. */
export async function chooseSettingsPage(page: Page, label: string, group?: string) {
  const scope =
    group === "Factory administration"
      ? "system"
      : group === "Personal"
        ? "personal"
        : group === "Libraries"
          ? "libraries"
          : group?.startsWith("Project · ")
            ? "project"
            : ["Skills", "MCP connections"].includes(label)
              ? "libraries"
              : ["Model overrides", "Login & security"].includes(label)
                ? "personal"
                : ["Company sign-in", "Repository mirrors"].includes(label)
                  ? "system"
                  : ["Inputs", "Environments", "Releases"].includes(label)
                    ? "project"
                    : undefined;
  if (scope) await chooseSettingsScope(page, scope);
  const workspace = page
    .getByRole("region", { name: "Settings", exact: true })
    .and(page.locator(".settings-workspace"));
  const navigation = workspace.getByRole("navigation", { name: "Settings navigation" });
  await expect(workspace).toBeVisible();
  if (!(await navigation.isVisible()))
    await workspace.getByRole("button", { name: /choose settings page$/i }).click();
  await expect(navigation).toBeVisible();
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
