import { repositoryDocumentsSchema } from "../../apps/factory/src/api-contracts";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import { browserBootstrap } from "../fixtures/server-functions";
import { mkdir } from "node:fs/promises";
import { expect, type Locator } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

const evidence = ".factory/test-results/workspace-headings";
test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });

async function headerLayout(header: Locator, sameRow: boolean) {
  await expect(header).toBeVisible();
  const measure = () =>
    header.evaluate((element) => {
      const title = element.querySelector(".workspace-heading-title")?.getBoundingClientRect();
      const actions = element.querySelector(".workspace-action-bar")?.getBoundingClientRect();
      if (!title || !actions) throw new Error("Missing title or page actions");
      const bounds = element.getBoundingClientRect();
      return {
        title: title.toJSON(),
        actions: actions.toJSON(),
        right: bounds.right,
        overflow: element.scrollWidth - element.clientWidth,
      };
    });
  if (sameRow)
    await expect
      .poll(async () => {
        const layout = await measure();
        return Math.abs(layout.title.top - layout.actions.top);
      })
      .toBeLessThanOrEqual(1);
  const layout = await measure();
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.actions.right).toBeLessThanOrEqual(layout.right + 1);
  expect(layout.title.top).toBeLessThanOrEqual(layout.actions.top + 1);
  if (sameRow) expect(Math.abs(layout.title.top - layout.actions.top)).toBeLessThanOrEqual(1);
  const sharedRow = layout.actions.top < layout.title.bottom - 1;
  if (sharedRow) expect(layout.title.right).toBeLessThanOrEqual(layout.actions.left + 1);
  else expect(layout.title.bottom).toBeLessThanOrEqual(layout.actions.top + 1);
}

test("document titles share their action row and remain editable, wrapping and keyboard-accessible", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const database = createDatabase(1);
  const projectID = crypto.randomUUID();
  const slug = `heading-${projectID.slice(0, 8)}`;
  const pageID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const errors: string[] = [];
  let commissioned = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:conversation\/message|agent\/(?:start|prompt)|knowledge\/generate)$/.test(
        new URL(request.url()).pathname,
      )
    )
      commissioned++;
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Owned header fixture starts no runtime");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Owned header fixture starts no runtime");
      },
    },
  });
  await mockFactoryFunctions(page, {
    knowledge: {
      documents: async () =>
        repositoryDocumentsSchema.parse({ commitSha: "a".repeat(40), documents: [] }),
    },
  });
  try {
    await mkdir(evidence, { recursive: true });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await browserBootstrap(page);
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Header layout','https://example.invalid/owned-headers.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${pageID},${projectID},'onboarding','Onboarding guide','Saved guidance.','Saved guidance.',${"a".repeat(40)},${session.user.id})`;
    await database.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
      VALUES(${revisionID},${pageID},1,'human','Onboarding guide','Saved guidance.','Saved guidance.',${"a".repeat(40)},${session.user.id})`;
    await database.client`UPDATE factory.knowledge_page SET current_revision_id=${revisionID} WHERE id=${pageID}`;
    await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,state,page_count,conflict_count,created_by,completed_at)
      VALUES(${crypto.randomUUID()},${projectID},${"a".repeat(40)},'succeeded',1,0,${session.user.id},now())`;
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await page.getByLabel("Ticket title", { exact: true }).fill("Ship onboarding");
    for (const width of [1440, 1024, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await headerLayout(page.locator(".ticket-draft-workspace .workspace-heading"), width >= 760);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${evidence}/draft-${width}.png` });
    }
    await page.getByRole("button", { name: "Create as idea", exact: true }).click();
    const ticketDocument = page.getByRole("article", { name: "Ticket document", exact: true });
    for (const width of [1440, 1024, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await headerLayout(ticketDocument.locator(".workspace-heading"), width >= 760);
      const title = ticketDocument.getByRole("textbox", { name: "Ticket title", exact: true });
      await expect(title).toHaveText("Ship onboarding");
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${evidence}/ticket-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Onboarding guide", exact: true }).click();
    const wiki = page.locator(".knowledge-document:visible");
    for (const width of [1440, 1024, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await headerLayout(wiki.locator(".workspace-heading"), width >= 760);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${evidence}/wiki-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    const longTitle =
      "Onboarding guide with a long but readable title for project contributors reviewing the exact implementation and delivery";
    await page.setViewportSize({ width: 1440, height: 900 });
    await wiki.getByRole("button", { name: "Edit Knowledge title", exact: true }).click();
    const titleField = wiki.getByRole("textbox", { name: "Knowledge page title", exact: true });
    await titleField.fill(longTitle);
    await expect
      .poll(async () => {
        const [saved] = await database.client<
          { title: string }[]
        >`SELECT title FROM factory.knowledge_page WHERE id=${pageID}`;
        return saved?.title;
      })
      .toBe(longTitle);
    await page.setViewportSize({ width: 390, height: 900 });
    await headerLayout(wiki.locator(".workspace-heading"), false);
    expect(
      await titleField.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${evidence}/wiki-edit-long-390.png` });
    await wiki.getByRole("button", { name: "Page options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Read page", exact: true }).click();
    await expect(wiki.getByRole("button", { name: "Edit Knowledge title" })).toHaveText(longTitle);
    await page.setViewportSize({ width: 1440, height: 900 });
    await wiki.getByRole("button", { name: "Page options", exact: true }).click();
    await page.getByRole("menuitem", { name: "History", exact: true }).click();
    const history = page.getByRole("complementary", { name: "Knowledge history", exact: true });
    await history.locator(".version-history-item").last().click();
    await expect(
      page.getByRole("button", { name: "Restore this version", exact: true }),
    ).toBeVisible();
    await headerLayout(page.locator(".historical-document:visible .workspace-heading"), true);
    await page.screenshot({ path: `${evidence}/wiki-history-1440.png` });
    await page.keyboard.press("Escape");
    await expect(history).toBeHidden();
    await expect(page.getByRole("button", { name: "Page options", exact: true })).toBeFocused();
    expect(commissioned).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await deleteFactoryProject(projectID, database);
    await database.client.end();
  }
});
