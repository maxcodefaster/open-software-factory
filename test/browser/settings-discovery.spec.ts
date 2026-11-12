import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import {
  browserBootstrap,
  factoryFunctionMatcher,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

let database: ReturnType<typeof createDatabase>;
let projectID: string;
test.setTimeout(60_000);
test.use({ actionTimeout: 10_000 });
test.beforeEach(async ({ page }) => {
  database = createDatabase(2);
  projectID = crypto.randomUUID();
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${`settings-discovery-${projectID.slice(0, 8)}`},'Settings discovery','https://example.invalid/settings.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
  await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
    VALUES(${projectID},${session.user.id},'developer',true,${session.user.id})`;
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "This Settings fixture starts no runtime");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "This Settings fixture starts no runtime");
      },
    },
  });
  await page.goto(`/projects/${projectID}/settings`);
  await expect(page.getByRole("navigation", { name: "Settings navigation" })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  await page.close();
  try {
    await deleteFactoryProject(projectID, database);
  } finally {
    await database.client.end();
  }
});

for (const destination of ["Skills", "MCP connections"])
  test(`${destination} is reachable directly from Project settings`, async ({ page }) => {
    const navigation = page.getByRole("navigation", { name: "Settings navigation" });
    const button = navigation.getByRole("button", { name: destination, exact: true });
    expect(await button.isVisible()).toBe(true);
    await expect(navigation.locator(".settings-scope-hint")).toHaveCount(0);
    await button.click();
    await expect(navigation.getByRole("combobox", { name: "Settings scope" })).toHaveValue(
      "libraries",
    );
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    // The lazy library replaces the temporary Settings heading with its own.
    // Wait for that header before resizing so the click targets the final control.
    await expect(
      page.getByRole("group", {
        name: destination === "Skills" ? "Skills library actions" : "MCP library actions",
        exact: true,
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: /choose settings page$/i })
      .filter({ visible: true })
      .click();
    await expect(button).toBeVisible();
    await mkdir(".factory/test-results/settings-discovery", { recursive: true });
    await page.screenshot({
      path: `.factory/test-results/settings-discovery/${destination === "Skills" ? "skills" : "mcp"}-phone.png`,
    });
  });

test("Monitoring does not load or show allowance editors until Usage & limits is selected", async ({
  page,
}) => {
  const usage = await factoryFunctionMatcher("getUsage");
  const compute = await factoryFunctionMatcher("getCurrentCompute");
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (usage(url)) reads.push("usage");
    if (compute(url)) reads.push("compute");
  });
  const navigation = page.getByRole("navigation", { name: "Settings navigation" });
  await navigation.getByRole("button", { name: "Monitoring", exact: true }).click();
  await expect(page.getByRole("region", { name: "Factory monitoring", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Optional limits", exact: true })).toHaveCount(0);
  expect(reads).toEqual([]);
  await expect(page.locator(".work-history")).not.toHaveAttribute("open", "");
  await expect(page.locator(".work-method")).not.toHaveAttribute("open", "");
  await expect(page.locator(".work-chart")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".workspace-window").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  await mkdir(".factory/test-results/settings-discovery", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/settings-discovery/monitoring-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".factory/test-results/settings-discovery/monitoring-phone.png" });
  await page
    .getByRole("button", { name: /choose settings page$/i })
    .filter({ visible: true })
    .click();
  await navigation.getByRole("button", { name: "Usage & limits", exact: true }).click();
  await expect(page.getByRole("group", { name: "Optional limits", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Factory monitoring", exact: true })).toHaveCount(
    0,
  );
  await expect.poll(() => reads.includes("usage")).toBe(true);
});
