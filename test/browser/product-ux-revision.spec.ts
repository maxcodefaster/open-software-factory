import { completedConversation } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { conversationViewSchema } from "../../apps/factory/src/api-contracts";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { browserBootstrap } from "../fixtures/server-functions";
import { documentBlocks } from "../../apps/factory/src/document-model";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(20_000);
let projectID = "";
let ticketID = "";
let userID = "";
const title = "Clarify the starter experience";

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  userID = session.user.id;
  const database = createDatabase(1);
  projectID = crypto.randomUUID();
  ticketID = crypto.randomUUID();
  try {
    await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`product-ux-${projectID}`}, 'Product UX', 'https://example.invalid/product-ux.git',
        'main', '.devcontainer/devcontainer.json', ${session.user.id})`;
    await database.client`INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
      VALUES (${ticketID}, ${projectID}, ${title}, 'A useful starter application', 'ready', ${userID})`;
  } finally {
    await database.client.end();
  }
  await openProjectMenu(page);
  await page
    .getByRole("button")
    .filter({ hasText: `product-ux-${projectID}` })
    .click();
});

test.afterEach(async () => {
  if (projectID) await deleteFactoryProject(projectID);
  projectID = "";
});

test("active dock apps minimize and restore the same retained Ticket tab", async ({ page }) => {
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  const view = page.locator(".workspace-window");
  await expect(view).toBeVisible();
  const tabs = await page.getByRole("tab").allTextContents();
  await page.getByRole("button", { name: "Ticket", exact: true }).click();
  await expect(view).toBeHidden({ timeout: 3_000 });
  await page.getByRole("button", { name: "Ticket", exact: true }).click();
  await expect(view).toBeVisible();
  expect(await page.getByRole("tab").allTextContents()).toEqual(tabs);
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(title);
});

test("Agent opener stays square even with a long Project label on narrow screens", async ({
  page,
}) => {
  for (const width of [360, 430, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const control = page.getByRole("button", { name: "Toggle Agent panel", exact: true });
    const box = await control.boundingBox();
    if (!box) throw new Error("Agent opener missing");
    expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    expect(box.width).toBeGreaterThan(30);
  }
});

test("Models and Skills are visible entry points in Settings", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const personal = page
    .getByRole("navigation", { name: "Settings navigation" })
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Personal", exact: true }) });
  await expect(personal.getByRole("button", { name: "Model overrides", exact: true })).toBeVisible({
    timeout: 3_000,
  });
  await expect(
    page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "Skills", exact: true }),
  ).toBeVisible({
    timeout: 3_000,
  });
});

test("Requirements offers the Interview directly", async ({ page }) => {
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  await expect(
    page.getByRole("button", { name: "Clarify requirements", exact: true }),
  ).toBeVisible();
});

test("Enter sends, Shift+Enter preserves a line and navigation selects context automatically", async ({
  page,
}) => {
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const input = page.getByRole("textbox", { name: "Message conversation", exact: true });
  const singleLine = await input.boundingBox();
  if (!singleLine) throw new Error("Missing message composer");
  expect(singleLine.height).toBeLessThanOrEqual(32);
  const captured: { body?: { text: string; ticketId?: string | undefined } } = {};
  await mockFactoryFunctions(page, {
    conversations: {
      message: async (_actor, factoryTargetID, factoryCommand) => {
        captured.body = factoryCommand;
        return (() => {
          throw new CommandError("invalid", String("Controlled response, no model request"));
        })();
      },
    },
  });
  await input.fill("First line");
  await input.press("Shift+Enter");
  await input.pressSequentially("Second line");
  await expect
    .poll(async () => (await input.boundingBox())?.height ?? 0)
    .toBeGreaterThan(singleLine.height);
  expect(captured.body).toBeUndefined();
  await input.press("Enter");
  await expect.poll(() => captured.body?.text).toBe("First line\nSecond line");
  expect(captured.body).toHaveProperty("ticketId", ticketID);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  delete captured.body;
  await input.fill("Project question");
  await input.press("Enter");
  await expect.poll(() => captured.body?.text).toBe("Project question");
  expect(captured.body).not.toHaveProperty("ticketId");
  await page.getByRole("button", { name: "Minimize Agent panel" }).click();
  await page.getByRole("tab", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  delete captured.body;
  await input.fill("Ticket question again");
  await input.press("Enter");
  await expect.poll(() => captured.body?.text).toBe("Ticket question again");
  expect(captured.body).toHaveProperty("ticketId", ticketID);
  await expect(page.getByRole("button", { name: "Remove Ticket context" })).toHaveCount(0);
});

test("rich slash and selection formatting save a new immutable Spec", async ({ page }) => {
  const original = JSON.stringify({
    summary: "Help developers understand the **first run**.",
    acceptanceCriteria: ["The starter has a healthy preview."],
    nonGoals: [],
  });
  const database = createDatabase(1);
  try {
    await database.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES(${crypto.randomUUID()}, ${ticketID}, 1, ${original}, ${createHash("sha256").update(original).digest("hex")}, ${userID})`;
    await page
      .getByRole("region", { name: "requirements", exact: true })
      .locator(".ticket-card-body")
      .click();
    const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
    await expect(summary.locator("strong")).toHaveText("first run");
    await summary.click();
    await summary.press("ControlOrMeta+End");
    await summary.press("Enter");
    await summary.pressSequentially("/");
    await expect(
      page.getByRole("menu", { name: "Specification blocks" }).getByRole("menuitem"),
    ).toHaveText([
      ...documentBlocks.map((block) => block.label),
      "Acceptance criterion",
      "Non-goal",
    ]);
    const caret = await summary.evaluate(() => {
      const range = window.getSelection()?.getRangeAt(0);
      if (!range) throw new Error("Caret missing");
      const rect = range.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const menuBox = await page.getByRole("menu", { name: "Specification blocks" }).boundingBox();
    if (!menuBox) throw new Error("Slash menu missing");
    expect(
      Math.min(
        Math.abs(menuBox.y - caret.bottom),
        Math.abs(menuBox.y + menuBox.height - caret.top),
      ),
    ).toBeLessThanOrEqual(12);
    await page.getByRole("menuitem", { name: "Heading", exact: true }).click();
    await summary.pressSequentially("A clear first step");
    for (let i = 0; i < 4; i++) await summary.press("Shift+ArrowLeft");
    await page
      .getByRole("toolbar", { name: "Text formatting" })
      .getByRole("button", { name: "Bold", exact: true })
      .click();
    await expect
      .poll(async () => {
        const [saved] = await database.client<
          { content: string }[]
        >`SELECT canonical_content AS content FROM factory.ticket_document_revision WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
        return saved ? JSON.parse(saved.content).summary : "";
      })
      .toContain("## A clear first **step**");
    const rows = await database.client<Array<{ ordinal: number; canonicalContent: string }>>`
      SELECT ordinal, canonical_content AS "canonicalContent" FROM factory.requirement_revision
    WHERE ticket_id = ${ticketID} ORDER BY ordinal`;
    expect(rows.map((row) => row.ordinal)).toEqual(
      Array.from({ length: rows.length }, (_, index) => index + 1),
    );
    expect(rows[0]?.canonicalContent).toBe(original);
    const [saved] = await database.client<
      Array<{ canonicalContent: string }>
    >`SELECT canonical_content AS "canonicalContent" FROM factory.ticket_document_revision WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
    if (!saved) throw new Error("Immutable document revision missing");
    expect(JSON.parse(saved.canonicalContent).summary).toContain("## A clear first **step**");
    expect(await page.locator("body").innerText()).not.toContain("biome-ignore");
    await mkdir(".factory/test-results/workspace-headings", { recursive: true });
    await page.screenshot({ path: ".factory/test-results/workspace-headings/spec-wide.png" });
    await page.setViewportSize({ width: 430, height: 860 });
    await expect
      .poll(async () => {
        const metadata = await page.locator(".ticket-status-context").boundingBox();
        const actions = await page.locator(".ticket-header-actions").boundingBox();
        if (!metadata || !actions) throw new Error("Narrow Ticket header missing");
        return actions.y + actions.height <= metadata.y;
      })
      .toBe(true);
    expect(
      await page
        .locator(".ticket-status-context span")
        .first()
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThan(24);
    await page.screenshot({ path: ".factory/test-results/workspace-headings/spec-narrow.png" });
  } finally {
    await database.client.end();
  }
});

test("slash commands stay beside the caret in a dense document", async ({ page }) => {
  const database = createDatabase(1);
  const content = JSON.stringify({
    summary: Array.from(
      { length: 18 },
      (_, index) =>
        `Paragraph ${index + 1}. ${"A clear document retains the human's authored scope. ".repeat(5)}`,
    ).join("\n\n"),
    acceptanceCriteria: ["Retain all text"],
    nonGoals: [],
  });
  try {
    await database.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${crypto.randomUUID()}, ${ticketID}, 1, ${content}, ${createHash("sha256").update(content).digest("hex")}, ${userID})`;
  } finally {
    await database.client.end();
  }
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
  await summary.click();
  await summary.press("ControlOrMeta+Home");
  await summary.press("ArrowRight");
  await summary.pressSequentially("/");
  const menu = page.getByRole("menu", { name: "Specification blocks" });
  await expect(menu).toBeVisible();
  const caret = await summary.evaluate(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) throw new Error("Missing slash-command caret");
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  const bounds = await menu.boundingBox();
  if (!bounds) throw new Error("Menu bounds missing");
  const placement = await menu.getAttribute("data-placement");
  const frame = await page.locator(".ticket-editor-frame").boundingBox();
  expect(
    Math.min(Math.abs(bounds.y - caret.bottom), Math.abs(bounds.y + bounds.height - caret.top)),
    JSON.stringify({ caret, bounds, placement, frame }),
  ).toBeLessThanOrEqual(12);
});

test("new answers respect a reader's scroll position and pending feedback is immediate", async ({
  page,
}) => {
  const entries = Array.from({ length: 28 }, (_, index) => ({
    id: crypto.randomUUID(),
    ordinal: index + 1,
    kind: "agent-message",
    actor: "project-agent",
    mode: "plan",
    body: `## Answer ${index + 1}\n\nA **readable** response with context.\n\n- First point\n- Second point`,
    payload: {},
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdAt: `2026-10-09T08:00:${String(index).padStart(2, "0")}Z`,
  }));
  const view = {
    id: crypto.randomUUID(),
    projectId: projectID,
    ticketId: ticketID,
    mode: "plan",
    version: 1,
    entries,
  };
  await mockFactoryFunctions(page, {
    conversations: { get: async () => conversationViewSchema.nullable().parse(view) },
  });
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockFactoryFunctions(page, {
    conversations: {
      message: async (_actor, factoryTargetID, factoryCommand) => {
        await ready;
        return completedConversation(
          conversationViewSchema.parse({
            ...view,
            version: 2,
            entries: [
              ...entries,
              {
                ...entries[0],
                id: crypto.randomUUID(),
                ordinal: 29,
                body: "## A fresh reply\n\nStill respects reading position.",
                createdAt: "2026-10-09T08:01:00Z",
              },
            ],
          }),
        );
      },
    },
  });
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const history = page.locator(".conversation-history");
  await expect(history.locator("h2")).toHaveCount(28);
  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await history.hover();
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0);
  const input = page.getByRole("textbox", { name: "Message conversation", exact: true });
  await input.fill("One more answer");
  await input.press("Enter");
  await expect(page.getByRole("status", { name: "Assistant responding" })).toBeVisible();
  expect(await history.evaluate((element) => element.scrollTop)).toBe(0);
  release?.();
  await expect(history.locator("h2")).toHaveCount(29);
  await expect(page.getByRole("status", { name: "Assistant responding" })).toBeHidden();
  expect(await history.evaluate((element) => element.scrollTop)).toBe(0);
});

test("an Epic stack retains expansion through fresh board projections", async ({ page }) => {
  const database = createDatabase(1);
  const epicID = crypto.randomUUID();
  try {
    await database.client`INSERT INTO factory.epic(id, project_id, title, created_by)
      VALUES(${epicID}, ${projectID}, 'First developer experience', ${userID})`;
    await database.client`UPDATE factory.ticket SET epic_id = ${epicID} WHERE id = ${ticketID}`;
    const stack = page.locator(".epic-stack");
    await expect(stack).toBeVisible();
    await stack.getByRole("button", { name: "Open Epic First developer experience" }).click();
    const folder = page.getByRole("dialog", { name: "First developer experience", exact: true });
    const card = folder.locator(".ticket-card-body");
    await expect(card).toBeVisible();
    await database.client`UPDATE factory.ticket SET title = ${title + " updated"}, version = version + 1 WHERE id = ${ticketID}`;
    await expect(card).toContainText("updated");
    await expect(folder).toBeVisible();
    await mkdir(".factory/test-results/epic-folders", { recursive: true });
    await page.screenshot({ path: ".factory/test-results/epic-folders/live-folder-update.png" });
    await card.click();
    await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
      title + " updated",
    );
  } finally {
    await database.client.end();
  }
});
