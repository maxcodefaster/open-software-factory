import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { signIn, deleteFactoryProject } from "../support/factory-fixture";

const userID = "01994a7d-0000-7000-8000-000000000001";
const captures = ".factory/screenshots/ticket-requirements-journey";
let db: ReturnType<typeof createDatabase>;
let projectID: string;
let slug: string;
test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 960 } });
test.beforeEach(async ({ page }) => {
  db = createDatabase(2);
  projectID = crypto.randomUUID();
  slug = `journey-${projectID.slice(0, 8)}`;
  await mkdir(captures, { recursive: true });
  await db.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES (${projectID},${slug},'Requirements journey','https://example.invalid/journey.git','main','.devcontainer/devcontainer.json',${userID})`;
  // This browser journey exercises planning only, never creates compute for the fake repository.
  await page.route(`**/api/projects/${projectID}/source-workspace/ensure`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "No development runtime in this planning fixture" },
    }),
  );
  await page.route(`**/api/projects/${projectID}/developer-ide/ensure`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "No development runtime in this planning fixture" },
    }),
  );
  await signIn(page);
  await selectProject(page);
});
test.afterEach(async () => {
  await deleteFactoryProject(projectID);
  await db.client.end({ timeout: 3 });
});
async function selectProject(page: Page) {
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await page.getByRole("button", { name: "Open project menu" }).click();
  await page.getByRole("button").filter({ hasText: slug }).click();
}
async function draft(page: Page, title: string, description: string) {
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Ticket description", exact: true }).fill(description);
}
test("personal rich draft survives close/reload; shared Idea edits autosave coherently", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await draft(
    page,
    "Remember this idea",
    "A product contributor can capture a useful idea without involving AI.",
  );
  await expect(page.getByRole("dialog", { name: "New ticket" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Work type" })).toHaveCount(0);
  expect(
    (await db.client`SELECT id FROM factory.ticket WHERE project_id=${projectID}`).length,
  ).toBe(0);
  await expect
    .poll(async () =>
      page.locator(".workspace-window").evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        );
        return true;
      }),
    )
    .toBe(true);
  const draftBounds = await page.locator(".ticket-draft-workspace").boundingBox();
  const bodyBounds = await page.locator(".workspace-view-body").boundingBox();
  const frameBounds = await page
    .locator(".ticket-draft-workspace .ticket-editor-frame")
    .boundingBox();
  if (!draftBounds || !bodyBounds || !frameBounds) throw new Error("Missing draft geometry");
  expect(draftBounds.width).toBeCloseTo(bodyBounds.width, 0);
  expect(frameBounds.height).toBeCloseTo(draftBounds.height, 0);
  const draftEditor = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await draftEditor.press("ControlOrMeta+A");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("capture a useful idea");
  const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
  await expect(toolbar).toBeVisible();
  const toolbarBounds = await toolbar.boundingBox();
  if (!toolbarBounds) throw new Error("Missing selection toolbar geometry");
  expect(toolbarBounds.x).toBeGreaterThanOrEqual(frameBounds.x);
  expect(toolbarBounds.x + toolbarBounds.width).toBeLessThanOrEqual(
    frameBounds.x + frameBounds.width,
  );
  await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(draftEditor.locator("strong")).toContainText("capture a useful idea");
  await page.screenshot({ path: `${captures}/draft-desktop.png` });
  await page.setViewportSize({ width: 780, height: 900 });
  await page.locator(".workspace-window").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  await draftEditor.press("End");
  await draftEditor.pressSequentially(" /ta");
  const draftMenu = page.getByRole("menu", { name: "Specification blocks" });
  await expect(draftMenu.getByRole("menuitem")).toHaveCount(1);
  await expect(draftMenu.getByRole("menuitem", { name: "Table", exact: true })).toBeVisible();
  const menuBounds = await draftMenu.boundingBox();
  const cursorBounds = await page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { x: rect.x, y: rect.y, height: rect.height };
  });
  if (!menuBounds || !cursorBounds) throw new Error("Missing caret menu geometry");
  expect(Math.abs(menuBounds.x - cursorBounds.x)).toBeLessThan(32);
  expect(menuBounds.y).toBeGreaterThanOrEqual(cursorBounds.y + cursorBounds.height);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(780);
  await page.screenshot({ path: `${captures}/draft-menu-narrow.png` });
  await draftEditor.press("Escape");
  await draftEditor.press("Backspace");
  await draftEditor.press("Backspace");
  await draftEditor.press("Backspace");
  await draftEditor.press("Backspace");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Close Remember this idea", exact: true }).click();
  await page.reload();
  await selectProject(page);
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveValue(
    "Remember this idea",
  );
  await expect(
    page.getByRole("textbox", { name: "Ticket description", exact: true }),
  ).toContainText("capture a useful idea");
  await page.getByRole("button", { name: "Create as idea", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Remember this idea",
  );
  const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await editor.fill("Human edited intent with a **clear** outcome.");
  await expect
    .poll(async () => {
      const [ticket] = await db.client<
        Array<{ description: string }>
      >`SELECT description FROM factory.ticket WHERE project_id=${projectID}`;
      return ticket?.description;
    })
    .toContain("Human edited intent");
  expect(
    (await db.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`).length,
  ).toBe(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await editor.press("End");
  await editor.pressSequentially(" /ta");
  const menu = page.getByRole("menu", { name: "Specification blocks" });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Table", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Table", exact: true }).click();
  await expect(editor.locator("table")).toHaveCount(1);
  await page.screenshot({ path: `${captures}/idea-editor-desktop.png` });
  await page.setViewportSize({ width: 780, height: 900 });
  await page.screenshot({ path: `${captures}/idea-editor-narrow.png` });
  expect(errors).toEqual([]);
});

