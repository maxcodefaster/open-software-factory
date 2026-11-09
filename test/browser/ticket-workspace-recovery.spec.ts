import { expect, type Page } from "@playwright/test";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserBootstrap, mockFactoryFunctions } from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

let database: ReturnType<typeof createDatabase>;
let projectID: string;
let userID: string;
let slug: string;
test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  userID = session.user.id;
  database = createDatabase(2);
  projectID = crypto.randomUUID();
  slug = `ticket-recovery-${projectID.slice(0, 8)}`;
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${slug},'Ticket recovery','https://example.invalid/recovery.git','main','.devcontainer/devcontainer.json',${userID})`;
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "This document fixture starts no runtime");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "This document fixture starts no runtime");
      },
    },
  });
});
test.afterEach(async () => {
  if (projectID) await deleteFactoryProject(projectID, database);
  if (database) await database.client.end({ timeout: 0 });
  projectID = "";
});

async function insertTicket(title: string, description: string, state = "inbox") {
  const id = crypto.randomUUID();
  await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
    VALUES(${id},${projectID},${title},${description},${state}::factory.ticket_state,${userID})`;
  return id;
}

async function openTicket(page: Page, title: string) {
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page.locator(".ticket-card-body").filter({ hasText: title }).first().click();
  await expect(page.getByRole("article", { name: "Ticket document", exact: true })).toBeVisible();
}

async function retainStaleDraft(page: Page, id: string, title: string) {
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [
      `ticket-edit:${userID}:${id}`,
      JSON.stringify({
        title,
        description: "My retained wording",
        expectedVersion: 1,
        expectedDocumentId: null,
        requirementRevisionId: null,
        requirement: { summary: "My retained wording", acceptanceCriteria: [""], nonGoals: [""] },
      }),
    ],
  );
}

const wide = [
  "| Spalte A | Spalte B | Spalte C | Spalte D | Spalte E | Spalte F | Spalte G |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| Überprüfung | Größenänderung | Änderungsprotokoll | Zusammenfassung | Verantwortlichkeit | Abhängigkeiten | Rückmeldung |",
  "",
  "```ts",
  `export const line = "${"a very long source line ".repeat(8)}";`,
  "```",
  "",
  "[a-very-long-reference-name-that-keeps-going-and-going-without-any-break-at-all.txt](https://example.com/files/a-very-long-reference-name-that-keeps-going-and-going-without-any-break-at-all.txt)",
].join("\n");

test("wide tables, long code and long links stay inside a phone-sized document", async ({
  page,
}) => {
  await insertTicket("Wide document", wide);
  await openTicket(page, "Wide document");
  await page.setViewportSize({ width: 390, height: 844 });
  const table = page.locator(".ticket-requirements .tableWrapper").first();
  await expect(table).toBeVisible();
  // Keyboard users reach a table that scrolls sideways.
  await expect(table).toHaveAttribute("tabindex", "0");
  const overflow = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".ticket-workspace");
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workspace: workspace ? workspace.scrollWidth - workspace.clientWidth : 0,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.workspace).toBeLessThanOrEqual(1);
  // Cell text breaks between words, not inside them.
  await expect(page.locator(".ticket-requirements th").first()).toHaveText("Spalte A");
  const header = await page.locator(".ticket-requirements th").first().boundingBox();
  expect(header?.height ?? 0).toBeLessThan(80);
});

test("code block controls sit above the code instead of covering it", async ({ page }) => {
  await insertTicket("Code controls", "```ts\nconst short = 1;\n```");
  await openTicket(page, "Code controls");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".ticket-requirements pre code").click();
  const controls = page.getByRole("toolbar", { name: "Document block controls" });
  await expect(controls).toBeVisible();
  const code = await page.locator(".ticket-requirements pre").boundingBox();
  const bar = await controls.boundingBox();
  if (!code || !bar) throw new Error("Code block or its controls are not laid out");
  expect(bar.y + bar.height).toBeLessThanOrEqual(code.y + 1);
  // The code stays clickable on a touch-sized layout.
  await page.locator(".ticket-requirements pre code").click();
});

test("the New ticket title wraps and refuses line breaks", async ({ page }) => {
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Ticket title", exact: true });
  await title.fill("Sehr langer Entwurfstitel mit Umlauten äöüß ".repeat(5).trim());
  const box = await title.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(60);
  expect(await title.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(
    true,
  );
  await title.press("Enter");
  expect(await title.inputValue()).not.toContain("\n");
  await title.fill("Eine Zeile\nzwei Zeilen");
  await expect(title).toHaveValue("Eine Zeile zwei Zeilen");
});

test("a draft saved against an older version offers to keep or discard it", async ({ page }) => {
  const id = await insertTicket("Moved on elsewhere", "Server text", "inbox");
  await database.client`UPDATE factory.ticket SET version=version+3 WHERE id=${id}`;
  await retainStaleDraft(page, id, "Moved on elsewhere");
  await openTicket(page, "Moved on elsewhere");
  const recovery = page.getByRole("alert").filter({ hasText: "changed after you started editing" });
  await expect(recovery).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard my changes" })).toBeVisible();
  // Discarding restores the saved wording and clears the error.
  await page.getByRole("button", { name: "Discard my changes" }).click();
  await expect(recovery).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Ticket description", exact: true })).toHaveText(
    "Server text",
  );
});

