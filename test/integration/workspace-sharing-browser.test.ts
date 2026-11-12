import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect as visible } from "@playwright/test";
import { factoryProcess } from "../fixtures/factory-process";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { openProjectMenu } from "../fixtures/project-menu";
import { workspaceSourceIdentity } from "../../packages/workspace-domain/src/source";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";

test("sharing uses real owner decisions, readable narrow/touch controls and returns focus", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : {}),
  });
  const projectID = crypto.randomUUID(),
    peer = crypto.randomUUID();
  const slug = `sharing-browser-${projectID.slice(0, 8)}`;
  const evidence = ".factory/test-results/external-mcp/sharing-browser";
  await mkdir(evidence, { recursive: true });
  try {
    await fixture.startPlanningCache();
    await fixture.start();
    const cookie = await fixture.signIn();
    const [person] = await database.client<
      { id: string }[]
    >`SELECT id FROM auth."user" WHERE email=${`owned-${fixture.id}@factory.local`}`;
    if (!person) throw new Error("Owned browser actor is missing");
    const owner = person.id;
    const workspaceID = personalWorkspaceIdentity(projectID, owner).workspaceID;
    await database.client`INSERT INTO auth."user"(id,name,email)VALUES(${peer},'Browser collaborator',${`${peer}@factory.invalid`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)VALUES(${projectID},${slug},'Workspace sharing proof','https://example.invalid/owned/project.git','main','.devcontainer/devcontainer.json',${owner})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)VALUES(${projectID},${peer},'developer',${owner})`;
    await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)VALUES(${workspaceID},${projectID},'personal',${owner},'main',${"a".repeat(40)},${owner})`;
    for (const [name, settings] of [
      ["desktop", { viewport: { width: 1440, height: 900 } }],
      ["narrow", { viewport: { width: 390, height: 844 } }],
      ["touch", { viewport: { width: 820, height: 1180 }, hasTouch: true }],
    ] as const) {
      const context = await browser.newContext(settings);
      await context.grantPermissions(["local-network-access"], { origin: fixture.base });
      await context.addCookies(
        cookie.split("; ").map((part) => ({
          name: part.slice(0, part.indexOf("=")),
          value: part.slice(part.indexOf("=") + 1),
          url: fixture.base,
        })),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const source = {
        workspaceID,
        label: "My workspace",
        serviceID: workspaceSourceIdentity(workspaceID, 1).serviceID,
        epoch: 1,
        state: "ready" as const,
        failure: null,
      };
      await mockFactoryFunctions(page, {
        workspaces: {
          ensurePersonalSource: async () => source,
          getSource: async () => source,
          ensureEditor: async () => ({
            serviceID: "owned-editor",
            epoch: 1,
            state: "ready",
            failure: null,
          }),
          getEditor: async () => ({
            serviceID: "owned-editor",
            epoch: 1,
            state: "ready",
            failure: null,
          }),
        },
      });
      await page.route("**/api/developer-ide/access?*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body>Owned editor fixture</body></html>",
        }),
      );
      await page.goto(fixture.base);
      await openProjectMenu(page);
      await page.getByRole("button").filter({ hasText: slug }).click();
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      const opener = page.getByRole("button", { name: "Share Workspace", exact: true });
      await visible(opener).toBeVisible({ timeout: 15_000 });
      if (name === "touch") await opener.tap();
      else await opener.click();
      const dialog = page.getByRole("dialog", { name: "Share Workspace" });
      await visible(dialog).toBeVisible();
      const select = dialog.getByLabel("Access for Browser collaborator");
      await visible(select).toHaveValue("private");
      await select.selectOption("collaborate");
      await visible(select).toHaveValue("collaborate");
      await visible(select).toBeEnabled();
      const [share] = await database.client<
        { permission: string }[]
      >`SELECT permission FROM factory.workspace_share WHERE workspace_id=${workspaceID} AND user_id=${peer} AND revoked_at IS NULL`;
      expect(share?.permission).toBe("collaborate");
      const bounds = await dialog.boundingBox();
      if (!bounds) throw new Error("Sharing dialog has no bounds");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.width).toBeLessThanOrEqual(settings.viewport.width);
      await page.screenshot({ path: `${evidence}/${name}.png` });
      await select.selectOption("private");
      await visible(select).toHaveValue("private");
      await visible(select).toBeEnabled();
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await visible(opener).toBeFocused();
      expect(errors).toEqual([]);
      await context.close();
    }
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
    ).toHaveLength(0);
  } finally {
    await browser.close();
    await database.client.end({ timeout: 2 });
    await fixture.dispose();
  }
}, 120000);
