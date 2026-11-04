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

test("a ready Ticket without criteria explains why Implement is unavailable", async ({ page }) => {
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
  await page
    .getByRole("textbox", { name: "Acceptance criterion 1", exact: true })
    .fill("The total is exact.");
  await expect(implement).toBeEnabled();
});

test("Ideas offer only blocks that exist", async ({ page }) => {
  await insertTicket("Plain idea", "", "inbox");
  await openTicket(page, "Plain idea");
  await page.getByRole("textbox", { name: "Ticket description", exact: true }).click();
  await page.keyboard.type("/");
  const menu = page.getByRole("menu", { name: "Specification blocks" });
  await expect(menu.getByRole("menuitem", { name: "Table" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Acceptance criterion" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Non-goal" })).toHaveCount(0);
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
