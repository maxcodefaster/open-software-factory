import { requestFunction } from "../fixtures/server-functions";
import { mockFactoryFunctions, browserFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { documentBlocks } from "../../apps/factory/src/document-model";
import { CommandError } from "../../apps/factory/src/command-error";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  repositoryDocumentsSchema,
  knowledgeGenerationSchema,
  knowledgeSearchSchema,
  openRepositoryDocumentSchema,
  ticketDetailSchema,
} from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";
import { luminance, rgb } from "../support/visual-contrast";

let userID = "";
const evidenceDirectory = ".factory/test-results/document-coherence";
const commit = "a".repeat(40);
const title =
  "A readable release summary with exact delivery context and useful repository sources";
let database: ReturnType<typeof createDatabase> | undefined;
let projectID = "";
let projectSlug = "";
let ticketID = "";
let pageID = "";
let browserErrors: string[] = [];

async function addRequirement(summary: string, ordinal: number) {
  if (!database) throw new Error("Fixture database unavailable");
  const content = JSON.stringify({
    summary,
    acceptanceCriteria: ["Readers can identify the **delivered revision**."],
    nonGoals: ["An automatic deployment pipeline."],
  });
  await database.client`
    INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
    VALUES (${crypto.randomUUID()}, ${ticketID}, ${ordinal}, ${content},
      ${createHash("sha256").update(content).digest("hex")}, ${userID})
  `;
}

async function openFixture(page: Page) {
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
}

async function openTicket(page: Page) {
  await page.getByRole("region", { name: "requirements" }).locator(".ticket-card-body").click();
  await expect(page.getByRole("textbox", { name: "Ticket title" })).toHaveText(title);
}

async function openKnowledge(page: Page) {
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(".knowledge-article")).toContainText("Saved human explanation");
}
async function openPageHistory(page: Page) {
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
}
async function readWiki(page: Page) {
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Read page", exact: true }).click();
}

test("Wiki page options shares keyboard navigation and returns focus on Escape", async ({
  page,
}) => {
  await openFixture(page);
  await openKnowledge(page);
  const opener = page.getByRole("button", { name: "Page options", exact: true });
  await opener.click();
  const menu = page.getByRole("menu", { name: "Page options", exact: true });
  await expect(menu.getByRole("menuitem").first()).toBeFocused({ timeout: 1500 });
  await expect(menu.getByRole("menuitem").last()).toBeEnabled();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(opener).toBeFocused();
});

async function waitForSpecLayout(page: Page, width: number) {
  await page.evaluate(() => document.fonts.ready);
  // Wide selection fixtures open the Agent. Do not measure the previous centered window.
  const rootSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const targetWidth = width > 900 ? width - 430 - 3 * 28 : width - 1.3 * rootSize;
  await expect
    .poll(async () => {
      const bounds = await page.locator(".workspace-window").boundingBox();
      return bounds ? Math.abs(bounds.width - targetWidth) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1);
}

async function expectInlineChecklist(editor: Locator) {
  const layout = await editor
    .locator('ul[data-type="taskList"] > li')
    .first()
    .evaluate((row) => {
      const checkbox = row.querySelector("input")?.getBoundingClientRect();
      const text = row.querySelector("p");
      if (!checkbox || !text) throw new Error("Missing checklist controls");
      const range = document.createRange();
      range.selectNodeContents(text);
      const firstLine = range.getClientRects()[0];
      if (!firstLine) throw new Error("Missing checklist text line");
      return {
        display: getComputedStyle(row).display,
        gap: firstLine.left - checkbox.right,
        sameLine: checkbox.top < firstLine.bottom && checkbox.bottom > firstLine.top,
      };
    });
  expect(layout.display).toBe("flex");
  expect(layout.sameLine).toBe(true);
  expect(layout.gap).toBeGreaterThanOrEqual(0);
  expect(layout.gap).toBeLessThanOrEqual(16);
}

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on("pageerror", (cause) => browserErrors.push(cause.message));
  await mkdir(evidenceDirectory, { recursive: true });
  database = createDatabase(1);
  const [admin] = await database.client<{ id: string }[]>`
    SELECT id FROM auth."user" WHERE email=${process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local"}`;
  if (!admin) throw new Error("Document fixture administrator is missing");
  userID = admin.id;
  projectID = crypto.randomUUID();
  projectSlug = `documents-${projectID.slice(0, 8)}`;
  ticketID = crypto.randomUUID();
  pageID = crypto.randomUUID();
  // This suite owns planning/editor data, not native infrastructure preparation.
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture has no source");
      },
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture has no IDE");
      },
    },
  });
  await database.client`
    INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
    VALUES (${projectID}, ${projectSlug}, 'Document coherence', 'https://example.invalid/documents.git',
      'main', '.devcontainer/devcontainer.json', ${userID})
  `;
  await database.client`
    INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
    VALUES (${ticketID}, ${projectID}, ${title}, '', 'ready', ${userID})
  `;
  const body = "## Release context\n\nSaved human explanation with **exact delivery** context.\n";
  const currentRevisionID = crypto.randomUUID();
  await database.client`
    INSERT INTO factory.knowledge_page(id, project_id, slug, title, current_body, generated_body,
      source_commit_sha, citations, created_by)
    VALUES (${pageID}, ${projectID}, 'release-context', ${title}, ${body}, ${body}, ${commit},
      ${JSON.stringify([{ path: "README.md", commitSha: commit }])}::jsonb, ${userID})
  `;
  for (const ordinal of [1, 2]) {
    await database.client`
      INSERT INTO factory.knowledge_revision(id, page_id, ordinal, kind, title, body, generated_body,
        source_commit_sha, created_by)
      VALUES (${ordinal === 1 ? currentRevisionID : crypto.randomUUID()}, ${pageID}, ${ordinal},
        ${ordinal === 1 ? "human" : "generated"}, ${title}, ${body}, ${body},
        ${commit}, ${userID})
    `;
  }
  await database.client`
    UPDATE factory.knowledge_page SET current_revision_id = ${currentRevisionID} WHERE id = ${pageID}
  `;
  await database.client`
    INSERT INTO factory.knowledge_generation(id, project_id, source_commit_sha, state,
      page_count, conflict_count, created_by, completed_at)
    VALUES (${crypto.randomUUID()}, ${projectID}, ${commit}, 'succeeded', 1, 1, ${userID}, now())
  `;
  await mockFactoryFunctions(page, {
    knowledge: {
      documents: async () => repositoryDocumentsSchema.parse({ commitSha: commit, documents: [] }),
    },
  });
});

test.afterEach(async () => {
  if (projectID) await deleteFactoryProject(projectID);
  await database?.client.end();
  database = undefined;
  projectID = "";
  expect(browserErrors).toEqual([]);
});