test("Ticket keystrokes and undo survive delayed autosave acknowledgement and reload", async ({
  page,
}) => {
  await draft(page, "Delayed editor probe", "Initial human intent.");
  await page.getByRole("button", { name: "Create as idea", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Delayed editor probe",
  );
  const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
  const [ticket] = await db.client<Array<{ id: string }>>`
    SELECT id FROM factory.ticket WHERE project_id=${projectID}
  `;
  if (!ticket) throw new Error("Missing owned Ticket");
  let saved = false;
  const release = Promise.withResolvers<void>();
  let first = true;
  await page.route(`**/api/tickets/${ticket.id}/document`, async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch({ timeout: 10_000 });
    saved = true;
    await Promise.race([release.promise, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    await route.fulfill({ response });
  });
  try {
    await editor.press("ControlOrMeta+End");
    await editor.pressSequentially(" First saved phrase.");
    await expect.poll(() => saved, { timeout: 10_000 }).toBe(true);
    await editor.pressSequentially(" Second phrase is still being typed.");
    await expect(editor).toContainText("Second phrase is still being typed.");
    await page.waitForTimeout(600);
    await editor.press("Backspace");
    await editor.press("ControlOrMeta+Z");
    await expect(editor).toContainText("Second phrase is still being typed.");
    release.resolve();
    await expect
      .poll(async () => {
        const [row] = await db.client<Array<{ description: string }>>`
        SELECT description FROM factory.ticket WHERE id=${ticket.id}
      `;
        return row?.description;
      })
      .toContain("Second phrase is still being typed.");
    await editor.press("ControlOrMeta+A");
    await editor.pressSequentially("Replacement human intent.");
    await expect
      .poll(async () => {
        const [row] = await db.client<Array<{ description: string }>>`
        SELECT description FROM factory.ticket WHERE id=${ticket.id}
      `;
        return row?.description;
      })
      .toBe("Replacement human intent.");
    await page.reload();
    await selectProject(page);
    await page.getByRole("button", { name: /Delayed editor probe$/ }).click();
    await expect(editor).toHaveText("Replacement human intent.");
  } finally {
    release.resolve();
  }
});

test("continued focused Ticket typing stays recoverable after a completed autosave", async ({
  page,
}) => {
  await draft(page, "Continued focused editing", "Initial human intent.");
  await page.getByRole("button", { name: "Create as idea", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Continued focused editing",
  );
  const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await editor.fill("Saved first phrase.");
  await expect
    .poll(async () => {
      const [row] = await db.client<Array<{ description: string }>>`
      SELECT description FROM factory.ticket WHERE project_id=${projectID}
    `;
      return row?.description;
    })
    .toBe("Saved first phrase.");
  await expect(page.locator(".ticket-editor-actions")).toHaveCount(0);
  await editor.press("End");
  await editor.pressSequentially("X");
  await expect(editor).toContainText("Saved first phrase.X");
  const [ticket] = await db.client<Array<{ id: string }>>`
    SELECT id FROM factory.ticket WHERE project_id=${projectID}
  `;
  if (!ticket) throw new Error("Missing owned Ticket");
  const retained = await page.evaluate((id) => {
    const key = Object.keys(localStorage).find(
      (key) => key.startsWith("ticket-edit:") && key.endsWith(`:${id}`),
    );
    return JSON.parse(key ? (localStorage.getItem(key) ?? "null") : "null") as {
      description: string;
    } | null;
  }, ticket.id);
  expect(retained?.description).toBe("Saved first phrase.X");
  await page.getByRole("button", { name: "Close Continued focused editing", exact: true }).click();
  await page.getByRole("button", { name: /Continued focused editing$/ }).click();
  await expect(editor).toHaveText("Saved first phrase.X");
  await page.reload();
  await selectProject(page);
  await page.getByRole("button", { name: /Continued focused editing$/ }).click();
  await expect(editor).toHaveText("Saved first phrase.X");
});

test("failed creation retains the personal rich draft and an explicit retry publishes once", async ({
  page,
}) => {
  await draft(page, "Retained after failure", "Human context must survive a failed create.");
  const local = (await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    `ticket-draft:${userID}:${projectID}`,
  )) as { id: string };
  await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${local.id},${projectID},'Conflicting command','inbox',${userID})`;
  await page.getByRole("button", { name: "Create as idea", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your draft is retained" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveValue(
    "Retained after failure",
  );
  await expect(
    page.getByRole("textbox", { name: "Ticket description", exact: true }),
  ).toContainText("Human context must survive");
  expect(
    (await db.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`).length,
  ).toBe(0);
  await db.client`DELETE FROM factory.ticket WHERE id=${local.id}`;
  await page.getByRole("button", { name: "Create as idea", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Retained after failure",
  );
  expect(
    (await db.client`SELECT id FROM factory.ticket WHERE project_id=${projectID}`).length,
  ).toBe(1);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), `ticket-draft:${userID}:${projectID}`),
  ).toBeNull();
});

