import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { signIn } from "../support/factory-fixture";

async function memberSignIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function openSecurity(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await chooseSettingsPage(page, "Login & security", "Personal");
  return page.getByRole("region", { name: "Change password" });
}

test("a person rotates their initial password in the owned Factory and other sessions end", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const email = `rotate-${crypto.randomUUID()}@factory.local`;
  const initial = "owned-initial-password-1";
  const rotated = "owned-rotated-password-2";
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const dialog = page.getByRole("region", { name: "Settings", exact: true });
  await chooseSettingsPage(page, "People & access", "Factory administration");
  await dialog.getByText("Add account", { exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Password rotation QA");
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByLabel("Initial password", { exact: false }).fill(initial);
  await dialog.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Account created");

  const hereContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const otherContext = await browser.newContext();
  try {
    const here = await hereContext.newPage();
    const other = await otherContext.newPage();
    await memberSignIn(other, email, initial);
    await expect(other.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await memberSignIn(here, email, initial);
    const region = await openSecurity(here);
    await expect(region).toBeVisible();
    const submit = region.getByRole("button", { name: "Change password", exact: true });
    const fill = async (current: string, next: string, confirm = next) => {
      await region.getByLabel("Current password", { exact: true }).fill(current);
      await region.getByLabel("New password", { exact: true }).fill(next);
      await region.getByLabel("Confirm new password", { exact: true }).fill(confirm);
      await submit.click();
    };
    await fill("not-the-current-password", rotated);
    await expect(region.getByRole("alert")).toHaveText("The current password is incorrect.");
    await fill(initial, "short");
    await expect(region.getByRole("alert")).toHaveText(/at least 12 characters/);
    await fill(initial, initial);
    await expect(region.getByRole("alert")).toHaveText(/differs from the current/);
    await fill(initial, rotated);
    await expect(region.getByRole("status")).toContainText("Password changed.");
    await expect(region.getByLabel("Current password", { exact: true })).toHaveValue("");

    // This session stays signed in; the other one has ended.
    await here.reload();
    await expect(here.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await other.reload();
    await expect(other.getByLabel("Email", { exact: true })).toBeVisible();

    const fresh = await browser.newContext();
    try {
      const page2 = await fresh.newPage();
      await memberSignIn(page2, email, initial);
      await expect(page2.getByRole("alert")).toHaveText("Invalid email or password");
      await memberSignIn(page2, email, rotated);
      await expect(page2.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    } finally {
      await fresh.close();
    }
  } finally {
    await hereContext.close();
    await otherContext.close();
    // The disposable account is disabled so it cannot sign in again.
    await dialog
      .getByRole("button", { name: "Access actions for Password rotation QA", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Disable account" }).click();
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Account disabled");
  }
});
