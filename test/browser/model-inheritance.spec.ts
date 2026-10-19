import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { inheritedModelSettingsView } from "../../packages/conversation-domain/src/model-inheritance";
import { createDatabase } from "../../packages/db/src/client";
import { signIn } from "../support/factory-fixture";

test("Project managers set model defaults and locks; developers select and Reset their own models", async ({
  page,
  browser,
}) => {
  const database = createDatabase(1);
  const projectID = crypto.randomUUID();
  const name = `Models QA ${projectID.slice(0, 8)}`;
  const password = "owned-model-browser-password";
  const users: Array<{ id: string; email: string }> = [];
  const managerContext = await browser.newContext();
  const developerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  const developer = await developerContext.newPage();
  const errors: string[] = [];
  for (const current of [page, manager, developer])
    current.on("pageerror", (error) => errors.push(error.message));
  for (const current of [page, manager, developer])
    await current.route("**/api/projects/*/source-workspace/ensure", (route) =>
      route.fulfill({ status: 503, json: { error: "Source is outside this Settings fixture" } }),
    );
  for (const current of [page, manager, developer])
    await current.route("**/api/projects/*/developer-ide/ensure", (route) =>
      route.fulfill({ status: 503, json: { error: "IDE is outside this Settings fixture" } }),
    );
  async function login(current: Page, email: string) {
    await current.goto("/");
    await current.getByLabel("Email", { exact: true }).fill(email);
    await current.getByLabel("Password", { exact: true }).fill(password);
    await current.getByRole("button", { name: "Sign in", exact: true }).click();
    await current.getByRole("button", { name: "Open project menu" }).click();
    await current.getByRole("button", { name: new RegExp(name) }).click();
  }
  async function open(current: Page, group = "Personal") {
    await current.getByRole("button", { name: "Settings", exact: true }).click();
    await current.getByRole("button", { name: "Open settings", exact: true }).click();
    const dialog = current.getByRole("region", { name: "Settings", exact: true });
    await dialog
      .getByRole("navigation", { name: "Settings navigation" })
      .locator("section")
      .filter({ has: current.getByRole("heading", { name: group, exact: true }) })
      .getByRole("button", { name: "Models", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: /^Build/ })).toHaveCount(1);
    return dialog;
  }
  let administrator: string | undefined;
  try {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const session = z
      .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
      .parse(await (await page.request.get("/api/session")).json());
    administrator = session.session.user.id;
    await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`models-qa-${projectID}`}, ${name}, 'https://example.invalid/models-qa.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
    for (const role of ["project-manager", "developer"] as const) {
      const email = `${role}-${projectID}@factory.local`;
      const response = await page.request.post("/api/admin/users", {
        headers: { origin: "http://127.0.0.1:3000" },
        data: { name: `Models QA ${role}`, email, password },
      });
      expect(response.status()).toBe(201);
      users.push(z.object({ id: z.uuid(), email: z.email() }).parse(await response.json()));
      const membership = await page.request.post(`/api/projects/${projectID}/members`, {
        headers: { origin: "http://127.0.0.1:3000" },
        data: { email, role: "developer", manageProject: role === "project-manager" },
      });
      expect(membership.ok()).toBe(true);
    }
    const managerUser = users[0];
    const developerUser = users[1];
    if (!managerUser || !developerUser) throw new Error("Owned model accounts missing");
    await login(manager, managerUser.email);
    await login(developer, developerUser.email);
    const projectURL = `/api/projects/${projectID}/model-settings`;
    const initial = inheritedModelSettingsView.parse(
      await (await manager.request.get(projectURL)).json(),
    );
    const modelId = initial.effective.build.modelId;
    expect(initial.effective.build.allowOverride).toBe(true);
    const managerDialog = await open(manager, name);
    await expect(
      managerDialog
        .getByRole("navigation", { name: "Settings navigation" })
        .getByRole("heading", { name: "Factory", exact: true }),
    ).toHaveCount(0);
    await managerDialog
      .getByRole("combobox", { name: /^Investigate & Plan/ })
      .selectOption(initial.effective.planning.modelId);
    await managerDialog.getByRole("combobox", { name: /^Build/ }).selectOption(modelId);
    await managerDialog.getByRole("button", { name: "Save models", exact: true }).click();
    await expect(managerDialog.getByRole("status")).toHaveText("Model settings saved");
    const developerDialog = await open(developer);
    await expect(developerDialog.getByRole("button", { name, exact: true })).toHaveCount(0);
    const build = developerDialog.getByRole("region", { name: "Build configuration", exact: true });
    await expect(build.getByText("Inherited from Project", { exact: true })).toBeVisible();
    await developerDialog.getByRole("combobox", { name: /^Build/ }).selectOption(modelId);
    await developerDialog.getByRole("button", { name: "Save models", exact: true }).click();
    await expect(developerDialog.getByRole("status")).toHaveText("Model settings saved");
    await expect(build.getByText("My selection", { exact: true })).toBeVisible();
    expect(
      (
        await developer.request.put(projectURL, {
          headers: { origin: "http://127.0.0.1:3000" },
          data: initial.project,
        })
      ).status(),
    ).toBe(403);
    await build.getByRole("button", { name: "Reset Build", exact: true }).click();
    await developerDialog.getByRole("button", { name: "Save models", exact: true }).click();
    await expect(build.getByText("Inherited from Project", { exact: true })).toBeVisible();
    const managerBuild = managerDialog.getByRole("region", {
      name: "Build configuration",
      exact: true,
    });
    await managerBuild.getByText("Build permissions", { exact: true }).click();
    await managerBuild.getByLabel("Allow personal overrides", { exact: true }).uncheck();
    await managerDialog.getByRole("button", { name: "Save models", exact: true }).click();
    await expect(managerDialog.getByRole("status")).toHaveText("Model settings saved");
    await developer.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    const lockedDialog = await open(developer);
    const lockedBuild = lockedDialog.getByRole("region", {
      name: "Build configuration",
      exact: true,
    });
    await expect(lockedDialog.getByRole("combobox", { name: /^Build/ })).toBeDisabled();
    await expect(lockedBuild.getByText("Locked by Project Manager", { exact: true })).toBeVisible();
    await mkdir(".factory/test-results/model-inheritance", { recursive: true });
    await developer.setViewportSize({ width: 1440, height: 960 });
    await developer.screenshot({ path: ".factory/test-results/model-inheritance/wide.png" });
    await developer.setViewportSize({ width: 390, height: 844 });
    expect(
      await developer.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    // Mobile navigation is intentionally horizontally scrollable. The form
    // controls must fit without relying on that navigation's scroll position.
    for (const control of await lockedDialog
      .locator(".settings-content select, .settings-content button")
      .all()) {
      if (!(await control.boundingBox())) continue;
      await expect
        .poll(async () => (await control.boundingBox())?.x ?? 0)
        .toBeGreaterThanOrEqual(0);
      await expect
        .poll(async () => {
          const box = await control.boundingBox();
          return box ? box.x + box.width : 0;
        })
        .toBeLessThanOrEqual(390);
    }
    await developer.screenshot({ path: ".factory/test-results/model-inheritance/narrow.png" });
    await managerBuild.getByText("Build permissions", { exact: true }).click();
    await manager.setViewportSize({ width: 1440, height: 960 });
    await managerDialog.evaluate((element) => {
      element.scrollTop = 0;
    });
    await manager.screenshot({
      path: ".factory/test-results/model-inheritance/project-manager.png",
    });
    await developer.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await expect(lockedDialog).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await managerContext.close();
    await developerContext.close();
    try {
      await database.client.begin(async (sql) => {
        await sql`DELETE FROM factory.forge_grant_intent WHERE project_id=${projectID}`;
        if (administrator)
          await sql`DELETE FROM factory.project WHERE id = ${projectID} AND created_by = ${administrator} AND slug = ${`models-qa-${projectID}`}
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id = ${projectID}) AND NOT EXISTS(SELECT 1 FROM factory.ticket WHERE project_id = ${projectID})`;
        for (const user of users) {
          await sql`DELETE FROM factory.forge_grant_intent WHERE user_id=${user.id}`;
          await sql`DELETE FROM factory.forge_account_intent WHERE user_id=${user.id}`;
          await sql`DELETE FROM auth."user" WHERE id = ${user.id} AND email = ${user.email}`;
        }
      });
    } finally {
      await database.client.end();
    }
  }
});