test("typing into a stale draft keeps the recovery in view above the document", async ({
  page,
}) => {
  const id = await insertTicket("Stale and still typing", "Server text", "inbox");
  await database.client`UPDATE factory.ticket SET version=version+3 WHERE id=${id}`;
  await retainStaleDraft(page, id, "Stale and still typing");
  await openTicket(page, "Stale and still typing");
  const recovery = page.getByRole("alert").filter({ hasText: "changed after you started editing" });
  await expect(recovery).toBeVisible();
  const description = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await description.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and more words");
  await page.waitForTimeout(1500);
  await expect(recovery).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save my version as a new revision" }),
  ).toBeVisible();
  const [recoveryBox, descriptionBox] = await Promise.all([
    recovery.boundingBox(),
    description.boundingBox(),
  ]);
  if (!recoveryBox || !descriptionBox) throw new Error("Recovery or description is not laid out");
  expect(recoveryBox.y).toBeLessThan(descriptionBox.y);
});

test("choosing a second file while one uploads says so instead of doing nothing", async ({
  page,
}) => {
  await insertTicket("Busy uploads", "Server text", "inbox");
  await openTicket(page, "Busy uploads");
  const description = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await description.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/file");
  const first = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  const release = Promise.withResolvers<void>();
  await page.route("**/_server/**", async (route) => {
    if (route.request().method() === "POST") await release.promise;
    await route.continue();
  });
  try {
    await (await first).setFiles({
      name: "first.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("first"),
    });
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/file");
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("A file is still uploading. Add the next file when it finishes."),
    ).toBeVisible();
  } finally {
    release.resolve();
  }
  await expect(
    page.getByText("A file is still uploading. Add the next file when it finishes."),
  ).toHaveCount(0, { timeout: 20_000 });
});

test("keeping a stale draft saves it as a new revision on top of the newer version", async ({
  page,
}) => {
  const id = await insertTicket("Keep my wording", "Server text", "inbox");
  await database.client`UPDATE factory.ticket SET version=version+2 WHERE id=${id}`;
  await retainStaleDraft(page, id, "Keep my wording");
  await openTicket(page, "Keep my wording");
  await page.getByRole("button", { name: "Save my version as a new revision" }).click();
  await expect
    .poll(async () => {
      const [row] = await database.client<{ description: string }[]>`
        SELECT description FROM factory.ticket WHERE id=${id}`;
      return row?.description;
    })
    .toBe("My retained wording");
  await expect(page.getByRole("alert").filter({ hasText: "changed after" })).toHaveCount(0);
});

