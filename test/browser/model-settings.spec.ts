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

test("first-run model setup has no placeholder defaults and keeps its primary action in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const models = ["factory-planning-model", "factory-coding-model"];
  await page.route("**/api/model-settings", (route) =>
    route.fulfill({
      json: {
        version: 0,
        source: "environment",
        planningModelId: models[0],
        buildModelId: models[1],
        models,
        rules: {
          planning: { models, allowOverride: true },
          build: { models, allowOverride: true },
        },
        connection: { configured: false, host: null },
      },
    }),
  );
  await page.route("**/api/model-connections", (route) =>
    route.fulfill({
      json: {
        providers: [{ provider: "openai", label: "OpenAI", models: ["example-model"] }],
        connections: [],
        roles: [
          { role: "planning", active: null, check: null },
          { role: "build", active: null, check: null },
        ],
        deployment: [],
      },
    }),
  );
  const settings = await openFactoryModels(page);
  await expect(settings.getByRole("region", { name: "Role access" })).toContainText(
    "Not configured",
  );
  await expect(settings).not.toContainText("factory-planning-model");
  await expect(settings).not.toContainText("factory-coding-model");
  for (const control of [
    settings.getByLabel("Used for", { exact: true }),
    settings.getByLabel("Provider", { exact: true }),
    settings.getByLabel("API key", { exact: true }),
    settings.getByLabel("Model", { exact: true }),
    settings.getByRole("button", { name: "Save and check", exact: true }),
  ]) {
    await expect(control).toBeInViewport();
  }
  await mkdir(".factory/test-results/model-settings", { recursive: true });
  await page.screenshot({ path: ".factory/test-results/model-settings/first-run-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await settings.getByLabel("Model", { exact: true }).fill("example-model");
  await settings
    .getByRole("button", { name: "Save and check", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".factory/test-results/model-settings/first-run-narrow.png" });
});

test("a newly adopted connection stays selected while its check runs and after the catalogue refresh", async ({
  page,
}) => {
  const original = {
    connectionID: crypto.randomUUID(),
    provider: "openai",
    endpoint: "https://old-model.example/v1",
    version: 1,
    configured: true,
    pendingCommandID: null,
  };
  const selected = {
    ...original,
    connectionID: crypto.randomUUID(),
    endpoint: "https://new-model.example/v1",
  };
  let adopted = false;
  const probing = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  await page.route("**/api/model-connections", (route) =>
    route.fulfill({
      json: {
        providers: [{ provider: "openai", label: "OpenAI", models: ["example-model"] }],
        connections: adopted ? [original, selected] : [original],
        roles: [{ role: "planning", active: null, check: null }],
        deployment: [
          {
            role: "planning",
            provider: "openai",
            modelId: "example-model",
            endpoint: selected.endpoint,
            configured: true,
            connectionID: selected.connectionID,
          },
        ],
      },
    }),
  );
  await page.route("**/api/model-connections/deployment", (route) => {
    adopted = true;
    return route.fulfill({ json: selected });
  });
  await page.route("**/api/model-connections/role", async (route) => {
    probing.resolve();
    await finish.promise;
    await route.fulfill({
      json: {
        status: "ready",
        modelId: "example-model",
        toolCall: true,
        structuredOutput: true,
        limits: {
          requests: null,
          tokens: null,
          remainingRequests: null,
          remainingTokens: null,
        },
      },
    });
  });
  const settings = await openFactoryModels(page);
  await settings.getByRole("checkbox", { name: /^Use deployment connection/ }).check();
  await settings.getByRole("button", { name: "Save and check", exact: true }).click();
  await probing.promise;
  try {
    await expect(settings.getByLabel("Connection", { exact: true })).toHaveValue(
      selected.connectionID,
      { timeout: 1000 },
    );
  } finally {
    finish.resolve();
  }
  await expect(
    settings.getByRole("status").filter({ hasText: "Model ready for new work." }),
  ).toBeVisible();
  await expect(settings.getByLabel("Connection", { exact: true })).toHaveValue(
    selected.connectionID,
  );
  await expect(
    settings.getByLabel("Connection", { exact: true }).locator("option:checked"),
  ).toHaveText("new-model.example");
});

test("model administration is readable and keyboard accessible at desktop and narrow widths", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mkdir(".factory/screenshots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  const settings = await openFactoryModels(page);
  const initial = await page.request.get("/api/model-connections");
  expect(initial.ok()).toBe(true);
  const connections = await initial.json();
  for (const role of connections.roles) {
    const expected =
      role.active?.modelId ??
      connections.deployment.find(
        (entry: { role: string; configured: boolean }) =>
          entry.role === role.role && entry.configured,
      )?.modelId ??
      "Not configured";
    await expect(settings.getByRole("region", { name: "Role access" })).toContainText(expected);
  }
  await expect(settings.getByRole("region", { name: "Role access" })).toContainText(
    "Implementation",
  );
  await expect(settings.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
  await settings.getByLabel("Used for", { exact: true }).focus();
  await expect(settings.getByLabel("Used for", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settings.getByLabel("Provider", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const deployment = settings.getByRole("checkbox", { name: /^Use deployment connection/ });
  if (await deployment.isVisible()) {
    await expect(deployment).toBeFocused();
  }
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