test("filters Knowledge while typing and retains the query through Enter", async ({ page }) => {
  await mockFactoryFunctions(page, {
    knowledge: {
      async search(_actor, _project, query) {
        return knowledgeSearchSchema.parse({
          results:
            query === "release"
              ? [
                  {
                    id: pageID,
                    kind: "page",
                    title,
                    path: "release-context",
                    snippet: "Saved human explanation",
                  },
                ]
              : [],
        });
      },
    },
  });
  await openFixture(page);
  await openKnowledge(page);
  await page.getByRole("button", { name: "Search Wiki", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search Knowledge" });
  await search.fill("missing");
  await expect(page.locator(".wiki-search-results")).toContainText("No matching pages");
  await expect(
    page.locator(".knowledge-tree").getByRole("button", { name: title, exact: true }),
  ).toHaveCount(1);
  await expect(search).toHaveValue("missing");
  await search.press("Enter");
  await expect(search).toHaveValue("missing");
  await expect(page.locator(".wiki-search-results")).toContainText("No matching pages");
  await search.fill("release");
  await expect(page.locator(".wiki-search-results")).toContainText(title);
  await search.fill("");
  await page.getByRole("button", { name: "Close search" }).click();
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
});

test("searches nested repository documents with a snippet and ignores a late earlier reply", async ({
  page,
}) => {
  const path = "docs/operations/runbook.md";
  await mockFactoryFunctions(page, {
    knowledge: {
      documents: async () =>
        repositoryDocumentsSchema.parse({
          commitSha: commit,
          documents: [{ path, title: "runbook", sha: commit, size: 20 }],
        }),
    },
  });
  const release = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  await mockFactoryFunctions(page, {
    knowledge: {
      async search(_actor, _project, query) {
        if (query === "older") {
          requested.resolve();
          await release.promise;
        }
        return knowledgeSearchSchema.parse({
          results:
            query === "runbook"
              ? [
                  {
                    id: `document:${path}`,
                    kind: "document",
                    title: "runbook",
                    path,
                    snippet: "Restart the web service safely.",
                  },
                ]
              : [],
        });
      },
    },
  });
  await openFixture(page);
  await openKnowledge(page);
  await page.getByRole("button", { name: "Search Wiki", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search Knowledge" });
  await search.fill("older");
  await requested.promise;
  await search.fill("runbook");
  const document = page.locator(".wiki-search-result");
  await expect(document).toContainText("Restart the web service safely.");
  release.resolve();
  await expect(search).toHaveValue("runbook");
  await expect(document).toBeVisible();
  await expect(
    page.locator(".knowledge-tree").getByRole("button", { name: title, exact: true }),
  ).toHaveCount(1);
});

test("filters Wiki slash blocks at the caret and removes the whole query on insertion", async ({
  page,
}) => {
  await openFixture(page);
  await openKnowledge(page);
  await page.locator(".knowledge-article").click();
  const editor = page.getByRole("textbox", { name: "Knowledge body", exact: true });
  await editor.fill("/ta");
  const menu = page.getByRole("menu", { name: "Knowledge blocks" });
  await expect(menu.getByRole("menuitem")).toHaveCount(1);
  await expect(menu.getByRole("menuitem", { name: "Table", exact: true })).toBeVisible();
  const geometry = await menu.evaluate((element) => {
    const caret = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      caret: caret ? { left: caret.left, bottom: caret.bottom } : undefined,
      menu: { left: bounds.left, top: bounds.top },
    };
  });
  if (!geometry.caret) throw new Error("Missing caret");
  expect(Math.abs(geometry.menu.left - geometry.caret.left)).toBeLessThanOrEqual(12);
  expect(geometry.menu.top - geometry.caret.bottom).toBeGreaterThanOrEqual(0);
  expect(geometry.menu.top - geometry.caret.bottom).toBeLessThanOrEqual(16);
  await editor.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(editor.locator("table")).toHaveCount(1);
  await expect(editor).not.toContainText("/ta");
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Read page", exact: true }).click();
});

test("repository documents stay read-only and their write route creates no planning work", async ({
  page,
}) => {
  const path = "docs/runbook.md";
  await mockFactoryFunctions(page, {
    knowledge: {
      async document() {
        return openRepositoryDocumentSchema.parse({
          path,
          title: "runbook",
          body: "## Runbook\nRestart safely.",
          blobSha: commit,
          commitSha: commit,
        });
      },
      async documents() {
        return repositoryDocumentsSchema.parse({
          commitSha: commit,
          documents: [{ path, title: "runbook", sha: commit, size: 20 }],
        });
      },
    },
  });
  await openFixture(page);
  await openKnowledge(page);
  await page.getByRole("button", { name: "Code docs", exact: true }).click();
  await page.getByRole("button", { name: "docs", exact: true }).click();
  await page.getByRole("button", { name: path, exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await page.getByLabel("Repository document", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Knowledge body", exact: true })).toHaveCount(0);
  const response = await page.request.put(`/api/projects/${projectID}/knowledge/documents`, {
    headers: { origin: new URL(page.url()).origin },
    data: { path, expectedBlobSha: commit, body: "Overwrite" },
  });
  expect(response.status()).toBe(404);
  if (!database) throw new Error("Fixture database unavailable");
  const counts = await database.client<{ tickets: number; changes: number }[]>`
    SELECT (SELECT count(*)::integer FROM factory.ticket WHERE project_id=${projectID}) AS tickets,
      (SELECT count(*)::integer FROM factory.change WHERE project_id=${projectID}) AS changes
  `;
  expect(counts[0]).toEqual({ tickets: 1, changes: 0 });
});

test("renders formatted Ticket revision summaries with current state and keyboard dismissal", async ({
  page,
}) => {
  await addRequirement("Earlier **release scope**.", 1);
  await addRequirement(
    "A **compact release** with cited delivery context.\n\n- [ ] Review the summary",
    2,
  );
  await openFixture(page);
  await openTicket(page);
  const opener = page.getByRole("menuitem", { name: "History", exact: true });
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await opener.click();
  const history = page.getByRole("complementary", { name: "Specification history" });
  await expect(history).toContainText("Current");
  await expect(history).toContainText("Earlier");
  await history.getByRole("button", { name: /Version 2/ }).click();
  expect(
    await page
      .locator(".historical-document h2")
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("Inter");
  await expect(page.locator(".historical-document .requirement-check-box")).toHaveCount(0);
  await expect(page.locator(".historical-document .requirement-marker")).toHaveText("·");
  const checklist = page.locator('.historical-document li:has(> input[type="checkbox"])');
  expect(await checklist.evaluate((element) => getComputedStyle(element).listStyleType)).toBe(
    "none",
  );
  await history.getByRole("button", { name: /Version 1/ }).click();
  await expect(
    page.locator(".historical-document").getByText("release scope", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidenceDirectory}/spec-history.png` });
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(page.getByRole("button", { name: "Ticket actions", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await opener.click();
  await page.getByRole("tab", { name: title, exact: true }).click();
  await expect(history).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  const bounds = await history.boundingBox();
  const workspace = await page.locator(".workspace-window").boundingBox();
  if (!bounds || !workspace) throw new Error("Missing narrow History geometry");
  expect(bounds.x).toBeGreaterThanOrEqual(workspace.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(workspace.x + workspace.width);
  await history.focus();
  await page.keyboard.press("Tab");
  await expect(history).toBeVisible();
  await expect(history.getByRole("button", { name: "Close history" })).toBeFocused();
});

test("Knowledge click-edit shares rich blocks, selection formatting and lossless immutable saves", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture unavailable");
  const body = `# ${title}\n\nSaved human explanation.\n\n| Owner | Scope |\n| --- | --- |\n| Developer | Editor |\n\n- [ ] Check the first run\n`;
  const revisionID = crypto.randomUUID();
  await database.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
    VALUES (${revisionID},${pageID},3,'human',${title},${body},${body},${commit},${userID})`;
  await database.client`UPDATE factory.knowledge_page SET current_body=${body}, current_revision_id=${revisionID} WHERE id=${pageID}`;
  await openFixture(page);
  await openKnowledge(page);
  await expect(
    page.locator(".knowledge-document").getByRole("heading", { name: title, exact: true }),
  ).toHaveCount(1);
  await expect(page.locator(".knowledge-article table")).toContainText("Developer");
  await page.locator(".knowledge-article p").first().click();
  const editor = page.getByRole("textbox", { name: "Knowledge body", exact: true });
  await expect(editor.locator("table")).toContainText("Developer");
  await expectInlineChecklist(editor);
  await expect(page.getByRole("toolbar", { name: "Markdown formatting" })).toHaveCount(0);
  await editor.getByText("Check the first run", { exact: true }).click();
  await editor.press("End");
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially("/");
  const menu = page.getByRole("menu", { name: "Knowledge blocks" });
  await expect(menu.getByRole("menuitem")).toHaveCount(documentBlocks.length);
  for (const block of documentBlocks)
    await expect(menu.getByRole("menuitem", { name: block.label, exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Heading", exact: true }).click();
  await editor.pressSequentially("Human note");
  for (let index = 0; index < 4; index++) await editor.press("Shift+ArrowLeft");
  await page
    .getByRole("toolbar", { name: "Knowledge selection formatting" })
    .getByRole("button", { name: "Bold", exact: true })
    .click();
  await expect
    .poll(async () => {
      if (!database) throw new Error("Fixture database unavailable");
      const rows = await database.client<
        Array<{ body: string }>
      >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageID}`;
      return rows[0]?.body ?? "";
    })
    .toContain("**note**");
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Read page", exact: true }).click();
  await expect(page.locator(".knowledge-article h2")).toHaveText("Human note");
  const rows = await database.client<
    Array<{ ordinal: number; body: string }>
  >`SELECT ordinal,body FROM factory.knowledge_revision WHERE page_id=${pageID} ORDER BY ordinal`;
  expect(rows.map((row) => row.ordinal)).toEqual(
    Array.from({ length: rows.length }, (_, index) => index + 1),
  );
  expect(rows[2]?.body).toBe(body);
  expect(rows.at(-1)?.body).toContain("**note**");
  expect(rows.at(-1)?.body).toContain("| Developer");
});

test("Wiki autosave keeps focused edits, merges remote prose and restores failed drafts after reload", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  await openFixture(page);
  await openKnowledge(page);
  await page.getByLabel("Edit Knowledge body", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Knowledge body", exact: true });
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("Local product framing.");
  await expect
    .poll(async () => {
      if (!database) throw new Error("No database");
      const [row] = await database.client<
        Array<{ body: string }>
      >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageID}`;
      return row?.body ?? "";
    })
    .toContain("Local product framing.");
  await expect(editor).toBeVisible();
  await mockFactoryFunctions(page, {
    knowledge: {
      async save() {
        throw new CommandError("unavailable", "Saving temporarily unavailable");
      },
    },
  });
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.pressSequentially("Recovered draft.");
  await expect(page.getByRole("alert")).toContainText("Saving temporarily unavailable");
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(editor).toContainText("Recovered draft.");
  await page.reload();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(editor).toContainText("Recovered draft.");
  const [before] = await database.client<
    Array<{ body: string; version: number }>
  >`SELECT current_body AS body,version::float8 AS version FROM factory.knowledge_page WHERE id=${pageID}`;
  if (!before) throw new Error("Missing page");
  await editor.press("ControlOrMeta+End");
  const cursorBefore = await editor.evaluate(() => {
    const selection = window.getSelection();
    return { text: selection?.anchorNode?.textContent, offset: selection?.anchorOffset };
  });
  await database.client`UPDATE factory.knowledge_page SET current_body=${before.body.replace("Saved human", "Remote human")},version=version+1 WHERE id=${pageID}`;
  await expect(editor).toContainText("Remote human");
  await expect(editor).toContainText("Recovered draft.");
  expect(
    await editor.evaluate(() => {
      const selection = window.getSelection();
      return { text: selection?.anchorNode?.textContent, offset: selection?.anchorOffset };
    }),
  ).toEqual(cursorBefore);
  await expect(page.getByRole("button", { name: "Compare changes", exact: true })).toHaveCount(0);
  await editor.fill("Local conflicting version.");
  await database.client`UPDATE factory.knowledge_page SET current_body='Remote conflicting version.',version=version+1 WHERE id=${pageID}`;
  await expect(page.getByRole("button", { name: "Compare changes", exact: true })).toBeVisible();
  await expect(editor).toContainText("Local conflicting version.");
});

test("Wiki typing and deletion survive delayed autosave acknowledgement and reload", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  await openFixture(page);
  await openKnowledge(page);
  await page.getByLabel("Edit Knowledge body", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Knowledge body", exact: true });
  let saved = false;
  const release = Promise.withResolvers<void>();
  let first = true;
  await mockFactoryFunctions(page, {
    knowledge: {
      async save(_actor, id, input) {
        const hold = first;
        first = false;
        const response = await serverCall(browserFunction(page, "saveKnowledgePage", [id, input]));
        if (hold) {
          saved = true;
          await Promise.race([
            release.promise,
            new Promise((resolve) => setTimeout(resolve, 15_000)),
          ]);
        }
        return response;
      },
    },
  });
  try {
    await editor.press("ControlOrMeta+End");
    await editor.press("Enter");
    await editor.pressSequentially("First saved phrase.");
    await expect.poll(() => saved, { timeout: 10_000 }).toBe(true);
    await editor.pressSequentially(" Continuing while save is delayed.");
    await expect(editor).toContainText("Continuing while save is delayed.");
    // Separate the native history group so Undo restores the deletion, not the whole phrase.
    await page.waitForTimeout(600);
    await editor.press("Backspace");
    await editor.press("ControlOrMeta+Z");
    await expect(editor).toContainText("Continuing while save is delayed.");
    release.resolve();
    await expect
      .poll(async () => {
        const [row] = await database!.client<Array<{ body: string }>>`
        SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageID}
      `;
        return row?.body;
      })
      .toContain("Continuing while save is delayed.");
    await editor.press("ControlOrMeta+A");
    await editor.pressSequentially("Replacement Wiki intent.");
    await expect
      .poll(async () => {
        const [row] = await database!.client<Array<{ body: string }>>`
        SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageID}
      `;
        return row?.body;
      })
      .toBe("Replacement Wiki intent.");
    await page.reload();
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: projectSlug }).click();
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(page.getByLabel("Edit Knowledge body", { exact: true })).toHaveText(
      "Replacement Wiki intent.",
    );
  } finally {
    release.resolve();
  }
});

test("Wiki organization moves through keyboard controls and retains icons across reload", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  const childId = crypto.randomUUID();
  await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,sort_order,current_body,generated_body,source_commit_sha,created_by) VALUES(${childId},${projectID},'child-page','Child page',1,'Useful child prose.','Useful child prose.',${commit},${userID})`;
  await openFixture(page);
  await openKnowledge(page);
  await page.getByRole("button", { name: "Child page", exact: true }).click();
  await page.getByLabel("Organize Wiki page", { exact: true }).click();
  await page.getByRole("combobox", { name: "Parent page", exact: true }).selectOption(pageID);
  await expect
    .poll(async () => {
      if (!database) throw new Error("No database");
      const [row] = await database.client<
        Array<{ parent: string | null }>
      >`SELECT parent_id AS parent FROM factory.knowledge_page WHERE id=${childId}`;
      return row?.parent;
    })
    .toBe(pageID);
  await page.getByRole("button", { name: "Use home icon", exact: true }).click();
  await expect
    .poll(async () => {
      if (!database) throw new Error("No database");
      const [row] = await database.client<
        Array<{ icon: string }>
      >`SELECT icon FROM factory.knowledge_page WHERE id=${childId}`;
      return row?.icon;
    })
    .toBe("home");
  await page.getByRole("button", { name: `Toggle ${title} children`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Child page", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByRole("button", { name: "Child page", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Code docs", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("Wiki table controls and highlighted code retain Markdown through Tab, undo and autosave", async ({
  page,
  context,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  const body =
    "Saved human explanation.\n\n| Owner | Scope |\n| --- | --- |\n| Developer | Editor |\n\n```ts\nconst ready = true;\n```";
  await database.client`UPDATE factory.knowledge_page SET current_body=${body},generated_body=${body} WHERE id=${pageID}`;
  await openFixture(page);
  await openKnowledge(page);
  await page.getByLabel("Edit Knowledge body", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Knowledge body", exact: true });
  await editor.locator("td").first().click();
  await page.getByRole("button", { name: "Table actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Column after", exact: true }).click();
  await expect(editor.locator("tr").first().locator("th,td")).toHaveCount(3);
  await editor.press("ControlOrMeta+z");
  await expect(editor.locator("tr").first().locator("th,td")).toHaveCount(2);
  await editor.locator("td p").last().click();
  await expect
    .poll(() =>
      editor.evaluate(() => {
        const selection = window.getSelection();
        const anchor = selection?.anchorNode?.parentElement;
        return anchor?.closest("td")?.textContent;
      }),
    )
    .toBe("Editor");
  await page.keyboard.press("Tab");
  await expect(editor.locator("tr")).toHaveCount(3, { timeout: 5_000 });
  await page.getByRole("button", { name: "Table actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete row", exact: true }).click();
  await expect(editor.locator("tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Table actions", exact: true }).focus();
  await page.getByRole("button", { name: "Table actions", exact: true }).press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Column before", exact: true })).toBeFocused();
  await page.getByRole("menuitem", { name: "Column before", exact: true }).press("Escape");
  await expect(page.getByRole("menu", { name: "Table actions", exact: true })).toHaveCount(0);
  await editor.locator("pre").click();
  await expect(editor.locator(".hljs-keyword")).toContainText("const");
  await page
    .getByRole("combobox", { name: "Code language", exact: true })
    .selectOption("javascript");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const ready = true;");
  await expect
    .poll(async () => {
      if (!database) throw new Error("No database");
      const [row] = await database.client<
        Array<{ body: string }>
      >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageID}`;
      return row?.body ?? "";
    })
    .toContain("```javascript");
  const [saved] = await database.client<
    Array<{ body: string }>
  >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageID}`;
  expect(saved?.body).toContain("Developer");
  expect(saved?.body).toContain("Editor");
  expect(saved?.body).toContain("const ready = true;");
  await page.screenshot({ path: `${evidenceDirectory}/wiki-table-code.png` });
});

test("Wiki drag movement rejects source writes and History restores a new human revision", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  const childId = crypto.randomUUID();
  await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by) VALUES(${childId},${projectID},'child-page','Child page','Useful child.','Useful child.',${commit},${userID})`;
  await openFixture(page);
  await openKnowledge(page);
  const child = page.getByRole("region", { name: "Move Child page", exact: true });
  const parent = page.getByRole("region", { name: `Move ${title}`, exact: true });
  await child.dragTo(parent, { targetPosition: { x: 100, y: 16 } });
  await expect
    .poll(async () => {
      if (!database) throw new Error("No database");
      return (
        await database.client<
          Array<{ parent: string | null }>
        >`SELECT parent_id AS parent FROM factory.knowledge_page WHERE id=${childId}`
      )[0]?.parent;
    })
    .toBe(pageID);
  await page.getByRole("button", { name: "Code docs", exact: true }).click();
  await child.dragTo(page.getByRole("button", { name: "Wiki", exact: true }));
  await expect
    .poll(async () => {
      if (!database) throw new Error("Fixture database unavailable");
      return (
        await database.client<
          Array<{ parent: string | null }>
        >`SELECT parent_id AS parent FROM factory.knowledge_page WHERE id=${childId}`
      )[0]?.parent;
    })
    .toBeNull();
  await parent.dragTo(page.getByRole("button", { name: "Code docs", exact: true }));
  await expect(page.locator(".wiki-tree-notice")).toContainText("read-only");
  const [before] = await database.client<
    Array<{ body: string; version: number }>
  >`SELECT current_body AS body,version::integer AS version FROM factory.knowledge_page WHERE id=${pageID}`;
  if (!before) throw new Error("No page");
  const saved = await browserFunction(page, "saveKnowledgePage", [
    pageID,
    { expectedVersion: before.version, title, body: "Changed human explanation." },
  ]);
  expect(saved.ok).toBe(true);
  await expect(page.locator(".knowledge-article")).toContainText("Changed human explanation.");
  await openPageHistory(page);
  const history = page.getByRole("complementary", { name: "Knowledge history" });
  await expect(history.locator(".version-history-item")).toHaveCount(3);
  await history.getByRole("button").last().click();
  await expect(page.getByLabel("Historical page")).toContainText("Saved human explanation");
  await page.getByRole("button", { name: "Restore this version", exact: true }).click();
  await expect(history).toBeHidden();
  await expect(page.locator(".knowledge-article")).toContainText("Saved human explanation");
  const revisions = await database.client<
    Array<{ kind: string; body: string }>
  >`SELECT kind,body FROM factory.knowledge_revision WHERE page_id=${pageID} ORDER BY ordinal`;
  expect(revisions).toHaveLength(4);
  expect(revisions.at(-1)?.kind).toBe("human");
  expect(revisions.at(-1)?.body).toBe(before.body);
});

test("Wiki insertion targets do not reorder on hover and navigation resize is retained", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  const sibling = crypto.randomUUID();
  await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,sort_order,current_body,generated_body,source_commit_sha,created_by) VALUES(${sibling},${projectID},'sibling','Sibling',1,'Useful content.','Useful content.',${commit},${userID})`;
  await openFixture(page);
  await openKnowledge(page);
  const row = page.getByRole("region", { name: `Move ${title}`, exact: true });
  const bounds = await row.boundingBox();
  if (!bounds) throw new Error("Tree row unavailable");
  const transfer = await page.evaluateHandle(() => {
    const value = new DataTransfer();
    value.setData("application/x-factory-wiki-page", "{}");
    return value;
  });
  for (const [position, fraction] of [
    ["before", 0.1],
    ["inside", 0.5],
    ["after", 0.9],
  ] as const) {
    await row.dispatchEvent("dragover", {
      dataTransfer: transfer,
      clientY: bounds.y + bounds.height * fraction,
    });
    await expect(row).toHaveAttribute("data-drop-position", position);
    expect(
      (
        await database.client<
          Array<{ parent: string | null }>
        >`SELECT parent_id AS parent FROM factory.knowledge_page WHERE id=${sibling}`
      )[0]?.parent,
    ).toBeNull();
  }
  await row.dispatchEvent("dragend");
  const divider = page.getByRole("separator", { name: "Wiki navigation width" });
  await divider.focus();
  await divider.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "360");
  await divider.press("Home");
  await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "184");
  await page.reload();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await openKnowledge(page);
  await expect(divider).toHaveAttribute("aria-valuenow", "184");
  await expect(page.locator(".knowledge-navigation")).toHaveCSS("width", "184px");
  const icon = await page.locator(".knowledge-title-row .page-organization").boundingBox();
  const heading = await page.locator(".knowledge-title-row h2").boundingBox();
  if (!icon || !heading) throw new Error("Inline title unavailable");
  expect(icon.x + icon.width).toBeLessThan(heading.x);
  expect(Math.abs(icon.y - heading.y)).toBeLessThan(12);
  const titleButton = page.getByRole("button", { name: "Edit Knowledge title", exact: true });
  expect(await titleButton.innerText()).toBe(title);
  expect(
    await titleButton.evaluate((element) => ({
      vertical:
        element.scrollHeight <= (element.parentElement?.clientHeight ?? 0) &&
        getComputedStyle(element).overflow === "visible",
      horizontal: element.scrollWidth <= element.clientWidth + 1,
    })),
  ).toEqual({ vertical: true, horizontal: true });
  await page.locator(".page-organization summary").click();
  const alpha = await page
    .locator(".page-organization-menu")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(alpha).not.toContain("0.7");
  await page.screenshot({ path: `${evidenceDirectory}/wiki-icon-resize.png` });
});

test("Wiki internal links select checked pages without navigating out, and long titles wrap", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  const child = crypto.randomUUID();
  await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by,parent_id) VALUES(${child},${projectID},'linked-guide','Linked guide','Verified linked guidance.','Verified linked guidance.',${commit},${userID},${pageID})`;
  await database.client`UPDATE factory.knowledge_page SET current_body='Saved human explanation. [Read guide](#wiki/linked-guide)' WHERE id=${pageID}`;
  await openFixture(page);
  await openKnowledge(page);
  const heading = page.getByRole("button", { name: "Edit Knowledge title", exact: true });
  expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: `${evidenceDirectory}/wiki-title-wrapped.png` });
  await page.getByRole("link", { name: "Read guide", exact: true }).click();
  await expect(page.locator(".knowledge-article")).toHaveText("Verified linked guidance.");
  expect(new URL(page.url()).hash).toBe("");
});

test("keeps Ticket checklists beside their text at desktop and phone widths", async ({ page }) => {
  await addRequirement(
    "Release checklist\n\n- [ ] Keep the guide readable on a narrow screen.\n",
    1,
  );
  await openFixture(page);
  await openTicket(page);
  const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expectInlineChecklist(summary);
  }
});

test("keeps long Ticket context inside the compact composer at desktop and phone widths", async ({
  page,
}) => {
  await addRequirement("A compact description.", 1);
  await openFixture(page);
  await openTicket(page);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  for (const width of [1440, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".assistant-context-chip")).toHaveCount(0);
    const contained = await page.locator(".agent-input-shell").evaluate((composer) => {
      const bounds = composer.getBoundingClientRect();
      const input = composer.querySelector("textarea")?.getBoundingClientRect();
      return !!input && input.left >= bounds.left && input.right <= bounds.right;
    });
    expect(contained).toBe(true);
  }
});

test("keeps History open beside the wide Agent during browser capture", async ({ page }) => {
  let refreshes = 0;
  page.on("response", (response) => {
    if (
      response.url().includes("/_server/data/getTicketDetail-") &&
      response.request().method() === "POST"
    )
      refreshes++;
  });
  await addRequirement("The document stays readable beside the Agent.", 1);
  await openFixture(page);
  await openTicket(page);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(page.getByRole("complementary", { name: "Agent panel" })).toBeVisible();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  const history = page.getByRole("complementary", { name: "Specification history" });
  await expect(history).toBeVisible();
  await expect(history).toBeFocused();
  const openedAt = refreshes;
  await expect.poll(() => refreshes - openedAt, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect(history).toBeVisible();
  await expect(history).toBeFocused();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${evidenceDirectory}/spec-history-agent-stable.png` });
  await expect(history).toBeFocused();
  await expect(history).toBeVisible();
});

test("keeps advanced Ticket Markdown lossless when editing and saving a new immutable revision", async ({
  page,
}) => {
  const original = "Release matrix\n\n| Scope | Owner |\n| --- | --- |\n| Desktop | Developer |";
  await addRequirement(original, 1);
  await openFixture(page);
  await openTicket(page);
  const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
  expect(await summary.evaluate((element) => element.tagName)).toBe("DIV");
  await expect(summary.locator("table")).toContainText("Desktop");
  await summary.click();
  await summary.locator(":scope > p").last().click();
  await summary.pressSequentially("Human clarification.");
  await expect
    .poll(async () => {
      if (!database) throw new Error("Fixture database unavailable");
      const [latest] = await database.client<
        { content: string }[]
      >`SELECT canonical_content AS content FROM factory.requirement_revision WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
      return latest ? JSON.parse(latest.content).summary : "";
    })
    .toContain("Human clarification.");
  await expect(page.getByRole("button", { name: "Save revision", exact: true })).toHaveCount(0);
  if (!database) throw new Error("Fixture database unavailable");
  const rows = await database.client<
    Array<{ id: string; ordinal: number; canonicalContent: string }>
  >`
    SELECT id, ordinal, canonical_content AS "canonicalContent" FROM factory.requirement_revision
    WHERE ticket_id = ${ticketID} ORDER BY ordinal
  `;
  expect(rows.map((row) => row.ordinal)).toEqual(rows.map((_, index) => index + 1));
  const first = rows[0],
    second = rows.at(-1);
  if (!first || !second) throw new Error("Expected original and saved immutable revisions");
  expect(JSON.parse(first.canonicalContent).summary).toBe(original);
  const next = JSON.parse(second.canonicalContent).summary;
  expect(next).toContain("Human clarification.");
  expect(next).toMatch(/\| Desktop\s*\| Developer\s*\|/);
  await summary.click();
  await summary.pressSequentially("Discarded draft.");
  await summary.press("ControlOrMeta+z");
  await expect(summary).not.toContainText("Discarded draft.");
  await expect(summary.locator("table")).toContainText("Developer");
  await page.screenshot({ path: `${evidenceDirectory}/spec-markdown-fallback.png` });
});

test("keeps selection formatting inside the visible document when the link editor opens", async ({
  page,
}) => {
  test.setTimeout(20_000);
  await addRequirement("Release context is concise and useful.", 1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixture(page);
  await openTicket(page);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const summary = page.getByRole("textbox", { name: "Specification summary" });
  await summary.click();
  await summary.evaluate((element) => {
    const text = element.querySelector("p")?.firstChild;
    if (!text) throw new Error("Missing selection text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 7);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
  await toolbar.getByRole("button", { name: "Link", exact: true }).click();
  await expect(toolbar.getByRole("textbox", { name: "Link URL" })).toBeFocused();
  const bounds = await toolbar.boundingBox();
  const documentBounds = await page.locator(".ticket-workspace").boundingBox();
  if (!bounds || !documentBounds) throw new Error("Missing selection toolbar geometry");
  expect(bounds.x).toBeGreaterThanOrEqual(documentBounds.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(documentBounds.x + documentBounds.width);
  const readability = await toolbar.evaluate((element) => {
    const input = element.querySelector("input");
    if (!input) throw new Error("Missing Link input");
    return {
      toolbarBackground: getComputedStyle(element).backgroundColor,
      inputBackground: getComputedStyle(input).backgroundColor,
      inputColor: getComputedStyle(input).color,
      inputSize: Number.parseFloat(getComputedStyle(input).fontSize),
      placeholderColor: getComputedStyle(input, "::placeholder").color,
      buttonSizes: [...element.querySelectorAll("button")].map((button) =>
        Number.parseFloat(getComputedStyle(button).fontSize),
      ),
    };
  });
  const material = rgb(readability.inputBackground);
  const background = material.channels.map(
    (channel, index) =>
      channel * material.alpha +
      (rgb(readability.toolbarBackground).channels[index] ?? 0) * (1 - material.alpha),
  );
  const ratios = [readability.inputColor, readability.placeholderColor].map((color) => {
    const values = [luminance(background), luminance(rgb(color).channels)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
  await page.screenshot({ path: `${evidenceDirectory}/spec-formatting-readability.png` });
  await writeFile(
    `${evidenceDirectory}/spec-formatting-readability.json`,
    `${JSON.stringify(
      {
        ...readability,
        buttonSizes: Object.fromEntries(
          readability.buttonSizes.map((size, index) => [index, size]),
        ),
        compositedBackground: { red: background[0], green: background[1], blue: background[2] },
        contrastRatios: { input: ratios[0], placeholder: ratios[1] },
      },
      null,
      2,
    )}\n`,
  );
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  expect(readability.inputSize).toBeGreaterThanOrEqual(13);
  for (const size of readability.buttonSizes) expect(size).toBeGreaterThanOrEqual(13);
  await toolbar.getByRole("textbox", { name: "Link URL" }).fill("https://example.com/release");
  await toolbar.getByRole("button", { name: "Insert link", exact: true }).click();
  await expect(summary.locator("a")).toHaveAttribute("href", "https://example.com/release");
  await summary.press("ControlOrMeta+z");
  await expect(summary.locator("a")).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDirectory}/spec-read-agent.png` });
});

test("keeps caret-based slash blocks, immutable save and approved scope intact", async ({
  page,
}) => {
  const original = "Release context is concise and useful.";
  await addRequirement(original, 1);
  await openFixture(page);
  await openTicket(page);
  const summary = page.getByRole("textbox", { name: "Specification summary" });
  await summary.click({ position: { x: 60, y: 10 } });
  expect(
    await summary.evaluate((element) => {
      const selection = window.getSelection();
      return (
        !!selection &&
        selection.isCollapsed &&
        element.contains(selection.anchorNode) &&
        selection.anchorOffset > 0
      );
    }),
  ).toBe(true);
  await summary.press("ControlOrMeta+End");
  await summary.press("/");
  const menu = page.getByRole("menu", { name: "Specification blocks" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Acceptance criterion", exact: true }).click();
  const criterion = page.getByRole("textbox", { name: "Acceptance criterion 2" });
  await expect(criterion).toBeFocused();
  await criterion.fill("Review remains human.");
  await page.screenshot({ path: `${evidenceDirectory}/spec-edit.png` });
  await expect
    .poll(async () => {
      if (!database) throw new Error("Fixture database unavailable");
      const [row] = await database.client<Array<{ content: string }>>`
      SELECT canonical_content AS content FROM factory.requirement_revision
      WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1
    `;
      return row ? (JSON.parse(row.content).acceptanceCriteria as string[]) : [];
    })
    .toContain("Review remains human.");
  await expect(page.getByRole("button", { name: "Save revision", exact: true })).toHaveCount(0);
  if (!database) throw new Error("Fixture database unavailable");
  const rows = await database.client<
    Array<{ id: string; ordinal: number; canonicalContent: string }>
  >`
    SELECT id, ordinal, canonical_content AS "canonicalContent" FROM factory.requirement_revision
    WHERE ticket_id = ${ticketID} ORDER BY ordinal
  `;
  expect(rows.map((row) => row.ordinal)).toEqual(rows.map((_, index) => index + 1));
  expect(rows.length).toBeGreaterThanOrEqual(2);
  const first = rows[0],
    second = rows.at(-1);
  if (!first || !second) throw new Error("Expected immutable revisions");
  expect(JSON.parse(first.canonicalContent).summary).toBe(original);
  expect(JSON.parse(second.canonicalContent).acceptanceCriteria).toContain("Review remains human.");
  const approved = await requestFunction(page.request, "approveRequirementRevision", [
    ticketID,
    second.id,
  ]);
  expect(approved.ok).toBe(true);
  const detail = await serverCall(browserFunction(page, "getTicketDetail", [ticketID]));
  const approvedDocument = ticketDetailSchema
    .parse(detail)
    .documentRevisions.find((document) => document.requirementRevisionId === second.id);
  expect(approvedDocument?.approvalId).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await page.getByRole("region", { name: "requirements" }).locator(".ticket-card-body").click();
  await expect(summary).toHaveAttribute("aria-readonly", "false");
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  const history = page.getByRole("complementary", { name: "Specification history" });
  await expect(history).toContainText("Current · Implementation scope");
  await expect(history).toContainText("Earlier");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${evidenceDirectory}/spec-approved-history.png` });
});

for (const width of [1440, 900]) {
  test(`keeps native selection and expanded formatting within document edges at ${width}px`, async ({
    page,
  }) => {
    const original = Array.from(
      { length: 48 },
      (_, index) =>
        `Release context ${index + 1} is concise and useful. Keep delivery approval human.`,
    ).join("\n\n");
    await addRequirement(original, 1);
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await openTicket(page);
    if (width > 900) await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    await waitForSpecLayout(page, width);
    const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
    const viewport = page.locator(".ticket-workspace");
    for (const edge of ["top", "bottom"]) {
      const paragraph = summary.locator("p").nth(edge === "top" ? 8 : 22);
      await paragraph.scrollIntoViewIfNeeded();
      const bounds = await viewport.boundingBox();
      const textBounds = await paragraph.boundingBox();
      if (!bounds || !textBounds) throw new Error("Missing document-edge geometry");
      const targetY =
        edge === "top" ? bounds.y + 16 : bounds.y + bounds.height - textBounds.height - 16;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, textBounds.y - targetY);
      await expect
        .poll(async () => {
          const current = await paragraph.boundingBox();
          if (!current) throw new Error("Native selection paragraph disappeared");
          return Math.abs(current.y - targetY);
        })
        .toBeLessThan(2);
      const selectionBounds = await paragraph.evaluate((element) => {
        const text = element.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE)
          throw new Error("Missing native selection text");
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 7);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      const pointerY = (selectionBounds.top + selectionBounds.bottom) / 2;
      await page.mouse.move(selectionBounds.left + 0.5, pointerY);
      await page.mouse.down();
      await page.mouse.move(selectionBounds.right - 0.5, pointerY, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(() => summary.evaluate(() => window.getSelection()?.toString()))
        .toBe("Release");
      expect(
        await paragraph.evaluate((element) =>
          element.contains(window.getSelection()?.anchorNode ?? null),
        ),
      ).toBe(true);
      const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
      await expect(toolbar).toBeVisible();
      const initialToolbar = await toolbar.boundingBox();
      if (!initialToolbar) throw new Error("Missing native selection toolbar");
      expect(initialToolbar.y).toBeGreaterThanOrEqual(bounds.y);
      expect(initialToolbar.y + initialToolbar.height).toBeLessThanOrEqual(
        bounds.y + bounds.height,
      );
      expect(
        initialToolbar.y >= selectionBounds.bottom ||
          initialToolbar.y + initialToolbar.height <= selectionBounds.top,
      ).toBe(true);
      const scrollTop = await viewport.evaluate((element) => element.scrollTop);
      await toolbar.getByRole("button", { name: "Link", exact: true }).click();
      const link = toolbar.getByRole("textbox", { name: "Link URL" });
      await expect(link).toBeFocused();
      const formattingObservation = await toolbar.evaluate((element) => {
        const frame = element.closest(".ticket-editor-frame");
        const viewport = frame?.querySelector(".ticket-workspace");
        return {
          control: element.getBoundingClientRect().toJSON(),
          frame: frame?.getBoundingClientRect().toJSON(),
          viewport: viewport?.getBoundingClientRect().toJSON(),
          placement: element.getAttribute("data-placement"),
        };
      });
      await writeFile(
        `${evidenceDirectory}/spec-native-formatting-geometry-${width}-${edge}.json`,
        `${JSON.stringify({ originalViewport: bounds, formattingObservation }, null, 2)}\n`,
      );
      await expect
        .poll(async () => {
          const current = await toolbar.boundingBox();
          if (!current) return { contained: false, selectionClear: false, anchored: false };
          return {
            contained:
              current.x >= bounds.x &&
              current.x + current.width <= bounds.x + bounds.width &&
              current.y >= bounds.y &&
              current.y + current.height <= bounds.y + bounds.height,
            selectionClear:
              current.y >= selectionBounds.bottom ||
              current.y + current.height <= selectionBounds.top,
            anchored:
              Math.min(
                Math.abs(current.y - selectionBounds.bottom),
                Math.abs(current.y + current.height - selectionBounds.top),
              ) <= 9,
          };
        })
        .toEqual({ contained: true, selectionClear: true, anchored: true });
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrollTop);
      const popover = await toolbar.boundingBox();
      if (!popover) throw new Error("Missing expanded native selection toolbar");
      expect(popover.x).toBeGreaterThanOrEqual(bounds.x);
      expect(popover.x + popover.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(popover.y).toBeGreaterThanOrEqual(bounds.y);
      expect(popover.y + popover.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      expect(
        popover.y >= selectionBounds.bottom || popover.y + popover.height <= selectionBounds.top,
      ).toBe(true);
      await page.screenshot({
        path: `${evidenceDirectory}/spec-native-selection-${width}-${edge}.png`,
      });
      await link.fill("https://example.com/native-selection");
      await toolbar.getByRole("button", { name: "Insert link", exact: true }).click();
      await expect(paragraph.locator("a")).toHaveAttribute(
        "href",
        "https://example.com/native-selection",
      );
      await expect(paragraph.locator("a")).toHaveText("Release");
      await summary.press("ControlOrMeta+z");
      await expect(summary.locator("a")).toHaveCount(0);
    }
    if (!database) throw new Error("Fixture database unavailable");
    const revisions = await database.client<Array<{ canonicalContent: string }>>`
      SELECT canonical_content AS "canonicalContent" FROM factory.requirement_revision WHERE ticket_id = ${ticketID}
    `;
    expect(JSON.parse(revisions[0]?.canonicalContent ?? "{}").summary).toBe(original);
  });
}

for (const width of [1440, 900]) {
  test(`keeps expanded formatting at the dense wrapped Spec selection at ${width}px`, async ({
    page,
  }) => {
    const sentence =
      "Release context stays readable while formatting the approved delivery scope. ";
    const original = sentence.repeat(100).trim();
    expect(original.length).toBeLessThanOrEqual(10_000);
    await addRequirement(original, 1);
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await openTicket(page);
    if (width > 900) await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
    await expect(summary).toHaveText(original);
    await waitForSpecLayout(page, width);
    const viewport = page.locator(".ticket-workspace");
    const paragraph = summary.locator("p").first();
    const offset = sentence.length * 30;
    const readSelectedWord = () =>
      paragraph.evaluate((element, start) => {
        const node = element.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("Missing dense text");
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 7);
        const rectangles = [...range.getClientRects()];
        const first = rectangles[0];
        const last = rectangles.at(-1);
        if (!first || !last) throw new Error("Missing rendered word bounds");
        // A wrapped word needs a drag across both lines, not across their union box.
        return {
          left: first.left,
          right: last.right,
          top: first.top,
          bottom: last.bottom,
          startY: (first.top + first.bottom) / 2,
          endY: (last.top + last.bottom) / 2,
        };
      }, offset);
    const workspace = await viewport.boundingBox();
    if (!workspace) throw new Error("Missing dense document viewport");
    const initial = await readSelectedWord();
    await viewport.evaluate(
      (element, delta) => {
        element.scrollTop += delta;
      },
      initial.top - workspace.y - 200,
    );
    const selected = await readSelectedWord();
    await page.mouse.move(selected.left + 0.5, selected.startY);
    await page.mouse.down();
    await page.mouse.move(selected.right - 0.5, selected.endY, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => summary.evaluate(() => window.getSelection()?.toString()))
      .toBe("Release");
    const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
    await expect(toolbar).toBeVisible();
    const scrollTop = await viewport.evaluate((element) => element.scrollTop);
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const link = toolbar.getByRole("textbox", { name: "Link URL" });
    await expect(link).toBeFocused();
    const anchored = async () => {
      const box = await toolbar.boundingBox();
      const word = await readSelectedWord();
      if (!box) return false;
      return Math.min(Math.abs(box.y - word.bottom), Math.abs(box.y + box.height - word.top)) <= 9;
    };
    await page.screenshot({ path: `${evidenceDirectory}/spec-dense-formatting-${width}.png` });
    await expect.poll(anchored, { timeout: 5_000 }).toBe(true);
    await expect(toolbar).toHaveAttribute("data-placement", "floating");
    expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    const formattingBounds = await toolbar.boundingBox();
    const contentBounds = await viewport.boundingBox();
    if (!formattingBounds || !contentBounds)
      throw new Error("Missing anchored formatting geometry");
    expect(formattingBounds.y).toBeGreaterThanOrEqual(contentBounds.y);
    expect(formattingBounds.y + formattingBounds.height).toBeLessThanOrEqual(
      contentBounds.y + contentBounds.height,
    );
    if (width > 900) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(link).toBeFocused();
      await expect.poll(anchored, { timeout: 5_000 }).toBe(true);
      await page.screenshot({ path: `${evidenceDirectory}/spec-dense-formatting-1280.png` });
    }
    await link.press("Escape");
    await expect(toolbar).toBeHidden();
    await expect(page.locator(".editor-popover-shelf")).toHaveCount(0);
    await expect(summary).toBeFocused();
    await expect
      .poll(() => summary.evaluate(() => window.getSelection()?.toString()))
      .toBe("Release");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => summary.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
    // Wait for the native selection to settle before measuring the next drag.
    await expect(toolbar).toBeHidden();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const restoredWord = await readSelectedWord();
    await page.mouse.move(restoredWord.left + 0.5, restoredWord.startY);
    await page.mouse.down();
    await page.mouse.move(restoredWord.right - 0.5, restoredWord.endY, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => summary.evaluate(() => window.getSelection()?.toString()))
      .toBe("Release");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    await link.fill("https://example.com/dense-selection");
    await toolbar.getByRole("button", { name: "Insert link", exact: true }).click();
    await expect(paragraph.locator("a")).toHaveText("Release");
    await expect(paragraph.locator("a")).toHaveAttribute(
      "href",
      "https://example.com/dense-selection",
    );
    await expect(page.locator(".editor-popover-shelf")).toHaveCount(0);
    await summary.press("ControlOrMeta+z");
    await expect(summary).toHaveText(original);
    await expect(paragraph.locator("a")).toHaveCount(0);
  });
}

test("keeps saved Knowledge readable when History fails and allows an explicit retry", async ({
  page,
}) => {
  await openFixture(page);
  await openKnowledge(page);
  const restoreHistory = await mockFactoryFunctions(page, {
    knowledge: {
      async history() {
        throw new CommandError("unavailable", "Temporarily unavailable");
      },
    },
  });
  await openPageHistory(page);
  const history = page.getByRole("complementary", { name: "Knowledge history" });
  await expect(page.locator(".knowledge-version-panel").getByRole("alert")).toContainText(
    "History could not be loaded",
  );
  await expect(page.locator(".knowledge-article")).toContainText("Saved human explanation");
  await page.keyboard.press("Escape");
  await restoreHistory();
  await openPageHistory(page);
  await expect(history).toContainText("Current version");
  await expect(history.getByRole("alert")).toHaveCount(0);
});

test("explains a failed Knowledge update while retaining saved content and secondary diagnostics", async ({
  page,
}) => {
  await mockFactoryFunctions(page, {
    knowledge: {
      generation: async () =>
        knowledgeGenerationSchema.nullable().parse({
          id: crypto.randomUUID(),
          sourceCommitSha: commit,
          state: "failed",
          pageCount: 0,
          conflictCount: 0,
          failure: "Forge request failed with HTTP 404",
        }),
      generate: async () =>
        knowledgeGenerationSchema.nullable().parse({
          id: crypto.randomUUID(),
          sourceCommitSha: commit,
          state: "failed",
          pageCount: 0,
          conflictCount: 0,
          failure: "Forge request failed with HTTP 404",
        }),
    },
  });
  await openFixture(page);
  await openKnowledge(page);
  const generation = page.locator(".knowledge-generation");
  await expect(generation.getByRole("alert")).toContainText("Your saved pages are still available");
  await expect(generation.getByRole("alert")).not.toContainText("Forge request failed");
  await expect(
    generation.getByText("Forge request failed with HTTP 404", { exact: true }),
  ).toBeHidden();
  await generation.locator("summary").filter({ hasText: "Update details" }).click();
  await expect(
    generation.getByText("Forge request failed with HTTP 404", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".knowledge-article")).toContainText("Saved human explanation");
  await expect(generation.getByRole("button", { name: "Retry update" })).toBeEnabled();
  await page.screenshot({ path: `${evidenceDirectory}/knowledge-update-error.png` });
});

test("keeps Knowledge reading and editing width stable and history dismissible without hiding current content", async ({
  page,
}) => {
  await openFixture(page);
  await openKnowledge(page);
  for (const width of [1440, 1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const rootSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const targetWindowWidth =
      width <= 900 ? width - 1.3 * rootSize : Math.min(72 * rootSize, width - 5 * rootSize);
    await expect
      .poll(async () => {
        const bounds = await page.locator(".workspace-window").boundingBox();
        return bounds ? Math.abs(bounds.width - targetWindowWidth) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(1);
    const reading = await page.locator(".knowledge-article").boundingBox();
    const readingTitle = await page.locator(".knowledge-heading h2").boundingBox();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${evidenceDirectory}/knowledge-read-${width}.png` });
    await page.getByRole("button", { name: "Edit Knowledge title", exact: true }).click();
    const editing = await page.getByRole("textbox", { name: "Knowledge body" }).boundingBox();
    const titleField = page.getByRole("textbox", { name: "Knowledge page title" });
    const editingTitle = await titleField.boundingBox();
    if (!reading || !editing) throw new Error("Missing document geometry");
    if (!readingTitle || !editingTitle) throw new Error("Missing title geometry");
    expect(Math.abs(readingTitle.height - editingTitle.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(reading.x - editing.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(reading.width - editing.width)).toBeLessThanOrEqual(1);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${evidenceDirectory}/knowledge-edit-${width}.png` });
    await titleField.fill(`${title} ${title}`);
    expect(
      await titleField.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeLessThanOrEqual(1);
    await titleField.press("Enter");
    await expect(titleField).toHaveValue(`${title} ${title}`);
    await titleField.fill(title);
    await readWiki(page);
    await expect(page.locator(".knowledge-heading h2")).toHaveText(title);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const opener = page.getByRole("button", { name: "Page options", exact: true });
  await openPageHistory(page);
  const history = page.getByRole("complementary", { name: "Knowledge history" });
  await expect(history).toContainText("Current");
  await history.getByRole("button").nth(1).click();
  await expect(page.locator(".historical-document").getByLabel("Historical page")).toBeVisible();
  await page.screenshot({ path: `${evidenceDirectory}/knowledge-history.png` });
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(opener).toBeFocused();
  await openPageHistory(page);
  await expect(history).toBeVisible();
  await history.getByRole("button", { name: "Close history" }).click();
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sources", exact: true }).click();
  await expect(page.locator(".knowledge-menu-sources")).toContainText("README.md");
  await page.screenshot({ path: `${evidenceDirectory}/knowledge-read-sources.png` });
});

test("saves a wrapping Knowledge title as a new immutable revision", async ({ page }) => {
  if (!database) throw new Error("Fixture database unavailable");
  const original = await database.client<{ id: string; title: string; body: string }[]>`
    SELECT id, title, body FROM factory.knowledge_revision
    WHERE page_id = ${pageID} ORDER BY ordinal
  `;
  await openFixture(page);
  await openKnowledge(page);
  await page.getByRole("button", { name: "Edit Knowledge title", exact: true }).click();
  const newTitle = `${title} with a reviewed release note`;
  await page.getByRole("textbox", { name: "Knowledge page title" }).fill(newTitle);
  await expect
    .poll(async () => {
      if (!database) throw new Error("No database");
      const [row] = await database.client<
        Array<{ title: string }>
      >`SELECT title FROM factory.knowledge_page WHERE id=${pageID}`;
      return row?.title;
    })
    .toBe(newTitle);
  await readWiki(page);
  await expect(page.locator(".knowledge-heading h2")).toHaveText(newTitle);
  const revisions = await database.client<{ id: string; title: string; body: string }[]>`
    SELECT id, title, body FROM factory.knowledge_revision
    WHERE page_id = ${pageID} ORDER BY ordinal
  `;
  expect(revisions).toHaveLength(original.length + 1);
  expect(revisions.slice(0, original.length)).toEqual(original);
  expect(revisions.at(-1)?.title).toBe(newTitle);
});
