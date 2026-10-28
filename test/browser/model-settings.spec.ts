import { mkdir } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { modelSettingsView } from "../../packages/conversation-domain/src/model-settings";
import type { ModelConnectionView } from "../../packages/conversation-domain/src/model-connection";
import { CommandError } from "../../apps/factory/src/command-error";
import { mockFactoryFunctions, browserFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { signIn } from "../support/factory-fixture";

test.beforeEach(async ({ page }) => {
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Settings fixture owns no editor compute");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Settings fixture owns no editor compute");
      },
    },
  });
});

async function openFactoryModels(page: Page) {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  // This case tests model administration after initial Project selection, not
  // opening a Factory-scope workspace while the planning projection connects.
  const projects = await serverCall(browserFunction(page, "getProjects", []));
  if (projects.projects.length)
    await expect(
      page.getByRole("button", { name: "Open project menu", exact: true }),
    ).not.toContainText("Choose project");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings
    .getByRole("navigation", { name: "Settings navigation" })
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Factory administration", exact: true }) })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  return settings;
}

test("first-run model setup has no placeholder defaults and keeps its primary action in view", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  const models = ["factory-planning-model", "factory-coding-model"];
  await mockFactoryFunctions(page, {
    models: {
      get: async () =>
        modelSettingsView.parse({
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
        }),
      catalogue: async () => ({
        providers: [{ provider: "openai", label: "OpenAI", models: ["example-model"] }],
        connections: [],
        roles: [
          { role: "planning", active: null, check: null },
          { role: "build", active: null, check: null },
        ],
        deployment: [],
      }),
    },
  });
  const settings = await openFactoryModels(page);
  await expect(settings.getByRole("region", { name: "Coding", exact: true })).toContainText(
    "Not configured",
  );
  await expect(settings.getByLabel("Used for", { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("checkbox", { name: /^Use deployment connection/ })).toHaveCount(
    0,
  );
  await expect(settings).not.toContainText("factory-planning-model");
  await expect(settings).not.toContainText("factory-coding-model");
  for (const control of [
    settings.getByRole("heading", { name: "Planning & knowledge", exact: true }),
    settings.getByRole("heading", { name: "Coding", exact: true }),
    settings.getByRole("button", { name: "Add connection", exact: true }),
  ]) {
    await expect(control).toBeInViewport();
  }
  await mkdir(".factory/test-results/model-settings", { recursive: true });
  await page.screenshot({ path: ".factory/test-results/model-settings/first-run-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await settings.getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(settings.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await expect(settings.getByText(/Keys encrypted in OpenBao/)).toBeVisible();
  await page.screenshot({ path: ".factory/test-results/model-settings/first-run-narrow.png" });
  expect(errors).toEqual([]);
});

test("a newly adopted connection stays selected while its check runs and after the catalogue refresh", async ({
  page,
}) => {
  const original = {
    connectionID: crypto.randomUUID(),
    provider: "openai" as const,
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
  await mockFactoryFunctions(page, {
    models: {
      catalogue: async () => ({
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
      }),
      adoptDeployment: async () => {
        adopted = true;
        return selected;
      },
      selectRole: async () => {
        probing.resolve();
        await finish.promise;
        return {
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
        };
      },
    },
  });
  const settings = await openFactoryModels(page);
  const planning = settings.getByRole("region", { name: "Planning & knowledge", exact: true });
  await planning.locator(".model-role-connection summary").click();
  await planning.getByLabel("Connection", { exact: true }).selectOption(selected.connectionID);
  await planning.getByLabel("Model", { exact: true }).selectOption("example-model");
  await planning.getByRole("button", { name: "Save & check", exact: true }).click();
  await probing.promise;
  try {
    await expect(planning.getByLabel("Connection", { exact: true })).toHaveValue(
      selected.connectionID,
      { timeout: 1000 },
    );
  } finally {
    finish.resolve();
  }
  await expect(
    planning.getByRole("status").filter({ hasText: "Model saved. Access checked." }),
  ).toBeVisible();
  await expect(planning.getByLabel("Connection", { exact: true })).toHaveValue(
    selected.connectionID,
  );
  await expect(
    planning.getByLabel("Connection", { exact: true }).locator("option:checked"),
  ).toContainText("new-model.example");
});

test("model administration is readable and keyboard accessible at desktop and narrow widths", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mkdir(".factory/test-results/model-settings", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  const settings = await openFactoryModels(page);
  const connections = await serverCall(browserFunction(page, "getModelConnections", []));
  await expect
    .poll(() =>
      settings.locator(".settings-scope-description").evaluate((element) => {
        const rows = element.closest(".settings-content")?.querySelector(".model-defaults");
        return rows
          ? Math.abs(
              rows.getBoundingClientRect().x -
                element.getBoundingClientRect().x -
                Number.parseFloat(getComputedStyle(element).paddingLeft),
            )
          : Number.POSITIVE_INFINITY;
      }),
    )
    .toBeLessThanOrEqual(1);
  for (const role of connections.roles) {
    const expected =
      role.active?.modelId ??
      connections.deployment.find(
        (entry: { role: string; configured: boolean }) =>
          entry.role === role.role && entry.configured,
      )?.modelId ??
      "Not configured";
    const card = settings.getByRole("region", {
      name: role.role === "build" ? "Coding" : "Planning & knowledge",
      exact: true,
    });
    if (expected === "Not configured") await expect(card).toContainText(expected);
    else await expect(card.getByLabel("Model", { exact: true })).toHaveValue(expected);
  }
  const connectionsPanel = settings.locator(".model-credentials");
  if (!(await connectionsPanel.evaluate((element) => (element as HTMLDetailsElement).open)))
    await connectionsPanel.locator("summary").first().click();
  await settings.getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(settings.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
  await settings.getByLabel("Provider", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(settings.getByLabel("API key", { exact: true })).toBeFocused();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.screenshot({ path: ".factory/test-results/model-settings/models-wide.png" });
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
  await page.screenshot({ path: ".factory/test-results/model-settings/models-narrow.png" });
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
  const view = () =>
    modelSettingsView.parse({
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
    });
  await mockFactoryFunctions(page, {
    models: {
      get: async () => view(),
      set: async (_actor, body) => {
        writes.push(body);
        if (conflict)
          throw new CommandError(
            "conflict",
            "Model settings changed elsewhere. Reload before saving.",
          );
        expect(body.version).toBe(version);
        if (!body.rules) throw new Error("Permissions save must carry the edited rules");
        allowOverride = body.rules.planning.allowOverride;
        version++;
        return view();
      },
    },
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
        build: { models: modelIDs, allowOverride: true, reasoningEffort: "medium" },
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

test("Coding reasoning is adjustable without permitting low or disabled reasoning and retains conflicts", async ({
  page,
}) => {
  let version = 4;
  let reasoningEffort: "medium" | "high" | "xhigh" | "max" = "medium";
  let conflict = false;
  const connectionID = crypto.randomUUID();
  const writes: unknown[] = [];
  await mockFactoryFunctions(page, {
    models: {
      catalogue: async () => ({
        providers: [{ provider: "openai", label: "OpenAI", models: ["plan", "gpt-6.1-sol"] }],
        connections: [
          {
            connectionID,
            version: 1,
            provider: "openai",
            endpoint: "https://owned.openai.azure.com/openai/v1",
            configured: true,
            pendingCommandID: null,
          },
        ],
        roles: [
          { role: "planning", active: { connectionID, version: 1, modelId: "plan" }, check: null },
          {
            role: "build",
            active: { connectionID, version: 1, modelId: "gpt-6.1-sol" },
            check: null,
          },
        ],
        deployment: [],
      }),
      selectRole: async (_actor, value) => {
        writes.push(value);
        if (conflict) throw new CommandError("conflict", "Settings changed elsewhere");
        expect(value.settingsVersion).toBe(version);
        expect(value.role).toBe("build");
        expect(value.connectionID).toBe(connectionID);
        expect(value.modelId).toBe("gpt-6.1-sol");
        if (!value.reasoningEffort)
          throw new Error("Coding check must carry the selected reasoning");
        reasoningEffort = value.reasoningEffort;
        version++;
        return {
          status: "ready",
          modelId: value.modelId,
          toolCall: true,
          structuredOutput: false,
          limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
        };
      },
      get: async () =>
        modelSettingsView.parse({
          version,
          source: "administrator",
          planningModelId: "plan",
          buildModelId: "gpt-6.1-sol",
          models: ["plan", "gpt-6.1-sol"],
          rules: {
            planning: { models: ["plan"], allowOverride: true },
            build: { models: ["gpt-6.1-sol"], allowOverride: true, reasoningEffort },
          },
          connection: { configured: true, host: "owned.openai.azure.com" },
        }),
    },
  });
  const settings = await openFactoryModels(page);
  const coding = settings.getByRole("region", { name: "Coding", exact: true });
  const select = coding.getByLabel("Reasoning", { exact: true });
  await expect(select).toHaveValue("medium");
  expect(
    await select
      .locator("option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  ).toEqual(["medium", "high", "xhigh", "max"]);
  await select.selectOption("high");
  await coding.getByRole("button", { name: "Save & check", exact: true }).click();
  await expect(coding.getByText("Model saved. Access checked.", { exact: true })).toBeVisible();
  expect(reasoningEffort).toBe("high");
  conflict = true;
  await select.selectOption("xhigh");
  await coding.getByRole("button", { name: "Save & check", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveText("Settings changed elsewhere");
  await expect(select).toHaveValue("xhigh");
  await settings.getByRole("button", { name: "Reload settings" }).click();
  await expect(select).toHaveValue("high");
  expect(writes).toHaveLength(2);
  await mkdir(".factory/test-results/model-settings", { recursive: true });
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".factory/test-results/model-settings/coding-reasoning-wide.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await select.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".factory/test-results/model-settings/coding-reasoning-narrow.png",
  });
});

test("connection setup is separate from model calls, recovers a rejected endpoint and never repopulates a saved key", async ({
  page,
}) => {
  let saved: ModelConnectionView | undefined;
  const writes: Array<{ commandID: string }> = [];
  let roleCalls = 0;
  await mockFactoryFunctions(page, {
    models: {
      catalogue: async () => ({
        providers: [{ provider: "openai", label: "OpenAI", models: ["example-model"] }],
        connections: saved ? [saved] : [],
        roles: [],
        deployment: [],
      }),
      selectRole: async () => {
        roleCalls++;
        throw new Error("This connection-only test must never probe");
      },
      connection: async () => {
        throw new CommandError("not-found", "No connection write was admitted");
      },
      saveConnection: async (_actor, value) => {
        writes.push(value);
        if (writes.length === 1)
          throw new CommandError("conflict", "Model endpoint must use HTTPS");
        saved = {
          connectionID: value.connectionID,
          version: 1,
          provider: value.provider,
          endpoint: value.endpoint,
          configured: true,
          pendingCommandID: null,
        };
        return saved;
      },
    },
  });
  const settings = await openFactoryModels(page);
  await settings.getByRole("button", { name: "Add connection", exact: true }).click();
  const key = settings.getByLabel("API key", { exact: true });
  await key.fill("owned-fake-provider-key");
  await settings.getByText("Custom endpoint, including Azure", { exact: true }).click();
  const endpoint = settings.getByLabel("Approved HTTPS endpoint", { exact: true });
  await endpoint.fill("http://owned.invalid/v1");
  await settings.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveText("Model endpoint must use HTTPS");
  await expect(endpoint).toBeEnabled();
  await expect(key).toBeEnabled();
  await endpoint.fill("https://owned.openai.azure.com/openai/v1");
  await settings.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(
    settings.getByRole("status").filter({ hasText: "Connection encrypted in OpenBao." }),
  ).toBeVisible();
  expect(roleCalls).toBe(0);
  expect(writes).toHaveLength(2);
  expect(writes[1]?.commandID).not.toBe(writes[0]?.commandID);
  await settings.getByRole("button", { name: /^Update key for/ }).click();
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("type", "password");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(key).toHaveCount(0);
});
