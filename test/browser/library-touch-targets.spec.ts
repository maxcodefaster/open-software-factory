import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });

test("skill and MCP editors keep 44px touch targets for disclosures and role choices", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await chooseSettingsPage(page, "Skills", "Libraries");
  const library = page.locator(".skill-library:visible");
  await library.getByRole("button", { name: "Add skill", exact: true }).click();
  const options = library.locator(".skill-editor details > summary").first();
  await expect(options).toBeVisible();
  expect((await options.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  await library.getByRole("button", { name: "Back to library", exact: true }).click();

  await chooseSettingsPage(page, "MCP connections", "Libraries");
  const mcp = page.locator(".mcp-library:visible");
  await mcp.getByRole("button", { name: /Add MCP/ }).click();
  const roles = mcp.locator(".mcp-checkbox");
  await expect(roles.first()).toBeVisible();
  for (const role of await roles.all())
    expect((await role.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
});