test("a proposal arriving after human editing cannot replace the saved document", async ({
  page,
}) => {
  const ticketID = crypto.randomUUID(),
    conversationID = crypto.randomUUID(),
    proposalID = crypto.randomUUID();
  await db.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
    VALUES(${ticketID},${projectID},'Safe human intent','Original intent','ready',${userID})`;
  await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
    VALUES(${conversationID},${projectID},${ticketID},'plan',${userID})`;
  await page.locator(".ticket-card-body").filter({ hasText: "Safe human intent" }).click();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ticket description", exact: true })
    .fill("New human decision that must survive.");
  await expect
    .poll(
      async () =>
        (await db.client`SELECT description FROM factory.ticket WHERE id=${ticketID}`)[0]?.[
          "description"
        ],
    )
    .toBe("New human decision that must survive.");
  await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
    VALUES(${proposalID},${conversationID},1,'requirement','project-agent','plan','A proposed Ticket.',${JSON.stringify(
      {
        ticketId: ticketID,
        ticket: { title: "Old AI proposal", description: "Outdated proposal" },
        requirement: {
          summary: "Outdated scope",
          acceptanceCriteria: ["Old outcome"],
          nonGoals: [],
        },
        base: { id: ticketID, version: 1, documentId: null, revisionId: null },
      },
    )}::jsonb)`;
  await expect(page.getByRole("article", { name: "Elaborated requirements" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm answers", exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      "The Ticket changed. Your current text is kept; clarify again for a new proposal.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Ticket", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Ticket description", exact: true }),
  ).toContainText("New human decision that must survive.");
});

test("Project proposals enter a personal rich draft without publishing or replacing retained work", async ({
  page,
}) => {
  const conversationID = crypto.randomUUID(),
    entryID = crypto.randomUUID();
  await db.client`INSERT INTO factory.ticket_conversation(id,project_id,mode,created_by) VALUES(${conversationID},${projectID},'plan',${userID})`;
  await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
    VALUES(${entryID},${conversationID},1,'requirement','project-agent','plan','A useful proposed Ticket.',${JSON.stringify(
      {
        ticketId: null,
        base: null,
        ticket: { title: "Proposed private draft", description: "A useful outcome" },
        requirement: {
          summary: "Capture this intent",
          acceptanceCriteria: ["Observable outcome"],
          nonGoals: [],
        },
      },
    )}::jsonb)`;
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveValue(
    "Proposed private draft",
  );
  await expect(
    page.getByRole("textbox", { name: "Ticket description", exact: true }),
  ).toContainText("Observable outcome");
  expect(
    (await db.client`SELECT id FROM factory.ticket WHERE project_id=${projectID}`).length,
  ).toBe(0);
  await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill("My retained draft");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveValue(
    "My retained draft",
  );
});

