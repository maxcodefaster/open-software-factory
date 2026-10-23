import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  type EnvironmentBundle,
  type EnvironmentSettingsView,
  environmentMetadata,
  environmentWrite,
  replaceEnvironment,
} from "../../packages/project-domain/src/environment";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn } from "../support/factory-fixture";

test("Environment settings retain typing focus, mask saves, preview literal imports and isolate scopes", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const bundles = new Map<string, EnvironmentBundle>();
  const versions = new Map<string, number>();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let lastSaved = "";
  await page.route("**/api/projects/*/environments/*", async (route) => {
    const environment = route.request().url().endsWith("main-preview")
      ? "main-preview"
      : "development";
    let bundle = bundles.get(environment) ?? { variables: [], registries: [] };
    if (route.request().method() === "PUT") {
      const input = environmentWrite.parse(route.request().postDataJSON());
      expect(input.version).toBe(versions.get(environment) ?? 0);
      bundle = replaceEnvironment(input, bundle);
      bundles.set(environment, bundle);
      versions.set(environment, input.version + 1);
      lastSaved = environment;
    }
    const view: EnvironmentSettingsView = {
      ...environmentMetadata(bundle),
      environment,
      version: versions.get(environment) ?? 0,
      canManage: true,
      storeConfigured: true,
      pending: false,
      pendingCommandID: null,
    };
    await route.fulfill({ json: view });
  });
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page
    .getByRole("region", { name: "Projects", exact: true })
    .getByRole("button")
    .filter({ hasText: "factory-starter" })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Environments", exact: true }).click();
  const area = settings.getByRole("region", { name: "Project environment" });
  await area.getByRole("button", { name: "Add variable", exact: true }).click();
  const name = area.getByRole("textbox", { name: "Variable 1 name" });
  await name.pressSequentially("API_KEY");
  await expect(name).toHaveValue("API_KEY");
  await expect(name).toBeFocused();
  const value = area.getByRole("textbox", { name: "Value for API_KEY", exact: true });
  await value.pressSequentially("owned-browser-value");
  await expect(value).toBeFocused();
  await area.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(value).toHaveValue("");
  await expect(
    area.getByText("Saved. New starts use these settings; restart existing compute to apply."),
  ).toBeVisible();
  expect(lastSaved).toBe("development");
  await area.getByText("Paste .env", { exact: true }).click();
  await area
    .getByRole("textbox", { name: "Paste environment variables" })
    .fill('MULTILINE="first\nsecond"\nOTHER=literal-$VALUE');
  await area.getByRole("button", { name: "Preview import" }).click();
  await expect(area.getByText("MULTILINE, OTHER · values hidden")).toBeVisible();
  await area.getByRole("button", { name: "Apply to draft" }).click();
  await expect(area.getByRole("textbox", { name: "Paste environment variables" })).toHaveValue("");
  await area.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(area.getByRole("textbox", { name: "Value for MULTILINE", exact: true })).toHaveValue(
    "",
  );
  expect(bundles.get("development")?.variables[1]?.value).toBe("first\nsecond");
  await area.getByRole("button", { name: "Main-Preview", exact: true }).click();
  await expect(area.getByRole("textbox", { name: "Variable 1 name" })).toHaveCount(0);
  await area.getByRole("button", { name: "Development", exact: true }).click();
  await expect(area.getByRole("textbox", { name: "Variable 1 name" })).toHaveValue("API_KEY");
  await expect(value).toHaveValue("");
  await mkdir(".factory/screenshots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: ".factory/screenshots/project-environment-wide.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".factory/screenshots/project-environment-narrow.png" });
  expect(errors).toEqual([]);
});
