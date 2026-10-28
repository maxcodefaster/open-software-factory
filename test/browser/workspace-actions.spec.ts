import { mkdir } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import {
  repositoryDocumentsSchema,
  openRepositoryDocumentSchema,
} from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

const evidence = ".factory/test-results/workspace-actions";
const commit = "a".repeat(40);
const widths = [1440, 900, 430, 320];
test.use({
  viewport: { width: 1440, height: 960 },
  reducedMotion: "reduce",
  actionTimeout: 30_000,
});

async function bounds(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Expected a rendered control");
  return rect;
}

async function actionBar(page: Page, label: string, primary?: string) {
  await page.mouse.move(1, 1);
  const bar = page.getByRole("group", { name: label, exact: true });
  await expect(bar).toBeVisible();
  if (primary) {
    const primaryAction = bar.locator('[data-primary="true"]');
    await expect(primaryAction).toHaveText(primary);
    const buttons = bar.locator(":scope > .workspace-action");
    await expect(buttons.last()).toHaveAttribute("data-primary", "true");
    await expect
      .poll(() =>
        bar.evaluate((element) => {
          const action = element.querySelector<HTMLElement>('[data-primary="true"]');
          return action
            ? Math.abs(element.getBoundingClientRect().right - action.getBoundingClientRect().right)
            : Number.POSITIVE_INFINITY;
        }),
      )
      .toBeLessThanOrEqual(1);
  } else await expect(bar.locator('[data-primary="true"]')).toHaveCount(0);
  for (const control of await bar.locator(".workspace-action").all())
    await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const metrics = await bar.evaluate((element) => ({
    display: getComputedStyle(element).display,
    overflow: element.scrollWidth - element.clientWidth,
    controls: [...element.querySelectorAll<HTMLElement>(".workspace-action")].map((control) => {
      const style = getComputedStyle(control);
      const rect = control.getBoundingClientRect();
      return {
        border: style.borderWidth,
        shadow: style.boxShadow,
        background: style.backgroundColor,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        unexpectedIcons: !control.classList.contains("workspace-menu-trigger")
          ? control.querySelectorAll("svg").length
          : 0,
      };
    }),
  }));
  expect(metrics.display).toBe("flex");
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  for (const control of metrics.controls) {
    expect(control.border).toBe("0px");
    expect(control.shadow).toBe("none");
    expect(control.background).toBe("rgba(0, 0, 0, 0)");
    expect(control.height).toBeGreaterThanOrEqual(32);
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    expect(control.unexpectedIcons).toBe(0);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  return bar;
}

async function capture(page: Page, name: string, keepFocus = false) {
  await page.evaluate(() => document.fonts.ready);
  if (!keepFocus)
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
  await page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled" });
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  return page.getByRole("navigation", { name: "Settings navigation" });
}

async function chooseSettings(navigation: Locator, label: string) {
  await chooseSettingsPage(navigation.page(), label);
}

test("Wiki page and revision actions share text controls and keep history keyboard-accessible", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const slug = `actions-${projectId.slice(0, 8)}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await mkdir(evidence, { recursive: true });
    await signIn(page);
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    const [admin] = await database.client<{ id: string }[]>`
      SELECT user_id AS id FROM factory.administrator LIMIT 1
    `;
    if (!admin) throw new Error("Fixture admin missing");
    await database.client`
      INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectId},${slug},'Workspace actions','https://example.invalid/actions.git',
        'main','.devcontainer/devcontainer.json',${admin.id})
    `;
    await database.client`
      INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${pageId},${projectId},'review-process','Review process','Inspect the normal flow and relevant edge cases.',
        'Inspect the normal flow and relevant edge cases.',${commit},${admin.id})
    `;
    await database.client`
      INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
      VALUES(${revisionId},${pageId},1,'human','Earlier review process','Earlier saved guidance.',
        'Earlier saved guidance.',${commit},${admin.id})
    `;
    await database.client`
      INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,state,created_by,completed_at)
      VALUES(${crypto.randomUUID()},${projectId},${commit},'succeeded',${admin.id},now())
    `;
    await mockFactoryFunctions(page, {
      knowledge: {
        async document() {
          return openRepositoryDocumentSchema.parse({
            path: "README.md",
            title: "Source guide",
            body: "Read-only source guidance.",
            blobSha: commit,
            commitSha: commit,
          });
        },
        async documents() {
          return repositoryDocumentsSchema.parse({
            commitSha: commit,
            documents: [{ path: "README.md", title: "Source guide", sha: commit, size: 26 }],
          });
        },
      },
    });
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Review process", exact: true }).click();
    await expect(page.locator(".knowledge-article")).toContainText("Inspect the normal flow");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      await actionBar(page, "Wiki actions");
      await capture(page, `wiki-${width}`);
      const opener = page.getByRole("button", { name: "Page options", exact: true });
      await opener.click();
      const menu = page.getByRole("menu", { name: "Page options", exact: true });
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(opener).toBeFocused();
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "Page options", exact: true }).click();
    await page.getByRole("menuitem", { name: "History", exact: true }).click();
    await expect(page.getByRole("article", { name: "Selected knowledge revision" })).toBeVisible();
    await actionBar(page, "Wiki revision actions", "Restore this version");
    await capture(page, "wiki-history");
    await page.getByRole("button", { name: "Restore this version", exact: true }).click();
    await expect(page.locator(".knowledge-article:visible")).toContainText(
      "Earlier saved guidance",
    );
    await expect(page.getByRole("complementary", { name: "Knowledge history" })).toBeHidden();
    await page.getByRole("button", { name: "Code docs", exact: true }).click();
    await page.getByRole("button", { name: "README.md", exact: true }).click();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      await actionBar(page, "Wiki actions", "Open Project IDE");
      await expect(page.getByRole("link", { name: "View in Git", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Page options" })).toBeHidden();
      await capture(page, `source-guide-${width}`);
    }
    expect(errors).toEqual([]);
  } finally {
    await deleteFactoryProject(projectId);
    await database.client.end();
  }
});

test("Settings libraries share overflow-first actions, preserve drafts and keep local forms explicit", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mkdir(evidence, { recursive: true });
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  const navigation = await openSettings(page);
  await chooseSettings(navigation, "Skills");
  const skills = page.locator(".skill-library:not(.mcp-library)");
  await expect(
    skills.getByRole("button", { name: "Inspect Frontend design", exact: true }),
  ).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 });
    const bar = await actionBar(page, "Skills library actions", "Add skill");
    const menu = bar.locator('summary[aria-label="Library actions"]');
    expect((await bounds(menu)).x).toBeLessThan(
      (await bounds(bar.getByRole("button", { name: "Add skill" }))).x,
    );
    await capture(page, `skills-${width}`);
    await menu.click();
    const options = bar.locator(".skill-action-options");
    await expect(options).toBeVisible();
    const rect = await bounds(options);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    await capture(page, `skills-menu-${width}`, true);
    await menu.press("Escape");
    await expect(menu).toBeFocused();
    await expect(bar.locator("details")).toHaveJSProperty("open", false);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await skills.getByRole("button", { name: "Add skill", exact: true }).click();
  const editor = skills.getByRole("form", { name: "Skill editor", exact: true });
  await editor.getByLabel("Name", { exact: true }).fill("Retained action draft");
  await editor.getByRole("button", { name: "Back to library", exact: true }).click();
  await actionBar(page, "Skills library actions", "Resume draft");
  await skills.getByRole("button", { name: "Inspect Frontend design", exact: true }).click();
  const existingSkillActions = await actionBar(page, "Skill actions", "Edit skill");
  await expect(existingSkillActions.getByRole("button", { name: "Edit skill" })).toBeDisabled();
  await capture(page, "skill-detail");
  await page
    .getByRole("region", { name: "Skill details" })
    .getByRole("button", { name: "Back to library" })
    .click();
  await skills.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Retained action draft");
  await editor.getByLabel("When to use", { exact: true }).fill("When checking a page action bar.");
  await editor
    .getByLabel("Instructions", { exact: true })
    .fill("Check desktop and narrow layouts.");
  await editor.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(page.getByRole("region", { name: "Skill details" })).toContainText(
    "Retained action draft",
  );
  const savedSkillActions = await actionBar(page, "Skill actions", "Edit skill");
  await expect(savedSkillActions.getByRole("button", { name: "Edit skill" })).toBeEnabled();
  await capture(page, "personal-skill-detail");
  await chooseSettings(navigation, "MCP connections");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 });
    const bar = await actionBar(page, "MCP library actions", "Add MCP");
    await capture(page, `mcp-${width}`);
    await bar.locator("summary").click();
    const options = bar.locator(".skill-action-options");
    await expect(options).toBeVisible();
    const rect = await bounds(options);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    await bar.locator("summary").press("Escape");
    await expect(bar.locator("details")).toHaveJSProperty("open", false);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Add MCP", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Action layout source");
  await page.getByLabel("MCP endpoint", { exact: true }).fill("https://source.example/mcp");
  await page.getByRole("button", { name: "Save definition", exact: true }).click();
  const detail = page.getByRole("region", { name: "MCP details", exact: true });
  await expect(detail).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 960 });
    await actionBar(page, "MCP actions", "Edit definition");
    await expect(detail.getByRole("button", { name: "Connect", exact: true })).toHaveClass(
      "primary-button",
    );
    await capture(page, `mcp-detail-${width}`);
  }
  expect(errors).toEqual([]);
});

test("Settings connection and Input headers use the same actions without changing form decisions", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectId = crypto.randomUUID();
  const slug = `settings-actions-${projectId.slice(0, 8)}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockFactoryFunctions(page, {
    models: {
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
  try {
    await mkdir(evidence, { recursive: true });
    await signIn(page);
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    const [admin] = await database.client<{ id: string }[]>`
      SELECT user_id AS id FROM factory.administrator LIMIT 1
    `;
    if (!admin) throw new Error("Fixture admin missing");
    await database.client`
      INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectId},${slug},'Settings actions','https://example.invalid/settings-actions.git',
        'main','.devcontainer/devcontainer.json',${admin.id})
    `;
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    const navigation = await openSettings(page);
    await navigation
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Factory administration", exact: true }) })
      .getByRole("button", { name: "Models", exact: true })
      .click();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      const bar = await actionBar(page, "Model connection actions", "Add connection");
      await bar.scrollIntoViewIfNeeded();
      await capture(page, `model-connections-${width}`);
    }
    const add = page.getByRole("button", { name: "Add connection", exact: true });
    await page.keyboard.press("Tab");
    await add.focus();
    await expect(add).toHaveCSS("outline-style", "solid");
    await add.press("Enter");
    await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
    await page.setViewportSize({ width: 1440, height: 960 });
    await chooseSettings(navigation, "Inputs");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      await actionBar(page, "Input actions", "Add input");
      await capture(page, `inputs-${width}`);
    }
    await page.getByRole("button", { name: "Add input", exact: true }).click();
    const editor = page.getByRole("form", { name: "Input configuration", exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("button", { name: "Create input", exact: true })).toHaveClass(
      "primary-button",
    );
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await actionBar(page, "Input actions", "Add input");
    expect(errors).toEqual([]);
  } finally {
    await deleteFactoryProject(projectId);
    await database.client.end();
  }
});

test.describe("touch page actions", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("text and overflow controls keep touch-sized targets", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    const navigation = await openSettings(page);
    await chooseSettings(navigation, "Skills");
    await expect(
      page.getByRole("button", { name: "Inspect Frontend design", exact: true }),
    ).toBeVisible();
    const bar = await actionBar(page, "Skills library actions", "Add skill");
    for (const control of await bar.locator(".workspace-action").all()) {
      expect((await bounds(control)).height).toBeGreaterThanOrEqual(44);
    }
    await capture(page, "skills-touch");
  });
});