test("real Luna elaborates detailed intent; confirmation preserves scope and manual edits remain editable", async ({
  page,
}) => {
  const title = "Keep ticket drafts across reload";
  await draft(
    page,
    title,
    "Product contributors need to capture an idea privately and resume later. A new ticket tab should preserve its title and rich description locally per signed-in user and project across closing the tab and reloading. It is not shared or sent to AI until explicitly created. On creation publish one shared ticket and remove the local draft. On failed creation retain it and show a readable retry message. Acceptance: closing and reopening restores the draft; reloading restores it; creating as an idea publishes once without an AI call; failures do not lose text. No server-side draft synchronization or cross-device support is requested. These decisions are settled, propose the complete ticket without further questions.",
  );
  await page.getByRole("button", { name: "Elaborate requirements", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Agent panel" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Elaborated requirements" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.locator(".acceptance-item")).not.toHaveCount(0);
  const [ticket] = await db.client<
    Array<{ id: string; title: string }>
  >`SELECT id,title FROM factory.ticket WHERE project_id=${projectID}`;
  if (!ticket) throw new Error("Missing Ticket");
  expect(ticket.title).toBe(title);
  const [turn] = await db.client<
    Array<{ model: string }>
  >`SELECT authority->>'modelId' AS model FROM factory.agent_turn WHERE ticket_id=${ticket.id}`;
  expect(turn?.model).toBe("gpt-6-luna");
  await page.screenshot({ path: `${captures}/proposal-desktop.png` });
  await expect(page.getByRole("complementary", { name: "Agent panel" })).toBeHidden();
  await page
    .getByRole("textbox", { name: "Ticket description", exact: true })
    .fill("Human-edited proposal: retain private intent until publication.");
  await page.getByRole("button", { name: "Confirm answers", exact: true }).click();
  await expect(page.getByRole("article", { name: "Elaborated requirements" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeVisible();
  const [state] = await db.client<
    Array<{ state: string; count: number; approvals: number; changes: number }>
  >`SELECT state,
    (SELECT count(*)::int FROM factory.ticket_document_revision WHERE ticket_id=${ticket.id}) AS count,
    (SELECT count(*)::int FROM factory.requirement_approval WHERE ticket_id=${ticket.id}) AS approvals,
    (SELECT count(*)::int FROM factory.change WHERE ticket_id=${ticket.id}) AS changes FROM factory.ticket WHERE id=${ticket.id}`;
  expect(state).toEqual({ state: "ready", count: 1, approvals: 0, changes: 0 });
  expect(
    (await db.client`SELECT description FROM factory.ticket WHERE id=${ticket.id}`)[0]?.[
      "description"
    ],
  ).toBe("Human-edited proposal: retain private intent until publication.");
  await page
    .getByRole("textbox", { name: "Ticket description", exact: true })
    .fill("Human refinement: private drafts stay local to this browser.");
  await expect
    .poll(async () => {
      const [row] = await db.client<
        Array<{ description: string }>
      >`SELECT description FROM factory.ticket WHERE id=${ticket.id}`;
      return row?.description;
    })
    .toBe("Human refinement: private drafts stay local to this browser.");
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  await expect(page.locator(".version-history")).toContainText("AI");
  await page.screenshot({ path: `${captures}/confirmed-history-desktop.png` });
  await page.setViewportSize({ width: 780, height: 900 });
  await expect(page.getByRole("complementary", { name: "Agent panel" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toBeVisible();
  await page.screenshot({ path: `${captures}/confirmed-narrow.png` });
});

test("editable Epic preview keeps focus, restores drafts and confirms every member once", async ({
  page,
}) => {
  const originID = crypto.randomUUID(),
    conversationID = crypto.randomUUID(),
    entryID = crypto.randomUUID();
  const requirement = {
    summary: "Useful outcome",
    acceptanceCriteria: ["Observable result"],
    nonGoals: [],
  };
  const proposal = {
    epic: { title: "Invoice workflow", description: "Improve invoicing" },
    members: [
      {
        key: "export",
        title: "Export invoices",
        description: "Download invoice data",
        existingTicketId: null,
        expectedVersion: null,
        requirement,
        dependsOn: [],
      },
      {
        key: "summary",
        title: "Summarize invoices",
        description: "Understand totals",
        existingTicketId: null,
        expectedVersion: null,
        requirement,
        dependsOn: ["export"],
      },
    ],
  };
  await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${originID},${projectID},'Invoice intent','ready',${userID})`;
  await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by) VALUES(${conversationID},${projectID},${originID},'plan',${userID})`;
  await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload) VALUES(${entryID},${conversationID},1,'requirement','project-agent','plan','Review two outcomes',${JSON.stringify({ epicProposal: proposal, base: { id: originID, version: 1, documentId: null, revisionId: null } })}::jsonb)`;
  await page.locator(".ticket-card-body").filter({ hasText: "Invoice intent" }).click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await page.getByRole("button", { name: "Review proposed work", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Member 1 title", exact: true });
  await title.fill("Export");
  await title.pressSequentially(" invoices safely");
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("Export invoices safely");
  const criterion = page.getByRole("textbox", { name: "Member 1 criterion 1", exact: true });
  await criterion.fill("A contributor");
  await criterion.pressSequentially(" downloads a CSV");
  await expect(criterion).toBeFocused();
  await page.reload();
  await selectProject(page);
  await page.locator(".ticket-card-body").filter({ hasText: "Invoice intent" }).click();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  await page.getByRole("button", { name: "Review proposed work", exact: true }).click();
  await expect(title).toHaveValue("Export invoices safely");
  await expect(criterion).toHaveValue("A contributor downloads a CSV");
  await page.screenshot({ path: `${captures}/epic-proposal-desktop.png` });
  await page.setViewportSize({ width: 780, height: 900 });
  await page.screenshot({ path: `${captures}/epic-proposal-narrow.png` });
  await page.getByRole("button", { name: "Confirm work", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Export invoices safely",
  );
  const members =
    await db.client`SELECT id,title,state FROM factory.ticket WHERE epic_id IS NOT NULL AND project_id=${projectID} ORDER BY title`;
  expect(members).toHaveLength(2);
  expect(members.every((member) => member["state"] === "ready")).toBe(true);
  expect(
    (await db.client`SELECT converted_to_epic_id FROM factory.ticket WHERE id=${originID}`)[0]?.[
      "converted_to_epic_id"
    ],
  ).toBeTruthy();
  expect(
    (await db.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`).length,
  ).toBe(0);
  expect(
    (await db.client`SELECT id FROM factory.change WHERE project_id=${projectID}`).length,
  ).toBe(0);
  expect(
    (
      await db.client`SELECT canonical_content FROM factory.requirement_revision WHERE ticket_id=${members[0]?.["id"]}`
    )[0]?.["canonical_content"],
  ).toContain("downloads a CSV");
});

test("real Luna finds scoped Wiki and Tickets, then proposes and confirms larger work without starting Builds", async ({
  page,
}) => {
  const wikiID = crypto.randomUUID(),
    ticketID = crypto.randomUUID();
  const body =
    "Invoice exports use CSV with UTF8 encoding. Product contributors download an invoice file. No PDF export exists. Totals are calculated separately.";
  await db.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by) VALUES(${wikiID},${projectID},'invoices','Invoice export',${body},${body},${"b".repeat(40)},${userID})`;
  await db.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by) VALUES(${ticketID},${projectID},'CSV invoice export','Download invoices as CSV','inbox',${userID})`;
  async function message(text: string) {
    const start = performance.now();
    const response = await page.request.post(`/api/projects/${projectID}/conversation/message`, {
      data: { text, commandId: crypto.randomUUID() },
      headers: { origin: "http://127.0.0.1:3000" },
      timeout: 90000,
    });
    const result = await response.json();
    expect(response.ok(), JSON.stringify(result)).toBe(true);
    console.log(
      JSON.stringify({
        journey: text.slice(0, 35),
        modelRoundMs: Math.round(performance.now() - start),
      }),
    );
    return result as {
      entries: Array<{
        id: string;
        kind: string;
        body: string;
        citations: Array<{ source: string; id: string }>;
        payload: Record<string, unknown>;
      }>;
    };
  }
  const research = await message(
    "Search the Wiki and Tickets: what invoice export format and encoding does this project support? Read the source before answering and cite it. Just answer; do not create a ticket.",
  );
  const answer = research.entries.findLast((entry) => entry.kind === "agent-message");
  expect(answer?.body).toContain("CSV");
  expect(
    answer?.citations.some((citation) => citation.id === wikiID || citation.id === ticketID),
  ).toBe(true);
  const mode = await page.request.post(`/api/projects/${projectID}/conversation/mode`, {
    data: { mode: "plan" },
    headers: { origin: "http://127.0.0.1:3000" },
  });
  expect(mode.ok()).toBe(true);
  const epic = await message(
    "Now plan a larger invoice workflow with two independent new outcomes: a contributor views invoice totals and a contributor filters invoices by date. CSV export already exists, do not duplicate or include it. These are all settled decisions. Propose one Epic with two new Tickets, each with observable criteria. No code architecture or new dependencies, no further questions, no implementation. Search existing work to avoid duplicates.",
  );
  const proposal = epic.entries.findLast(
    (entry) => entry.kind === "requirement" && entry.payload["epicProposal"],
  );
  expect(
    proposal,
    JSON.stringify(
      epic.entries.map((entry) => ({ kind: entry.kind, body: entry.body, payload: entry.payload })),
    ),
  ).toBeDefined();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  await page.getByRole("button", { name: "Review proposed work", exact: true }).click();
  await expect(page.getByRole("region", { name: "Proposed Epic" })).toBeVisible();
  await page.screenshot({ path: `${captures}/luna-epic-desktop.png` });
  await page.getByRole("button", { name: "Confirm work", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await db.client`SELECT id FROM factory.epic_confirmation WHERE project_id=${projectID}`)
          .length,
    )
    .toBe(1);
  expect(
    (
      await db.client`SELECT ticket_id FROM factory.requirements_entry_intent WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id=${projectID})`
    ).length,
  ).toBe(0);
  expect(
    (await db.client`SELECT id FROM factory.change WHERE project_id=${projectID}`).length,
  ).toBe(0);
});

test("partial interview answers survive polling, reload and tab switches; queued questions advance immediately", async ({
  page,
}) => {
  const ticketID = crypto.randomUUID();
  const conversationID = crypto.randomUUID();
  const questionID = crypto.randomUUID();
  const roundID = crypto.randomUUID();
  const question = {
    type: "free-text",
    prompt: "Who benefits from this change?",
    placeholder: "Describe the audience",
  };
  const next = {
    type: "free-text",
    prompt: "Which outcome should they observe?",
    placeholder: "Describe the outcome",
  };
  await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${ticketID},${projectID},'Retained answers','ready',${userID})`;
  await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by) VALUES(${conversationID},${projectID},${ticketID},'plan',${userID})`;
  await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
    VALUES(${questionID},${conversationID},1,'question','project-agent','plan',${question.prompt},${JSON.stringify({ question, roundId: roundID, roundIndex: 0, roundQuestions: [question, next] })}::jsonb)`;
  await page.locator(".ticket-card-body").filter({ hasText: "Retained answers" }).click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const answer = page.getByRole("textbox", { name: "Custom answer" });
  await answer.fill("Product contributors and developers");
  await page.waitForTimeout(3500);
  await expect(answer).toHaveValue("Product contributors and developers");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
      `interview-answer:${userID}:${questionID}`,
    ),
  ).toMatchObject({ customText: "Product contributors and developers" });
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  await page.getByRole("tab", { name: "Retained answers", exact: true }).click();
  await expect(answer).toHaveValue("Product contributors and developers");
  await page.reload();
  await selectProject(page);
  await page.locator(".ticket-card-body").filter({ hasText: "Retained answers" }).click();
  if (!(await page.getByRole("complementary", { name: "Agent panel" }).isVisible()))
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(answer).toHaveValue("Product contributors and developers");
  const started = Date.now();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(
    (prompt) => document.querySelector(".conversation-question strong")?.textContent === prompt,
    next.prompt,
  );
  await expect(page.getByText(next.prompt, { exact: true })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(3000);
  const [turn] = await db.client<
    Array<{ state: string }>
  >`SELECT state FROM factory.agent_turn WHERE ticket_id=${ticketID}`;
  expect(turn?.state).toBe("completed");
  await expect(page.getByRole("textbox", { name: "Custom answer" })).toHaveValue("");
  await page.screenshot({ path: `${captures}/interview-desktop.png` });
});

for (const type of ["single-select", "multi-select"] as const)
  test(`${type} choices and custom answers retain the exact last interaction`, async ({ page }) => {
    const ticketID = crypto.randomUUID(),
      conversationID = crypto.randomUUID(),
      questionID = crypto.randomUUID();
    const question = {
      type,
      prompt: "Who uses this?",
      options: [
        { id: "product", label: "Product contributors", description: "" },
        { id: "developers", label: "Developers", description: "" },
      ],
      allowCustom: true,
    };
    await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${ticketID},${projectID},'Choice retention','ready',${userID})`;
    await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by) VALUES(${conversationID},${projectID},${ticketID},'plan',${userID})`;
    await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
    VALUES(${questionID},${conversationID},1,'question','project-agent','plan',${question.prompt},${JSON.stringify({ question })}::jsonb)`;
    await page.locator(".ticket-card-body").filter({ hasText: "Choice retention" }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const choice = page.getByRole(type === "single-select" ? "radio" : "checkbox", {
      name: "Product contributors",
      exact: true,
    });
    await choice.check();
    const key = `interview-answer:${userID}:${questionID}`;
    expect(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), key),
    ).toMatchObject({ selectedOptionIds: ["product"] });
    await page
      .getByRole(type === "single-select" ? "radio" : "checkbox", {
        name: type === "single-select" ? "Something else" : "Add another answer",
        exact: true,
      })
      .check();
    await page.getByRole("textbox", { name: "Custom answer" }).fill("Project managers");
    const ids = type === "single-select" ? [] : ["product"];
    expect(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), key),
    ).toMatchObject({ selectedOptionIds: ids, customText: "Project managers" });
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await page.getByRole("tab", { name: "Choice retention", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Custom answer" })).toHaveValue(
      "Project managers",
    );
    await expect(choice).toBeChecked({ checked: type === "multi-select" });
  });