test("a refused design save names its reason beside the draft", async ({ page }) => {
  const id = await insertTicket("Design with a reason", "Summary", "ready");
  const requirement = JSON.stringify({
    acceptanceCriteria: ["First criterion", "Second criterion"],
    nonGoals: [],
    summary: "Summary",
  });
  const design = JSON.stringify({
    context: "Current system.",
    proposedChanges: "Proposed change.",
    decisions: [],
    assumptions: [],
    risks: [],
    validation: [{ criterion: 1, check: "Check the first criterion." }],
    diagrams: [],
  });
  const revisionID = crypto.randomUUID();
  await database.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
    VALUES(${revisionID},${id},1,${requirement},encode(digest(convert_to(${requirement}::text,'UTF8'),'sha256'),'hex'),${userID})`;
  await database.client`INSERT INTO factory.technical_design_revision(id,ticket_id,requirement_revision_id,ordinal,source_commit,canonical_content,content_digest,citations,diagram_renders,renderer_version,created_by,author_kind)
    VALUES(${crypto.randomUUID()},${id},${revisionID},1,${"a".repeat(40)},${design},encode(digest(convert_to(${design}::text,'UTF8'),'sha256'),'hex'),'[]'::jsonb,'[]'::jsonb,'test',${userID},'ai')`;
  await mockFactoryFunctions(page, {
    tickets: {
      async saveTechnicalDesign() {
        throw new CommandError(
          "invalid",
          "Map every product acceptance criterion to a concrete validation check.",
        );
      },
    },
  });
  await openTicket(page, "Design with a reason");
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await page.getByRole("button", { name: "Save design", exact: true }).click();
  await expect(
    page
      .locator("#ticket-technical")
      .getByText("Map every product acceptance criterion to a concrete validation check."),
  ).toBeVisible();
});

test("a ready Ticket without criteria explains why Implement is unavailable", async ({
  page,
}, testInfo) => {
  await insertTicket("Needs criteria", "Summary only", "ready");
  await openTicket(page, "Needs criteria");
  const implement = page.getByRole("button", { name: "Implement", exact: true });
  await expect(implement).toBeDisabled();
  await expect(implement).toHaveAccessibleDescription(
    "Add a summary and at least one acceptance criterion to enable Implement.",
  );
  await expect(page.getByRole("status", { name: "Ticket progress" })).toHaveText(
    "Add a summary and at least one acceptance criterion to enable Implement.",
  );
  await page.screenshot({ path: testInfo.outputPath("implement-reason.png") });
  await page
    .getByRole("textbox", { name: "Acceptance criterion 1", exact: true })
    .fill("The total is exact.");
  await expect(implement).toBeEnabled();
});

test("Ideas insert requirement blocks into the directly editable specification", async ({
  page,
}) => {
  await insertTicket("Plain idea", "", "inbox");
  await openTicket(page, "Plain idea");
  await page.getByRole("textbox", { name: "Ticket description", exact: true }).click();
  await page.keyboard.type("/");
  const menu = page.getByRole("menu", { name: "Specification blocks" });
  await expect(menu.getByRole("menuitem", { name: "Table" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Non-goal" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Acceptance criterion" }).click();
  await expect(
    page.getByRole("textbox", { name: "Acceptance criterion 2", exact: true }),
  ).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.getByRole("textbox", { name: "Ticket description", exact: true }).click();
  await page.keyboard.type("/");
  await menu.getByRole("menuitem", { name: "Non-goal" }).click();
  await expect(page.getByRole("textbox", { name: "Non-goal 2", exact: true })).toBeFocused();
  await expect(menu).toHaveCount(0);
});

test("a cancelled Ticket offers no clarification", async ({ page }) => {
  const id = await insertTicket("Stopped work", "Cancelled text", "cancelled");
  await page.goto(`/projects/${projectID}/tickets/${id}`);
  await expect(page.getByRole("article", { name: "Ticket document", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask AI to clarify", exact: true })).toHaveCount(0);
});

test("the Ticket document keeps a continuous heading hierarchy", async ({ page }) => {
  await insertTicket("Headings", "Summary", "ready");
  await openTicket(page, "Headings");
  await page
    .getByRole("textbox", { name: "Acceptance criterion 1", exact: true })
    .fill("The heading levels never skip.");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Product", exact: true, level: 2 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Acceptance criteria", exact: true, level: 3 }),
  ).toBeVisible();
  // axe's heading-order rule: within the document, a level may rise by one at most.
  const levels = await page
    .getByRole("article", { name: "Ticket document", exact: true })
    .locator("h1, h2, h3, h4, h5, h6")
    .evaluateAll((headings) =>
      headings
        .filter((heading) => (heading as HTMLElement).offsetParent !== null)
        .map((heading) => Number(heading.tagName.slice(1))),
    );
  expect(levels.length).toBeGreaterThan(1);
  expect(levels[0]).toBe(2);
  for (let index = 1; index < levels.length; index++)
    expect(levels[index] ?? 0).toBeLessThanOrEqual((levels[index - 1] ?? 0) + 1);
});

test("the mention picker drops its active option when no member matches", async ({ page }) => {
  await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
    VALUES(${projectID},${userID},'developer',true,${userID}) ON CONFLICT DO NOTHING`;
  await insertTicket("Mentions", "Summary", "inbox");
  await openTicket(page, "Mentions");
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Message conversation", exact: true });
  await composer.fill("Hallo @");
  await expect(page.getByRole("listbox", { name: "Mention a Project member" })).toBeVisible();
  await expect(page.getByRole("option")).not.toHaveCount(0);
  await expect(composer).toHaveAttribute("aria-activedescendant", /mention-options-.+-0/);
  await composer.pressSequentially("zzzz");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(composer).not.toHaveAttribute("aria-activedescendant", /.+/);
});

test("typing a list marker in a later list item nests a list instead of keeping literal text", async ({
  page,
}) => {
  await insertTicket("Nested list", "", "inbox");
  await openTicket(page, "Nested list");
  const description = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await description.click();
  await page.keyboard.type("- eins\n- zwei");
  await expect(description.locator("ul ul li")).toHaveText("zwei");
  await expect(description).not.toContainText("- zwei");
  await expect
    .poll(async () => {
      const [row] = await database.client<{ description: string }[]>`
        SELECT description FROM factory.ticket WHERE title='Nested list' AND project_id=${projectID}`;
      return row?.description;
    })
    .not.toContain("- - ");
});

test("the empty New ticket title is one line tall", async ({ page }) => {
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  const box = await page.getByRole("textbox", { name: "Ticket title", exact: true }).boundingBox();
  expect(box?.height ?? 0).toBeLessThan(60);
});

test("the Ticket actions menu lives inside a landmark", async ({ page }) => {
  await insertTicket("Menu landmark", "Summary", "inbox");
  await openTicket(page, "Menu landmark");
  await page.getByRole("button", { name: "Ticket actions", exact: true }).first().click();
  const menu = page.getByRole("menu", { name: "Ticket actions" });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => Boolean(element.closest("section[aria-label]")))).toBe(
    true,
  );
});
