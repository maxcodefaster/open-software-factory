import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { signIn } from "../support/factory-fixture";

test("a retained skill draft explains why Edit skill is unavailable", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await chooseSettingsPage(page, "Skills", "Libraries");
  const library = page.locator(".skill-library:visible");
  await library.getByRole("button", { name: "Add skill", exact: true }).click();
  await library
    .getByRole("form", { name: "Skill editor" })
    .getByLabel("Name", { exact: true })
    .fill("Draft only");
  await library.getByRole("button", { name: "Back to library", exact: true }).click();
  const tiles = library.getByRole("button", { name: /^Inspect / });
  await expect(tiles.first()).toBeVisible();
  let checked = 0;
  for (const tile of await tiles.all()) {
    await tile.click();
    const edit = library.getByRole("button", { name: "Edit skill", exact: true });
    if (await edit.count()) {
      await expect(edit).toBeDisabled();
      await expect(
        library.getByText("Resume or discard your existing draft before editing this skill."),
      ).toBeVisible();
      checked++;
    }
    await library.getByRole("button", { name: "Back to library", exact: true }).click();
  }
  expect(checked).toBeGreaterThan(0);
});
