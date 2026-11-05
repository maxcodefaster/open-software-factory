import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { CommandError } from "../../apps/factory/src/command-error";
import { modelSettingsView } from "../../packages/conversation-domain/src/model-settings";
import { test } from "../fixtures/browser-test";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { factoryFixtureStart } from "../fixtures/start-plugins";

const evidence = ".factory/test-results/settings-load-failures";
const cache = resolve(".factory/test-results/vite", `settings-load-${crypto.randomUUID()}`);
const projectID = "10000000-0000-4000-8000-000000000001";
const unreachable = () => new CommandError("unavailable", "Factory could not be reached.");
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["repository-mirrors.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("Settings fixture address missing");
  origin = address.replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

const authentication = async () => ({
  fresh: true,
  companySignIn: false,
  email: "admin@fixture.test",
});

test("a failed Project list on Repository mirrors offers a reload and never shows a stuck loading line", async ({
  page,
}) => {
  let reads = 0;
  await mockFactoryFunctions(page, {
    access: { authentication },
    repositoryMirrors: {
      projects: async () => {
        if (++reads === 1) throw unreachable();
        return [{ id: projectID, name: "Invoice workspace" }];
      },
      get: async () => ({ projectID, mirrors: [], pending: null }),
    },
  });
  await page.goto(`${origin}/repository-mirrors.html`);
  await chooseSettingsPage(page, "Repository mirrors", "Factory administration");
  const region = page.getByRole("region", { name: "Repository mirrors", exact: true });
  await expect(region.getByRole("alert")).toContainText("Projects could not be loaded");
  await expect(region.getByText("Loading Projects…")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/mirrors-failed.png` });
  await region.getByRole("button", { name: "Reload Projects", exact: true }).click();
  await expect(region.getByRole("combobox", { name: "Project", exact: true })).toBeVisible();
  await expect(region.getByRole("alert")).toHaveCount(0);
  expect(reads).toBe(2);
});

test("a failed Project member load does not claim the Project has no members", async ({ page }) => {
  let reads = 0;
  await mockFactoryFunctions(page, {
    access: {
      authentication,
      policy: async () => ({ companySignIn: false, sessionDays: 7 }),
      members: async () => {
        if (++reads === 1) throw unreachable();
        return { members: [] };
      },
    },
  });
  await page.goto(`${origin}/repository-mirrors.html`);
  await chooseSettingsPage(page, "People & access", "Project · Invoice workspace");
  const region = page.getByRole("region", { name: "People & access", exact: true });
  await expect(region.getByRole("alert")).toBeVisible();
  await expect(region.getByText("No project members yet.")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/members-failed.png` });
  await region.getByRole("button", { name: "Reload access", exact: true }).click();
  await expect(region.getByText("No project members yet.")).toBeVisible();
  await expect(region.getByRole("alert")).toHaveCount(0);
});

test("a failed security load explains itself and reloads the sign-in and password sections", async ({
  page,
}) => {
  let reads = 0;
  await mockFactoryFunctions(page, {
    access: {
      authentication,
      policy: async () => {
        if (++reads === 1) throw unreachable();
        return { companySignIn: false, sessionDays: 7 };
      },
      passwordChange: async () => ({ available: true }),
    },
  });
  await page.goto(`${origin}/repository-mirrors.html`);
  await chooseSettingsPage(page, "Login & security", "Personal");
  const region = page.getByRole("region", { name: "Login & security", exact: true });
  await expect(region.getByRole("alert")).toBeVisible();
  await expect(region.getByRole("heading", { name: "Change password" })).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/security-failed.png` });
  await region.getByRole("button", { name: "Reload security settings", exact: true }).click();
  await expect(region.getByRole("heading", { name: "Sign-in", exact: true })).toBeVisible();
  await expect(region.getByRole("heading", { name: "Change password" })).toBeVisible();
  await expect(region.getByRole("alert")).toHaveCount(0);
});

test("a failed Usage read on Factory Monitoring offers a reload instead of a loading line", async ({
  page,
}) => {
  let reads = 0;
  await mockFactoryFunctions(page, {
    access: { authentication },
    usage: {
      get: async () => {
        reads++;
        throw unreachable();
      },
    },
  });
  await page.goto(`${origin}/repository-mirrors.html`);
  await chooseSettingsPage(page, "Monitoring", "Factory administration");
  const usage = page.getByRole("region", { name: "Usage & limits", exact: true });
  await expect(usage.locator(".usage-load-error").getByRole("alert")).toBeVisible();
  await expect(usage.getByText("Loading usage…")).toHaveCount(0);
  const before = reads;
  await usage.getByRole("button", { name: "Reload usage", exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
});

test.describe("touch settings", () => {
  test.use({ viewport: { width: 390, height: 1000 }, isMobile: true, hasTouch: true });
  test("disclosure rows on Models and Add account are at least 44px tall", async ({ page }) => {
    await mockFactoryFunctions(page, {
      access: { authentication, users: async () => ({ users: [] }) },
      models: {
        get: async () =>
          modelSettingsView.parse({
            version: 1,
            source: "administrator",
            planningModelId: "example-model",
            buildModelId: "example-model",
            models: ["example-model"],
            rules: {
              planning: { models: ["example-model"], allowOverride: true },
              build: { models: ["example-model"], allowOverride: true, reasoningEffort: "medium" },
            },
            connection: { configured: true, host: "models.example" },
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
    await page.goto(`${origin}/repository-mirrors.html`);
    await chooseSettingsPage(page, "Models", "Factory administration");
    const models = page.locator(".model-credentials > summary, .model-policy > summary");
    await expect(models.first()).toBeVisible();
    for (const summary of await models.all())
      expect((await summary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await page.locator(".model-policy > summary").first().click();
    await page.locator(".model-policy details > summary").first().click();
    const choices = page.locator(".model-policy .model-checkbox:visible");
    await expect(choices.first()).toBeVisible();
    for (const choice of await choices.all())
      expect((await choice.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    const endpoint = page.locator(".model-credential-form > details > summary");
    await expect(endpoint).toBeVisible();
    expect((await endpoint.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await chooseSettingsPage(page, "People & access", "Factory administration");
    const add = page.locator(".access-add-account > summary");
    await expect(add).toBeVisible();
    expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await page.screenshot({ path: `${evidence}/touch-disclosures.png` });
  });
});
