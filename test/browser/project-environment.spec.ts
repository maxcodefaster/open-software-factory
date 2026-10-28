import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDatabase } from "../../packages/db/src/client";
import {
  type EnvironmentBundle,
  type EnvironmentSettingsView,
  environmentMetadata,
  replaceEnvironment,
} from "../../packages/project-domain/src/environment";
import { openProjectMenu } from "../fixtures/project-menu";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

let fixtureProjectID = "";
let fixtureSlug = "";
let database: ReturnType<typeof createDatabase> | undefined;
test.beforeEach(async () => {
  database = createDatabase(1);
  const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
  const [actor] = await database.client<{ id: string }[]>`
    SELECT id FROM auth."user" WHERE email=${email}`;
  if (!actor) throw new Error("Owned Environment fixture administrator is unavailable");
  fixtureProjectID = crypto.randomUUID();
  fixtureSlug = `environment-proof-${fixtureProjectID.slice(0, 8)}`;
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${fixtureProjectID},${fixtureSlug},'Environment transport proof',
      'https://example.invalid/owned-environment.git','main','.devcontainer/devcontainer.json',${actor.id})`;
});
test.afterEach(async ({ page }) => {
  await page.close();
  try {
    if (fixtureProjectID) await deleteFactoryProject(fixtureProjectID, database);
  } finally {
    await database?.client.end();
    database = undefined;
    fixtureProjectID = "";
    fixtureSlug = "";
  }
});

test("Environment settings retain typing focus, mask saves, preview literal imports and isolate scopes", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const bundles = new Map<string, EnvironmentBundle>();
  const versions = new Map<string, number>();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let lastSaved = "";
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Environment fixture owns no editor compute");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Environment fixture owns no editor compute");
      },
    },
  });
  function view(environment: "development" | "main-preview"): EnvironmentSettingsView {
    return {
      ...environmentMetadata(bundles.get(environment) ?? { variables: [], registries: [] }),
      environment,
      version: versions.get(environment) ?? 0,
      canManage: true,
      storeConfigured: true,
      pending: false,
      pendingCommandID: null,
      preparation: null,
    };
  }
  await mockFactoryFunctions(page, {
    environments: {
      get: async (projectID, _actor, environment) => {
        expect(projectID).toBe(fixtureProjectID);
        return view(environment);
      },
      save: async (projectID, _actor, environment, input) => {
        expect(projectID).toBe(fixtureProjectID);
        expect(input.version).toBe(versions.get(environment) ?? 0);
        bundles.set(
          environment,
          replaceEnvironment(input, bundles.get(environment) ?? { variables: [], registries: [] }),
        );
        versions.set(environment, input.version + 1);
        lastSaved = environment;
        return view(environment);
      },
    },
  });
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page
    .getByRole("region", { name: "Projects", exact: true })
    .getByRole("button")
    .filter({ hasText: fixtureSlug })
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
  await expect(value).toHaveCount(0);
  await expect(
    area.getByText("Saved. New starts use these settings; restart existing compute to apply."),
  ).toBeVisible();
  expect(lastSaved).toBe("development");
  await area.getByRole("button", { name: "Import .env", exact: true }).click();
  await area
    .getByRole("textbox", { name: "Paste environment variables" })
    .fill('MULTILINE="first\nsecond"\nOTHER=literal-$VALUE');
  await area.getByRole("button", { name: "Preview import" }).click();
  await expect(area.getByText("MULTILINE, OTHER · values hidden")).toBeVisible();
  await area.getByRole("button", { name: "Apply to draft" }).click();
  await expect(area.getByRole("textbox", { name: "Paste environment variables" })).toHaveCount(0);
  await area.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(area.getByRole("textbox", { name: "Value for MULTILINE", exact: true })).toHaveCount(
    0,
  );
  expect(bundles.get("development")?.variables[1]?.value).toBe("first\nsecond");
  await area.getByRole("button", { name: "Main-Preview", exact: true }).click();
  await expect(area.getByRole("textbox", { name: "Variable 1 name" })).toHaveCount(0);
  await area.getByRole("button", { name: "Development", exact: true }).click();
  await expect(area.getByRole("article", { name: "API_KEY", exact: true })).toBeVisible();
  await area.getByRole("button", { name: "Actions for API_KEY", exact: true }).click();
  await area.getByRole("menuitem", { name: "Edit variable", exact: true }).click();
  await expect(value).toHaveValue("");
  await area.getByRole("button", { name: "Done editing", exact: true }).click();
  await mkdir(".factory/test-results/project-environment", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: ".factory/test-results/project-environment/wide.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".factory/test-results/project-environment/narrow.png" });
  expect(errors).toEqual([]);
});
