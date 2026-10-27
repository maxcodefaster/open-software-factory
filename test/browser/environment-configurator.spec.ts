import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { CommandError } from "../../apps/factory/src/command-error";
import {
  type EnvironmentBundle,
  type EnvironmentSettingsView,
  type EnvironmentWrite,
  environmentMetadata,
  environmentWrite,
  type ProjectEnvironment,
  replaceEnvironment,
} from "../../packages/project-domain/src/environment";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { factoryFunctionMatcher, factoryFunctionMatches } from "../fixtures/server-functions";

const evidence = ".factory/test-results/environment-configurator";
const cache = resolve(".factory/test-results/vite", `environment-ui-${crypto.randomUUID()}`);
let frontend: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  frontend = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["environment-settings.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await frontend.listen();
  const url = frontend.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!url) throw new Error("Environment component server did not expose a local URL");
  origin = url;
  await mkdir(evidence, { recursive: true });
});

test.afterAll(async () => {
  await frontend?.close();
  await rm(cache, { recursive: true, force: true });
});

function initialBundle(): EnvironmentBundle {
  return {
    variables: [
      {
        name: "API_KEY",
        value: "saved-api-secret",
        runtime: true,
        build: false,
        verification: false,
      },
      { name: "HUGO_VERSION", value: "0.140", runtime: false, build: true, verification: true },
      {
        name: "PUBLIC_ORIGIN",
        value: "https://example.invalid",
        runtime: true,
        build: false,
        verification: true,
      },
    ],
    registries: [
      {
        host: "registry.example.invalid",
        username: "builder",
        password: "saved-registry-secret",
        certificate: "",
        verification: true,
      },
    ],
  };
}

test("initial environment errors retry only the read and leave save decisions explicit", async ({
  page,
}) => {
  let reads = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: string[] = [];
  const saves = await factoryFunctionMatcher("saveEnvironment");
  const discards = await factoryFunctionMatcher("discardEnvironmentSave");
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (saves(url) || discards(url)) commands.push(url.pathname);
  });
  await mockFactoryFunctions(page, {
    environments: {
      get: async (_project, _actor, environment) => {
        reads++;
        if (reads === 1) throw new CommandError("unavailable", "Environment could not load.");
        await ready;
        return {
          ...environmentMetadata(initialBundle()),
          environment,
          version: 0,
          canManage: true,
          storeConfigured: true,
          pending: false,
          pendingCommandID: null,
          preparation: null,
        };
      },
    },
  });
  await page.goto(`${origin}/environment-settings.html`);
  await chooseSettingsPage(page, "Environments");
  const area = page.getByRole("region", { name: "Project environment", exact: true });
  await expect(area.getByRole("alert")).toHaveText("Environment could not load.");
  await page.screenshot({ path: `${evidence}/read-retry.png` });
  expect(reads).toBe(1);
  const retry = area.getByRole("button", { name: "Retry loading", exact: true });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(area.getByRole("status")).toHaveText("Loading environment…");
  release();
  await expect(area.getByRole("alert")).toHaveCount(0);
  await expect(area.locator(".environment-variable")).toHaveCount(3);
  await expect(retry).toHaveCount(0);
  await area.getByRole("button", { name: "Add variable", exact: true }).click();
  await area.getByRole("textbox", { name: "Variable 4 name" }).fill("RETAINED_DRAFT");
  await area.getByRole("textbox", { name: "Value for RETAINED_DRAFT" }).fill("draft-value");
  await expect(area.getByRole("button", { name: "Save environment", exact: true })).toBeEnabled();
  await expect(retry).toHaveCount(0);
  expect(reads).toBe(2);
  expect(commands).toEqual([]);
});

