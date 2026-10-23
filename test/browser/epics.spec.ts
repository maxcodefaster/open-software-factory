import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { createPlanningEpic, deleteFactoryProject, signIn } from "../support/factory-fixture";

const evidence = ".factory/test-results/epic-folders";
test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(90_000);

test("Epic folders replace filtering, retain live updates and expose hierarchy and editing", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectId = crypto.randomUUID();
  const slug = `epic-qa-${projectId.slice(0, 8)}`;
  const errors: string[] = [];
  let commissioned = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:conversation\/message|agent\/(?:start|prompt))$/.test(new URL(request.url()).pathname)
    )
      commissioned++;
  });
  for (const action of ["source-workspace", "developer-ide"])
    await page.route(`**/api/projects/*/${action}/ensure`, (route) =>
      route.fulfill({ status: 503, json: { error: "Controlled planning fixture" } }),
    );
  try {
    await mkdir(evidence, { recursive: true });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await (await page.request.get("/api/session")).json();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectId},${slug},'Epic folders','https://example.invalid/owned-epics.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    const root = await createPlanningEpic({
      database,
      userID: session.user.id,
      projectID: projectId,
      title: "Release",
    });
    const child = await createPlanningEpic({
      database,
      userID: session.user.id,
      projectID: projectId,
      title: "Onboarding",
      parentID: root,
    });
    const board = page.getByRole("region", { name: "Ticket board", exact: true });
    await expect(page.getByLabel("Filter by Epic")).toHaveCount(0);
    await expect(board.getByRole("button", { name: "New Ticket", exact: true })).toBeVisible();
    await expect(board.locator(".board-toolbar button.new-ticket-button")).toHaveCount(0);
    await board.getByRole("button", { name: "New idea", exact: true }).click();
    await page.getByLabel("Ticket title", { exact: true }).fill("Welcome new developers");
    await expect(page.getByRole("button", { name: "Create as idea", exact: true })).toHaveAttribute(
      "data-primary",
      "true",
    );
    await page.getByRole("button", { name: "Create as idea", exact: true }).click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Assign to Epic", exact: true })
      .getByRole("button", { name: "Onboarding", exact: true })
      .click();
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    const openRoot = board.getByRole("button", { name: "Open Epic Release", exact: true });
    await openRoot.focus();
    await openRoot.press("Enter");
    const folder = page.getByRole("dialog", { name: "Release", exact: true });
    await expect(
      folder.getByRole("button", { name: "Open Epic Onboarding", exact: true }),
    ).toBeFocused();
    await expect(folder.locator(".epic-progress")).toHaveText("0/1 done");
    await page.screenshot({ path: `${evidence}/root-desktop.png` });
    await folder.getByRole("button", { name: "Edit Epic", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit Epic", exact: true });
    expect(await edit.getByLabel("Parent Epic").locator("option").allTextContents()).toEqual([
      "No parent",
    ]);
    await page.keyboard.press("Escape");
    await expect(edit).toBeHidden();
    await expect(folder.getByRole("button", { name: "Edit Epic", exact: true })).toBeFocused();
    await folder.getByRole("button", { name: "Open Epic Onboarding", exact: true }).click();
    const childFolder = page.getByRole("dialog", { name: "Onboarding", exact: true });
    const card = childFolder.getByRole("button", { name: /Welcome new developers/ });
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await database.client`UPDATE factory.ticket SET title='Welcome every developer',version=version+1 WHERE project_id=${projectId}`;
    await expect(
      childFolder.getByRole("button", { name: /Welcome every developer/ }),
    ).toBeVisible();
    await expect(
      childFolder.getByRole("button", { name: /Welcome every developer/ }),
    ).toBeFocused();
    await childFolder.getByRole("button", { name: "Edit Epic", exact: true }).click();
    await edit.getByLabel("Epic title").fill("Developer onboarding");
    await edit.getByLabel("Parent Epic").selectOption("");
    await edit.getByRole("button", { name: "Save Epic", exact: true }).click();
    await expect(edit).toBeHidden();
    const renamed = page.getByRole("dialog", { name: "Developer onboarding", exact: true });
    await expect(renamed).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${evidence}/folder-narrow.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.keyboard.press("Escape");
    await expect(renamed).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Write requirements", exact: true }),
    ).toHaveAttribute("data-primary", "true");
    await page.getByLabel("Ticket title", { exact: true }).fill("Create directly in Requirements");
    await page.getByRole("button", { name: "Write requirements", exact: true }).click();
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveText(
      "Create directly in Requirements",
    );
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await expect(
      board
        .getByRole("region", { name: "requirements", exact: true })
        .getByRole("button", { name: /Create directly in Requirements/ }),
    ).toBeVisible();
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const heights = await board
        .locator(".lane-heading")
        .evaluateAll((headings) =>
          headings.map((heading) => heading.getBoundingClientRect().height),
        );
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      const opener = board.getByRole("button", {
        name: "Open Epic Developer onboarding",
        exact: true,
      });
      await opener.click();
      await page.screenshot({ path: `${evidence}/folder-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({ path: `${evidence}/board-${width}.png` });
    }
    expect(commissioned).toBe(0);
    expect(errors).toEqual([]);
    const [created] = await database.client<{ state: string }[]>`
      SELECT state FROM factory.ticket WHERE project_id=${projectId} AND title='Create directly in Requirements'`;
    expect(created?.state).toBe("ready");
    const [edited] = await database.client<{ parent_id: string | null }[]>`
      SELECT parent_id FROM factory.epic WHERE id=${child}`;
    expect(edited?.parent_id).toBe(null);
  } finally {
    await deleteFactoryProject(projectId, database);
    await database.client.end();
  }
});
