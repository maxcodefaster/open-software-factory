import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { createPlanningEpic, deleteFactoryProject, signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(90_000);

test("Epic hierarchy, Ticket membership and scope work through actual planning mutations", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectId = crypto.randomUUID();
  const slug = `epic-qa-${projectId.slice(0, 8)}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/projects/*/source-workspace/ensure", (route) =>
    route.fulfill({ status: 503, json: { error: "Controlled planning fixture" } }),
  );
  await page.route("**/api/projects/*/developer-ide/ensure", (route) =>
    route.fulfill({ status: 503, json: { error: "Controlled planning fixture" } }),
  );
  try {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const administrator = z
      .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
      .parse(await (await page.request.get("/api/session")).json()).session.user.id;
    await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectId}, ${slug}, 'Epic QA', 'https://example.invalid/epic-qa.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button").filter({ hasText: slug }).click();
    const root = {
      id: await createPlanningEpic({
        database,
        userID: administrator,
        projectID: projectId,
        title: "Release",
      }),
    };
    await page.getByLabel("Filter by Epic").selectOption(root.id);
    await expect(page.getByLabel("Filter by Epic")).toHaveValue(root.id);
    const child = {
      id: await createPlanningEpic({
        database,
        userID: administrator,
        projectID: projectId,
        title: "Onboarding",
        parentID: root.id,
      }),
    };
    await page.getByLabel("Filter by Epic").selectOption(child.id);
    await expect(page.getByLabel("Filter by Epic")).toHaveValue(child.id);
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await page.getByLabel("Ticket title", { exact: true }).fill("Welcome new developers");
    await page.getByRole("button", { name: "Create as idea", exact: true }).click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search Epics", exact: true }).fill("onboard");
    await page
      .getByRole("dialog", { name: "Assign to Epic", exact: true })
      .getByRole("button", { name: "Onboarding", exact: true })
      .click();
    await expect
      .poll(async () => {
        const [ticket] = await database.client<
          Array<{ epicId: string | null }>
        >`SELECT epic_id AS "epicId" FROM factory.ticket WHERE project_id = ${projectId}`;
        return ticket?.epicId;
      })
      .toBe(child.id);
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await page.getByLabel("Filter by Epic").selectOption(root.id);
    const board = page.getByRole("region", { name: "Ticket board", exact: true });
    if (!(await board.getByRole("button", { name: /Welcome new developers/ }).isVisible()))
      await board.locator(".epic-stack > summary").click();
    await expect(board.getByRole("button", { name: /Welcome new developers/ })).toBeVisible();
    await expect(board.locator(".epic-progress")).toHaveText("0/1 done");
    await mkdir(".factory/screenshots", { recursive: true });
    await page.screenshot({ path: ".factory/screenshots/epics-wide.png" });
    await board.getByRole("button", { name: "Edit Epic", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit Epic", exact: true });
    expect(await edit.getByLabel("Parent Epic").locator("option").allTextContents()).toEqual([
      "No parent",
    ]);
    await page.keyboard.press("Escape");
    await expect(edit).toBeHidden();
    await expect(board.getByRole("button", { name: "Edit Epic", exact: true })).toBeFocused();
    await page.getByLabel("Filter by Epic").selectOption(child.id);
    if (!(await board.getByRole("button", { name: /Welcome new developers/ }).isVisible()))
      await board.locator(".epic-stack > summary").click();
    await board.getByRole("button", { name: "Edit Epic", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Edit Epic", exact: true })
      .getByLabel("Epic title")
      .fill("Developer onboarding");
    await page
      .getByRole("dialog", { name: "Edit Epic", exact: true })
      .getByLabel("Parent Epic")
      .selectOption("");
    await page
      .getByRole("dialog", { name: "Edit Epic", exact: true })
      .getByRole("button", { name: "Save Epic", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "Edit Epic", exact: true })).toBeHidden();
    const [edited] = await database.client<
      Array<{ title: string; parentId: string | null }>
    >`SELECT title, parent_id AS "parentId" FROM factory.epic WHERE id = ${child.id}`;
    expect(edited).toEqual({ title: "Developer onboarding", parentId: null });
    await page.getByLabel("Filter by Epic").selectOption(root.id);
    await expect(board.getByRole("button", { name: /Welcome new developers/ })).toHaveCount(0);
    await page.getByLabel("Filter by Epic").selectOption(child.id);
    if (!(await board.getByRole("button", { name: /Welcome new developers/ }).isVisible()))
      await board.locator(".epic-stack > summary").click();
    await expect(board.getByRole("button", { name: /Welcome new developers/ })).toBeVisible();
    await page.setViewportSize({ width: 430, height: 860 });
    expect(await board.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: ".factory/screenshots/epics-narrow.png" });
    const dockBox = await page.getByRole("navigation", { name: "Workspace dock" }).boundingBox();
    const filterBox = await page.getByLabel("Filter by Epic").boundingBox();
    expect(dockBox && filterBox && filterBox.y >= dockBox.y + dockBox.height).toBe(true);
    await board.getByRole("button", { name: "Edit Epic", exact: true }).click();
    await page.screenshot({ path: ".factory/screenshots/epic-editor-narrow.png" });
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  } finally {
    const [owned] =
      await database.client`SELECT id FROM factory.project WHERE id = ${projectId} AND slug = ${slug}
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id = ${projectId})`;
    if (owned) await deleteFactoryProject(projectId);
    await database.client.end();
  }
});