for (const outcome of ["success", "failure"] as const) {
  test(`an environment read retry ignores a late ${outcome} after switching Projects`, async ({
    page,
  }) => {
    let reads = 0;
    let release!: () => void;
    const previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockFactoryFunctions(page, {
      environments: {
        get: async (projectID, _actor, environment) => {
          reads++;
          if (reads === 1) throw new CommandError("unavailable", "Environment could not load.");
          if (projectID.endsWith("001")) {
            await previous;
            if (outcome === "failure")
              throw new CommandError("unavailable", "Previous Project failed.");
          }
          return {
            ...environmentMetadata({
              variables: [
                {
                  name: projectID.endsWith("003") ? "NEXT_PROJECT" : "PREVIOUS_PROJECT",
                  value: "protected",
                  runtime: true,
                  build: false,
                  verification: false,
                },
              ],
              registries: [],
            }),
            environment,
            version: 0,
            canManage: false,
            storeConfigured: true,
            pending: false,
            pendingCommandID: null,
            preparation: null,
          };
        },
      },
    });
    await page.goto(`${origin}/environment-settings.html?switch-project`);
    await chooseSettingsPage(page, "Environments");
    const area = page.getByRole("region", { name: "Project environment", exact: true });
    await area.getByRole("button", { name: "Retry loading", exact: true }).click();
    await expect.poll(() => reads).toBe(2);
    await page.getByRole("button", { name: "Switch fixture Project" }).click();
    await expect(area.locator(".environment-variable-name")).toHaveText(["NEXT_PROJECT"]);
    const settled = page.waitForResponse((response) =>
      factoryFunctionMatches(response.url(), "getEnvironment"),
    );
    release();
    await settled;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(area.locator(".environment-variable-name")).toHaveText(["NEXT_PROJECT"]);
    await expect(area.getByRole("alert")).toHaveCount(0);
    await expect(area.getByRole("button", { name: "Add variable", exact: true })).toHaveCount(0);
    await expect(area.getByRole("button", { name: "Retry loading", exact: true })).toHaveCount(0);
    expect(reads).toBe(3);
  });
}

