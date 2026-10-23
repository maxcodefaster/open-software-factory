import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

const observer = process.env["FACTORY_REQUIREMENTS_MODEL_OBSERVER"];
const captures = ".factory/test-results/explicit-requirements";
let database: ReturnType<typeof createDatabase>;
let projectID: string;
let slug: string;
test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(60_000);
test.beforeEach(async ({ page }) => {
  test.skip(!observer, "Requires an isolated Factory and its controlled planning-model observer");
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await (await page.request.get("/api/session")).json();
  database = createDatabase(2);
  projectID = crypto.randomUUID();
  slug = `explicit-requirements-${projectID.slice(0, 8)}`;
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${slug},'Explicit Requirements','https://example.invalid/owned/requirements.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
  for (const action of ["source-workspace", "developer-ide"])
    await page.route(`**/api/projects/${projectID}/${action}/ensure`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: "This planning fixture starts no runtime" },
      }),
    );
  await mkdir(captures, { recursive: true });
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
});
test.afterEach(async () => {
  if (projectID) await deleteFactoryProject(projectID);
  if (database) await database.client.end({ timeout: 0 });
  projectID = "";
});

async function calls(page: Page) {
  return ((await (await page.request.get(observer!)).json()) as { calls: number }).calls;
}
async function create(page: Page, title: string, idea = false) {
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(title);
  await page
    .getByRole("textbox", { name: "Ticket description", exact: true })
    .fill("The intended result is already settled.");
  await page
    .getByRole("button", { name: idea ? "Create as idea" : "Write requirements", exact: true })
    .click();
  await expect(page.getByRole("article", { name: "Ticket document", exact: true })).toBeVisible();
  const [ticket] = await database.client<
    { id: string }[]
  >`SELECT id FROM factory.ticket WHERE project_id=${projectID}`;
  if (!ticket) throw new Error("Owned Ticket missing");
  return ticket.id;
}

for (const idea of [false, true])
  test(`manual Requirements from ${idea ? "Ideas" : "a new Ticket"} stay model-free through save, reload and Implement`, async ({
    page,
  }) => {
    const baseline = await calls(page);
    const ticketID = await create(page, "Write the settled requirements directly", idea);
    const capture = `${captures}/manual-${idea ? "idea" : "new"}`;
    if (idea) {
      await page.screenshot({ path: `${capture}-captured-desktop.png` });
      await page.getByRole("button", { name: "Write requirements", exact: true }).click();
    }
    await expect(page.getByRole("complementary", { name: "Agent panel" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Ask AI to clarify", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Clarifying requirements", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${capture}-empty-desktop.png` });
    const criterion = page.getByRole("textbox", { name: "Acceptance criterion 1", exact: true });
    await criterion.fill("The dashboard displays the exact total for the current user.");
    await expect
      .poll(
        async () =>
          (
            await database.client`SELECT id FROM factory.requirement_revision WHERE ticket_id=${ticketID}`
          ).length,
      )
      .toBe(1);
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
    await expect
      .poll(
        async () =>
          (
            await database.client`SELECT id FROM factory.ticket_document_revision WHERE ticket_id=${ticketID} AND author_kind='human'`
          ).length,
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: `${capture}-ready-desktop.png` });
    await page.reload();
    await page
      .getByRole("region", { name: "requirements", exact: true })
      .locator(".ticket-card-body")
      .click();
    await expect(
      page.getByRole("textbox", { name: "Acceptance criterion 1", exact: true }),
    ).toHaveText("The dashboard displays the exact total for the current user.");
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 430, height: 960 });
    await page.screenshot({ path: `${capture}-ready-narrow.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      430,
    );
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.ticket_conversation WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT ticket_id FROM factory.requirements_entry_intent WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(await calls(page)).toBe(baseline);
    let input: { commandId: string; revisionId: string } | undefined;
    await page.route(`**/api/tickets/${ticketID}/implement`, async (route) => {
      input = route.request().postDataJSON();
      await route.fulfill({ status: 202, json: {} });
    });
    await page.getByRole("button", { name: "Implement", exact: true }).click();
    await expect.poll(() => input?.revisionId).toBeTruthy();
    const [revision] = await database.client<
      { id: string }[]
    >`SELECT id FROM factory.requirement_revision WHERE ticket_id=${ticketID}`;
    expect(input?.revisionId).toBe(revision?.id);
    expect(input?.commandId).toMatch(/^[a-f0-9-]{36}$/);
    expect(await calls(page)).toBe(baseline);
  });

for (const idea of [false, true])
  test(`AI clarification starts only on request from ${idea ? "Ideas" : "Requirements"} and reconnect does not replay it`, async ({
    page,
  }) => {
    const baseline = await calls(page);
    const ticketID = await create(
      page,
      `Optional clarification from ${idea ? "Ideas" : "Requirements"}`,
      idea,
    );
    expect(await calls(page)).toBe(baseline);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    await page.getByRole("button", { name: "Ask AI to clarify", exact: true }).click();
    const question = page
      .locator(".conversation-question")
      .getByText("Who should use the result?", { exact: true });
    await expect(question).toBeVisible();
    await expect.poll(() => calls(page)).toBe(baseline + 1);
    const rows = await database.client<{ intent: string; mode: string; state: string }[]>`
    SELECT turn.input->>'intent' AS intent,turn.authority->>'mode' AS mode,ticket.state
    FROM factory.agent_turn turn JOIN factory.ticket ticket ON ticket.id=turn.ticket_id
    WHERE turn.ticket_id=${ticketID}`;
    expect(rows).toEqual([{ intent: "requirements-interview", mode: "plan", state: "ready" }]);
    await page.screenshot({
      path: `${captures}/interview-${idea ? "idea" : "requirements"}-desktop.png`,
    });
    await page.reload();
    await page
      .getByRole("region", { name: "requirements", exact: true })
      .locator(".ticket-card-body")
      .click();
    await page.getByRole("button", { name: "Continue clarification", exact: true }).click();
    await expect(question).toBeVisible();
    expect(await calls(page)).toBe(baseline + 1);
    await page.setViewportSize({ width: 430, height: 960 });
    await page.screenshot({
      path: `${captures}/interview-${idea ? "idea" : "requirements"}-narrow.png`,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      430,
    );
  });
