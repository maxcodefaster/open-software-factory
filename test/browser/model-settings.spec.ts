import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "../support/factory-fixture";

async function openFactoryModels(page: Page) {
  await signIn(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings
    .getByRole("navigation", { name: "Settings navigation" })
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Factory", exact: true }) })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  return settings;
}

test("model administration is readable and keyboard accessible at desktop and narrow widths", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mkdir(".factory/screenshots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  const settings = await openFactoryModels(page);
  const initial = await page.request.get("/api/model-settings");
  expect(initial.ok()).toBe(true);
  const models = await initial.json();
  await expect(
    settings.locator(".model-settings-note").filter({ hasText: "Research, requirements & Wiki:" }),
  ).toContainText(models.planningModelId);
  await expect(settings.getByRole("region", { name: "Role access" })).toContainText(
    "Implementation",
  );
  await expect(settings.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
  await settings.getByLabel("Used for", { exact: true }).focus();
  await expect(settings.getByLabel("Used for", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const deployment = settings.getByRole("checkbox", { name: /^Use deployment connection/ });
  if (await deployment.isVisible()) {
    await expect(deployment).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await expect(settings.getByLabel("Provider", { exact: true })).toBeFocused();
  await settings.getByLabel("Used for", { exact: true }).selectOption("build");
  await expect(settings.getByLabel("Used for", { exact: true })).toHaveValue("build");
  await page.screenshot({ path: ".factory/screenshots/model-settings-wide.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const control of await settings
    .locator(".settings-content select, .settings-content input, .settings-content button")
    .all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({ path: ".factory/screenshots/model-settings-narrow.png" });
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await expect(settings).toBeHidden();
  expect(errors).toEqual([]);
});

test("model permissions save with exact version and retain the draft on conflict", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let version = 7,
    conflict = false,
    allowOverride = true;
  const writes: unknown[] = [];
  const modelIDs = ["approved-planning", "approved-build", "approved-alternative"];
  await page.route("**/api/model-settings", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (conflict)
        return route.fulfill({
          status: 409,
          json: { error: "Model settings changed elsewhere. Reload before saving." },
        });
      expect(body.version).toBe(version);
      allowOverride = body.rules.planning.allowOverride;
      version++;
    }
    return route.fulfill({
      json: {
        version,
        source: "administrator",
        planningModelId: "approved-planning",
        buildModelId: "approved-build",
        models: modelIDs,
        rules: {
          planning: { models: modelIDs, allowOverride },
          build: { models: modelIDs, allowOverride: true },
        },
        connection: { configured: true, host: "provider.example" },
      },
    });
  });
  const settings = await openFactoryModels(page);
  await settings.getByText("Model override permissions", { exact: true }).click();
  const planning = settings
    .locator(".model-policy")
    .filter({ has: page.locator("summary").filter({ hasText: /^Planning permissions$/ }) })
    .last();
  await planning.locator("summary").click();
  const override = planning.getByLabel("Allow Project and personal overrides");
  await override.uncheck();
  await settings.getByRole("button", { name: "Save permissions" }).click();
  await expect(settings.getByText("Defaults saved", { exact: true })).toBeVisible();
  expect(writes).toEqual([
    {
      version: 7,
      planningModelId: "approved-planning",
      buildModelId: "approved-build",
      rules: {
        planning: { models: modelIDs, allowOverride: false },
        build: { models: modelIDs, allowOverride: true },
      },
    },
  ]);
  conflict = true;
  await override.check();
  await settings.getByRole("button", { name: "Save permissions" }).click();
  await expect(settings.getByRole("alert")).toHaveText(
    "Model settings changed elsewhere. Reload before saving.",
  );
  await expect(override).toBeChecked();
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(override).toBeChecked();
  await settings.getByRole("button", { name: "Reload settings" }).click();
  await expect(override).not.toBeChecked();
  expect(errors).toEqual([]);
});
