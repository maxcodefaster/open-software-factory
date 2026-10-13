import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { signIn } from "../support/factory-fixture";

test("managers create accounts and Project access; developers see only their Project and lose revoked access", async ({
  page,
  browser,
}) => {
  const database = createDatabase(1);
  const suffix = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const otherProjectID = crypto.randomUUID();
  const name = `Access QA ${suffix.slice(0, 8)}`;
  const otherName = `Private QA ${suffix.slice(0, 8)}`;
  const email = `access-qa-${suffix}@factory.local`;
  const password = "owned-browser-password-not-a-secret";
  const developerContext = await browser.newContext();
  const developer = await developerContext.newPage();
  const errors: string[] = [];
  for (const current of [page, developer]) {
    await current.route("**/api/projects/*/source-workspace/ensure", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Controlled planning fixture has no source repository" },
      }),
    );
    await current.route("**/api/projects/*/developer-ide/ensure", (route) =>
      route.fulfill({ status: 503, json: { error: "Controlled planning fixture has no IDE" } }),
    );
  }
  page.on("pageerror", (error) => errors.push(error.message));
  developer.on("pageerror", (error) => errors.push(error.message));
  let administrator: string | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const session = z
      .object({
        session: z.object({ user: z.object({ id: z.uuid() }), systemManager: z.literal(true) }),
      })
      .parse(await (await page.request.get("/api/session")).json());
    administrator = session.session.user.id;
    for (const [id, projectName] of [
      [projectID, name],
      [otherProjectID, otherName],
    ] as const) {
      await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${id}, ${`access-qa-${id}`}, ${projectName}, 'https://example.invalid/access-qa.git',
          'main', '.devcontainer/devcontainer.json', ${administrator})`;
    }
    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const dialog = page.getByRole("region", { name: "Settings", exact: true });
    const navigation = dialog.getByRole("navigation", { name: "Settings navigation" });
    await navigation
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Factory", exact: true }) })
      .getByRole("button", { name: "People & access", exact: true })
      .click();
    await expect(dialog.getByRole("region", { name: "Managed accounts" })).toBeVisible();
    await dialog.getByText("Add account", { exact: true }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("Access QA developer");
    await dialog.getByLabel("Email", { exact: true }).fill(email);
    await dialog.getByLabel("Initial password", { exact: false }).fill(password);
    await dialog.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText(
      "Account created. Add access in the project's People & access settings.",
    );
    await navigation
      .locator("section")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
      .getByRole("button", { name: "People & access", exact: true })
      .click();
    await expect(
      dialog
        .getByRole("region", { name: "People & access", exact: true })
        .getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await dialog.getByLabel("Member email", { exact: true }).fill(email);
    await dialog.getByRole("button", { name: "Add member", exact: true }).click();
    await expect(dialog.getByLabel("Role for Access QA developer")).toHaveValue("developer");
    await mkdir(".factory/screenshots", { recursive: true });
    await page.screenshot({ path: ".factory/screenshots/project-access-wide.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    for (const control of await dialog
      .locator(".settings-content input, .settings-content select, .settings-content button")
      .all()) {
      const box = await control.boundingBox();
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: ".factory/screenshots/project-access-narrow.png" });
    await developer.goto("/");
    await developer.getByLabel("Email", { exact: true }).fill(email);
    await developer.getByLabel("Password", { exact: true }).fill(password);
    await developer.getByRole("button", { name: "Sign in", exact: true }).click();
    await developer.getByRole("button", { name: "Open project menu" }).click();
    await expect(developer.getByRole("button", { name: new RegExp(name) })).toBeVisible();
    await expect(developer.getByRole("button", { name: new RegExp(otherName) })).toHaveCount(0);
    await expect(developer.getByRole("button", { name: "Add project", exact: true })).toHaveCount(
      0,
    );
    await developer.getByRole("button", { name: new RegExp(name) }).click();
    await developer.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      developer.getByRole("button", { name: "People & access", exact: true }),
    ).toHaveCount(0);
    await expect(
      developer.getByRole("button", { name: "Open settings", exact: true }),
    ).toBeVisible();
    await developer.getByRole("button", { name: "Open settings", exact: true }).click();
    expect(
      (await developer.request.get(`/api/projects/${otherProjectID}/conversation`)).status(),
    ).toBe(404);
    const roleSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${projectID}/members`) &&
        response.request().method() === "POST",
    );
    await dialog.getByLabel("Manage project for Access QA developer").check();
    expect((await roleSaved).ok()).toBe(true);
    await developer.getByRole("button", { name: "People & access", exact: true }).click();
    const projectDialog = developer.getByRole("region", { name: "Settings", exact: true });
    await expect(
      projectDialog
        .getByRole("region", { name: "People & access", exact: true })
        .getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(projectDialog.getByRole("region", { name: "Managed accounts" })).toHaveCount(0);
    await developer.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Remove Access QA developer's project access" })
      .click();
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${administrator},'developer',true,${administrator})`;
    await dialog.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText(
      "Access QA developer's project access was removed. Shared work is unchanged.",
    );
    await expect(dialog.getByLabel("Role for Access QA developer")).toHaveCount(0);
    expect((await developer.request.get(`/api/projects/${projectID}/conversation`)).status()).toBe(
      404,
    );
    await developer.getByRole("button", { name: "Open project menu" }).click();
    await expect(developer.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await developerContext.close();
    try {
      if (administrator) {
        for (const id of [projectID, otherProjectID]) {
          await database.client`DELETE FROM factory.forge_grant_intent WHERE project_id=${id}
            AND EXISTS(SELECT 1 FROM factory.project WHERE id=${id} AND created_by=${administrator} AND slug=${`access-qa-${id}`})
            AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id=${id})`;
          await database.client`DELETE FROM factory.project WHERE id = ${id} AND created_by = ${administrator}
            AND slug = ${`access-qa-${id}`} AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id = ${id})
            AND NOT EXISTS(SELECT 1 FROM factory.ticket WHERE project_id = ${id})
            AND NOT EXISTS(SELECT 1 FROM factory.knowledge_page WHERE project_id = ${id})
            AND NOT EXISTS(SELECT 1 FROM factory.ticket_conversation WHERE project_id = ${id})`;
        }
        await database.client.begin(async (sql) => {
          const [owned] = await sql<
            Array<{ id: string }>
          >`SELECT id FROM auth."user" WHERE email=${email}`;
          if (!owned) return;
          // Reconciliation records denied grants for other Projects too. Serialize
          // with that writer and remove only this exact fixture account's rows.
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`forge-account:${owned.id}`},0))`;
          await sql`DELETE FROM factory.forge_grant_intent WHERE user_id=${owned.id}`;
          await sql`DELETE FROM auth.account WHERE user_id=${owned.id}`;
          await sql`DELETE FROM factory.forge_account_intent WHERE user_id=${owned.id}`;
          await sql`DELETE FROM factory.developer_ide WHERE user_id=${owned.id} AND state='stopped'`;
          await sql`DELETE FROM auth."user" WHERE id=${owned.id} AND email=${email}
            AND NOT EXISTS(SELECT 1 FROM factory.project_membership WHERE user_id=${owned.id})`;
        });
      }
    } finally {
      await database.client.end();
    }
  }
});