test("variable rows support search, filters, sorting, focused editing, imports and isolated environments", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bundles = new Map<ProjectEnvironment, EnvironmentBundle>([
    ["development", initialBundle()],
  ]);
  const versions = new Map<ProjectEnvironment, number>();
  const writes: EnvironmentWrite[] = [];
  function view(environment: ProjectEnvironment): EnvironmentSettingsView {
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
      get: async (_project, _actor, environment) => view(environment),
      save: async (_project, _actor, environment, value) => {
        const input = environmentWrite.parse(value);
        expect(input.version).toBe(versions.get(environment) ?? 0);
        writes.push(input);
        bundles.set(
          environment,
          replaceEnvironment(input, bundles.get(environment) ?? { variables: [], registries: [] }),
        );
        versions.set(environment, input.version + 1);
        return view(environment);
      },
    },
  });
  // Exercise the real SettingsWorkspace in its usual window, with synthetic service responses.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/environment-settings.html`);
  await page
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "Environments", exact: true })
    .click();
  const area = page.getByRole("region", { name: "Project environment", exact: true });
  const rows = area.locator(".environment-variable");
  const names = area.locator(".environment-variable-name");
  const search = area.getByRole("searchbox", { name: "Search variables" });
  const save = area.getByRole("button", { name: "Save environment", exact: true });
  await expect(names).toHaveText(["API_KEY", "HUGO_VERSION", "PUBLIC_ORIGIN"]);
  await expect(area.getByRole("heading", { name: "Environments", exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Environment variables", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".settings-content > .settings-content-heading")).toHaveCount(0);
  const add = area.getByRole("button", { name: "Add variable", exact: true });
  await expect(add).toHaveClass("workspace-action");
  await expect(add).toHaveAttribute("data-primary", "true");
  await expect(add).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(add.locator("svg")).toHaveCount(0);
  await expect(area.getByRole("combobox")).toHaveCount(0);
  await expect(save).toHaveCount(0);
  await expect(area.getByText("Saved", { exact: true })).toHaveCount(0);
  await expect(area.getByRole("textbox", { name: "Registry 1 host" })).toBeHidden();
  await expect(area.getByRole("region", { name: "QA recording settings" })).toHaveCount(0);
  await expect(area.locator("details")).toHaveCount(0);
  await expect(area.getByText("Advanced", { exact: true })).toHaveCount(0);
  await expect(
    area.getByRole("group", { name: "Environment actions", exact: true }).getByRole("button"),
  ).toHaveText(["Import .env", "Add variable"]);
  const importAction = area.getByRole("button", { name: "Import .env", exact: true });
  await expect(importAction).toHaveClass("workspace-action");
  await expect(
    area.getByRole("checkbox", { name: "Record QA browser reviews", exact: true }),
  ).toHaveCount(0);
  await expect(area.getByRole("textbox", { name: /^Value for/ })).toHaveCount(0);
  expect(await area.innerHTML()).not.toContain("saved-api-secret");
  expect(await area.innerHTML()).not.toContain("saved-registry-secret");
  await page.screenshot({ path: `${evidence}/desktop.png` });

  const privateImages = area.getByRole("region", { name: "Private container images", exact: true });
  const editImage = privateImages.getByRole("button", {
    name: "Edit image credentials for registry.example.invalid",
    exact: true,
  });
  const registry = area.getByRole("textbox", { name: "Registry 1 host" });
  await expect(privateImages).toBeVisible();
  await expect(privateImages.getByText("registry.example.invalid", { exact: true })).toBeVisible();
  await expect(area.getByText("Private container images", { exact: true })).toHaveCount(1);
  await expect(
    area.getByText(/private image downloads during environment preparation and startup/),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
  await expect(save).toHaveCount(0);

  await editImage.focus();
  await editImage.press("Enter");
  await expect(registry).toBeFocused();
  await expect(registry).toHaveValue("registry.example.invalid");
  await expect(area.getByText(/repository's Dev Container configuration/)).toBeVisible();
  await expect(
    area.getByRole("textbox", { name: "Replace password or token", exact: true }),
  ).toHaveValue("");
  const imageAccess = area.locator(".environment-registry details > summary");
  await imageAccess.focus();
  await imageAccess.press("Enter");
  await expect(
    area.getByRole("checkbox", { name: "Allow image pulls during Verification", exact: true }),
  ).toBeChecked();
  await imageAccess.press("Space");
  await expect(
    area.getByRole("checkbox", { name: "Allow image pulls during Verification", exact: true }),
  ).toBeHidden();
  await area.getByRole("textbox", { name: "Username", exact: true }).fill("image-reader");
  await expect(save).toBeVisible();
  await page.screenshot({ path: `${evidence}/private-images-desktop.png` });
  await save.click();
  await expect(save).toHaveCount(0);
  expect(bundles.get("development")?.registries[0]?.username).toBe("image-reader");
  expect(bundles.get("development")?.registries[0]?.password).toBe("saved-registry-secret");
  expect(bundles.get("development")?.registries[0]?.verification).toBe(true);
  await expect(registry).toBeHidden();
  await expect(privateImages.getByText("image-reader", { exact: true })).toBeVisible();

  await search.fill("hugo");
  await expect(names).toHaveText(["HUGO_VERSION"]);
  await area.getByRole("button", { name: "Filter and sort variables", exact: true }).click();
  await area.getByRole("combobox", { name: "Filter by usage" }).selectOption("runtime");
  await expect(area.getByText("No variables match these filters.")).toBeVisible();
  await area.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(names).toHaveText(["API_KEY", "HUGO_VERSION", "PUBLIC_ORIGIN"]);
  await area.getByRole("combobox", { name: "Filter by usage" }).selectOption("verification");
  await expect(names).toHaveText(["HUGO_VERSION", "PUBLIC_ORIGIN"]);
  await area.getByRole("combobox", { name: "Sort variables" }).selectOption("name-desc");
  await expect(names).toHaveText(["PUBLIC_ORIGIN", "HUGO_VERSION"]);
  await area.getByRole("combobox", { name: "Filter by usage" }).selectOption("all");

  const actions = area.getByRole("button", { name: "Actions for API_KEY", exact: true });
  await actions.focus();
  await actions.press("Enter");
  const menu = area.getByRole("menu", { name: "Variable actions" });
  await expect(menu.getByRole("menuitem", { name: "Edit variable" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Remove variable" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(actions).toBeFocused();
  await actions.click();
  await menu.getByRole("menuitem", { name: "Edit variable" }).click();
  await expect(area.getByRole("textbox", { name: "Variable 1 name" })).toBeFocused();
  const replacement = area.getByRole("textbox", { name: "Value for API_KEY", exact: true });
  await expect(replacement).toHaveValue("");
  await replacement.pressSequentially("replacement-value");
  await expect(replacement).toBeFocused();
  await rows
    .filter({ hasText: "API_KEY" })
    .getByRole("checkbox", { name: "Verification", exact: true })
    .check();
  await expect(area.getByText(/Runtime values can be read by your application/)).toBeVisible();
  await page.screenshot({ path: `${evidence}/editor-desktop.png` });
  await area.getByRole("button", { name: "Done editing", exact: true }).click();
  await area.getByRole("combobox", { name: "Filter by saved state" }).selectOption("draft");
  await expect(names).toHaveText(["API_KEY"]);
  await save.click();
  await expect(names).toHaveCount(0);
  expect(bundles.get("development")?.variables).toHaveLength(3);
  expect(bundles.get("development")?.variables[0]?.value).toBe("replacement-value");
  expect(bundles.get("development")?.variables[0]?.verification).toBe(true);
  expect(writes[0]?.registries[0]?.password).toBeUndefined();
  expect(bundles.get("development")?.registries[0]?.password).toBe("saved-registry-secret");
  expect(await area.innerHTML()).not.toContain("replacement-value");
  await area.getByRole("button", { name: "Clear filters", exact: true }).click();

  await area.getByRole("button", { name: "Add variable", exact: true }).click();
  const newName = area.getByRole("textbox", { name: "Variable 4 name" });
  await expect(newName).toBeFocused();
  await newName.pressSequentially("ANOTHER_TOKEN");
  await expect(newName).toHaveValue("ANOTHER_TOKEN");
  await expect(newName).toBeFocused();
  await area
    .getByRole("textbox", { name: "Value for ANOTHER_TOKEN", exact: true })
    .fill("new-value");
  await save.click();
  await expect(area.getByRole("article", { name: "ANOTHER_TOKEN", exact: true })).toBeVisible();
  await area.getByRole("button", { name: "Actions for ANOTHER_TOKEN", exact: true }).click();
  await menu.getByRole("menuitem", { name: "Remove variable" }).click();
  await expect(area.getByRole("article", { name: "ANOTHER_TOKEN", exact: true })).toHaveCount(0);
  expect(bundles.get("development")?.variables).toHaveLength(4);
  await save.click();
  await expect(
    area.getByText("Saved. New starts use these settings; restart existing compute to apply."),
  ).toBeVisible();
  expect(bundles.get("development")?.variables).toHaveLength(3);

  await importAction.click();
  const paste = area.getByRole("textbox", { name: "Paste environment variables" });
  await expect(paste).toBeFocused();
  await paste.fill("DUPLICATE=1\nDUPLICATE=2");
  await area.getByRole("button", { name: "Preview import", exact: true }).click();
  await expect(area.getByRole("alert")).toHaveText(
    "Check the pasted variable names, quotes and duplicate entries.",
  );
  await paste.fill('MULTILINE="first\nsecond"\nOTHER=literal-$VALUE');
  await area.getByRole("button", { name: "Preview import", exact: true }).click();
  await expect(area.getByText("MULTILINE, OTHER · values hidden")).toBeVisible();
  await page.screenshot({ path: `${evidence}/import-desktop.png` });
  await area.getByRole("button", { name: "Apply to draft", exact: true }).click();
  await expect(paste).toHaveCount(0);
  await expect(importAction).toBeFocused();
  await save.click();
  await expect(
    area.getByText("Saved. New starts use these settings; restart existing compute to apply."),
  ).toBeVisible();
  expect(
    bundles.get("development")?.variables.find((item) => item.name === "MULTILINE")?.value,
  ).toBe("first\nsecond");
  expect(bundles.get("development")?.variables.find((item) => item.name === "OTHER")?.value).toBe(
    "literal-$VALUE",
  );
  await importAction.click();
  await expect(paste).toHaveValue("");
  await paste.fill("CANCELLED_TOKEN=discard-this-draft");
  await paste.press("Escape");
  await expect(paste).toHaveCount(0);
  await expect(importAction).toBeFocused();
  await expect(names).toHaveCount(5);
  await importAction.click();
  await expect(paste).toHaveValue("");
  await area.getByRole("button", { name: "Cancel import", exact: true }).click();
  await search.fill("missing");
  await area.getByRole("button", { name: "Main-Preview", exact: true }).click();
  await expect(area.getByText("No variables in Main-Preview.")).toBeVisible();
  await expect(search).toHaveValue("");
  await expect(
    privateImages.getByText("No private credentials. Public images need none."),
  ).toBeVisible();
  await privateImages.getByRole("button", { name: "Add credentials", exact: true }).click();
  await expect(registry).toBeFocused();
  await registry.fill("preview-registry.example.invalid");
  await imageAccess.click();
  await expect(
    area.getByRole("checkbox", { name: "Allow image pulls during Verification", exact: true }),
  ).not.toBeChecked();
  await area
    .getByRole("button", { name: "Remove registry preview-registry.example.invalid" })
    .click();
  await expect(
    privateImages.getByText("No private credentials. Public images need none."),
  ).toBeVisible();
  await expect(save).toHaveCount(0);
  await area.getByRole("button", { name: "Development", exact: true }).click();
  await expect(names).toHaveCount(5);

  for (const width of [1024, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const overflowing = await area
      .locator(".environment-toolbar, .environment-variable-summary")
      .evaluateAll((elements) =>
        elements.some((element) => element.scrollWidth > element.clientWidth + 1),
      );
    expect(overflowing).toBe(false);
    await page.screenshot({ path: `${evidence}/width-${width}.png` });
  }
  await area.getByRole("button", { name: "Actions for PUBLIC_ORIGIN", exact: true }).click();
  await expect
    .poll(async () =>
      menu.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const anchor = document
          .querySelector('[aria-label="Actions for PUBLIC_ORIGIN"]')
          ?.getBoundingClientRect();
        return anchor ? Math.abs(bounds.right - anchor.right) : Infinity;
      }),
    )
    .toBeLessThanOrEqual(1);
  const bounds = await menu.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: `${evidence}/menu-phone.png` });
  await menu.getByRole("menuitem", { name: "Edit variable" }).click();
  await area
    .getByRole("textbox", { name: /^Variable \d+ name$/ })
    .fill("A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_THAT_MUST_WRAP_ON_PHONES");
  await expect(names.first()).toHaveText(
    "A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_THAT_MUST_WRAP_ON_PHONES",
  );
  await expect(area.getByRole("textbox", { name: /^Variable \d+ name$/ })).toBeInViewport();
  await page.screenshot({ path: `${evidence}/editor-phone.png` });
  await area.getByRole("button", { name: "Done editing", exact: true }).click();
  expect(
    await area.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${evidence}/long-name-phone.png` });
  await area.getByRole("button", { name: "Filter and sort variables", exact: true }).click();
  await expect(area.getByRole("combobox", { name: "Filter by usage" })).toBeVisible();
  await page.screenshot({ path: `${evidence}/filters-phone.png` });
  await area.getByRole("button", { name: "Filter and sort variables", exact: true }).click();
  await editImage.click();
  await expect(registry).toBeVisible();
  await registry.scrollIntoViewIfNeeded();
  expect(
    await area.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${evidence}/private-images-phone.png` });
  await imageAccess.click();
  await expect(
    area.getByRole("checkbox", { name: "Allow image pulls during Verification", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/private-image-access-phone.png` });
  await imageAccess.click();
  await area.getByRole("button", { name: "Done editing credentials", exact: true }).click();
  await expect(registry).toBeHidden();
  await importAction.click();
  await expect(paste).toBeFocused();
  await page.screenshot({ path: `${evidence}/import-phone.png` });
  await area.getByRole("button", { name: "Cancel import", exact: true }).click();
  await chooseSettingsPage(page, "Inputs");
  await chooseSettingsPage(page, "Environments");
  await expect(area.getByRole("heading", { name: "Environments", exact: true })).toHaveCount(1);
  await expect(area.getByRole("button", { name: "Add variable", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("pending saves lock draft actions, retry the same command, and preserve read-only browsing", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let canManage = true;
  let pending: EnvironmentWrite | undefined;
  let fail = true;
  let bundle = initialBundle();
  const commands: EnvironmentWrite[] = [];
  const view = (environment: ProjectEnvironment): EnvironmentSettingsView => ({
    ...environmentMetadata(bundle),
    environment,
    version: 0,
    canManage,
    storeConfigured: true,
    pending: Boolean(pending),
    pendingCommandID: pending?.commandID ?? null,
    preparation: null,
  });
  await mockFactoryFunctions(page, {
    environments: {
      get: async (_project, _actor, environment) => view(environment),
      save: async (_project, _actor, environment, value) => {
        const input = environmentWrite.parse(value);
        commands.push(input);
        if (fail) {
          pending = input;
          fail = false;
          throw new CommandError("unavailable", "Protected store did not confirm this save.");
        }
        bundle = replaceEnvironment(input, bundle);
        pending = undefined;
        return view(environment);
      },
      discard: async (_project, _actor, environment, commandID) => {
        expect(commandID).toBe(pending?.commandID);
        pending = undefined;
        return view(environment);
      },
    },
  });
  await page.goto(`${origin}/environment-settings.html`);
  await page
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "Environments", exact: true })
    .click();
  const area = page.getByRole("region", { name: "Project environment", exact: true });
  await area
    .getByRole("button", { name: "Edit image credentials for registry.example.invalid" })
    .click();
  await area.getByRole("button", { name: "Add variable", exact: true }).click();
  await area.getByRole("textbox", { name: "Variable 4 name" }).fill("RETRY_TOKEN");
  await area
    .getByRole("textbox", { name: "Value for RETRY_TOKEN", exact: true })
    .fill("retry-value");
  await area.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(area.getByRole("alert")).toHaveText("Protected store did not confirm this save.");
  await expect(area.getByRole("button", { name: "Retry loading", exact: true })).toHaveCount(0);
  await expect(area.getByRole("button", { name: "Add variable", exact: true })).toBeDisabled();
  await expect(area.getByRole("textbox", { name: "Variable 4 name" })).toBeDisabled();
  await expect(
    area.getByRole("button", { name: "Actions for API_KEY", exact: true }),
  ).toBeDisabled();
  await expect(area.getByRole("textbox", { name: "Registry 1 host" })).toBeDisabled();
  await expect(area.getByRole("button", { name: "Add credentials", exact: true })).toBeDisabled();
  await expect(area.getByRole("button", { name: "Import .env", exact: true })).toBeDisabled();
  await page.screenshot({ path: `${evidence}/pending-save.png` });
  await area.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(
    area.getByText("Saved. New starts use these settings; restart existing compute to apply."),
  ).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);

  fail = true;
  await area.getByRole("button", { name: "Actions for API_KEY", exact: true }).click();
  await area.getByRole("menuitem", { name: "Edit variable", exact: true }).click();
  await area
    .getByRole("group", { name: "Available to", exact: true })
    .getByRole("checkbox", { name: "Image build", exact: true })
    .check();
  await area.getByRole("button", { name: "Done editing", exact: true }).click();
  await area.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(area.getByRole("alert")).toBeVisible();
  await area.getByRole("button", { name: "Discard pending save", exact: true }).click();
  await expect(
    area.getByText("Pending save discarded. Existing settings are unchanged."),
  ).toBeVisible();
  await expect(area.getByRole("button", { name: "Add variable", exact: true })).toBeEnabled();

  canManage = false;
  await area.getByRole("button", { name: "Main-Preview", exact: true }).click();
  await expect(area.getByRole("article", { name: "API_KEY", exact: true })).toBeVisible();
  await expect(area.getByRole("button", { name: "Add variable", exact: true })).toHaveCount(0);
  await expect(area.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  await expect(area.getByRole("button", { name: "Save environment", exact: true })).toHaveCount(0);
  await expect(area.getByRole("textbox", { name: "Registry 1 host" })).toBeHidden();
  const images = area.getByRole("region", { name: "Private container images", exact: true });
  await expect(images.getByText("registry.example.invalid", { exact: true })).toBeVisible();
  await expect(images.getByText("Verification", { exact: true })).toBeVisible();
  await expect(images.getByRole("button")).toHaveCount(0);
  await expect(area.getByRole("button", { name: "Import .env", exact: true })).toHaveCount(0);
  await area.getByRole("searchbox", { name: "Search variables" }).fill("missing");
  await area.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(area.locator(".environment-variable")).toHaveCount(4);
});
