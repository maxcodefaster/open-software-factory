import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn } from "../support/factory-fixture";

// Read-only local walkthrough. Never starts compute, calls a model or approves Delivery.
test("captures the Starter document and assistant at desktop and phone widths", async ({
  page,
}) => {
  test.setTimeout(40_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mkdir(".factory/screenshots/ux-followup", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: "factory-starter" }).click();
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .getByRole("button")
    .filter({ hasText: "Explain the first-run workflow" })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(page.getByRole("button", { name: "Remove Ticket context" })).toBeVisible();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  const history = page.getByRole("complementary", { name: "Specification history" });
  await history.getByRole("button", { name: /Version 2/ }).click();
  await expect(page.locator(".historical-document table").first()).toBeVisible();
  await page.screenshot({
    path: ".factory/screenshots/ux-followup/ticket-history-desktop.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: "Factory starter", exact: true }).click();
  await expect(page.locator(".knowledge-article table").first()).toBeVisible();
  await page.getByRole("button", { name: "Remove Ticket context" }).click();
  await expect(page.getByRole("button", { name: "Remove Ticket context" })).toHaveCount(0);
  await page.screenshot({
    path: ".factory/screenshots/ux-followup/knowledge-chat-desktop.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Minimize Agent panel" }).click();
  await page.getByRole("button", { name: "Desktop", exact: true }).click();
  const requirements = page.getByRole("region", { name: "requirements", exact: true });
  await requirements.locator("summary").filter({ hasText: "Reset the counter safely" }).click();
  await requirements.getByRole("button").filter({ hasText: "TCK-EF18D6" }).click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await page.getByRole("button", { name: "Attach selected Ticket" }).click();
  await expect(page.locator(".assistant-context-chip")).toContainText("Reset the counter safely");
  await expect(
    page.getByRole("button", { name: "Requirements interview", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".factory/screenshots/ux-followup/requirements-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(page.getByRole("dialog", { name: "Agent panel" })).toBeVisible();
  await page.screenshot({
    path: ".factory/screenshots/ux-followup/assistant-narrow.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Minimize Agent panel" }).click();
  await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
  await expect(page.locator(".knowledge-article")).toBeVisible();
  await page.screenshot({
    path: ".factory/screenshots/ux-followup/knowledge-narrow.png",
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "Explain the first-run workflow", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Specification summary", exact: true }).locator("table"),
  ).toBeVisible();
  await page.screenshot({
    path: ".factory/screenshots/ux-followup/ticket-narrow.png",
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});

test("the original Starter Ticket opens real source, PTY and its development Preview without another Build", async ({
  page,
}) => {
  test.setTimeout(720_000);
  const database = createDatabase(1);
  try {
    const [change] = await database.client<Array<{ id: string }>>`
      SELECT change.id FROM factory.change change
      JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.project project ON project.id = change.project_id
      WHERE project.slug = 'factory-starter' AND ticket.title = 'Add a friendly empty-counter hint'`;
    if (!change) throw new Error("Missing original Starter Change");
    const turns = async () =>
      database.client`SELECT id,state FROM factory.agent_turn WHERE change_id = ${change.id} ORDER BY created_at`;
    const before = await turns();
    await mkdir(".factory/screenshots/ux-followup", { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: "factory-starter" }).click();
    for (const name of ["implementation", "review"]) {
      const stage = page.getByRole("region", { name, exact: true });
      const stack = stage.locator("summary").filter({ hasText: "A welcoming starter" });
      if (await stack.isVisible()) await stack.click();
    }
    await page
      .locator(".ticket-card-body")
      .filter({ hasText: "Add a friendly empty-counter hint" })
      .click();
    const started = performance.now();
    const [existingRuntime] = await database.client<Array<{ id: string; state: string }>>`
      SELECT attempt.id, attempt.state FROM factory.runtime_attempt attempt
      JOIN factory.change change ON change.runtime_attempt_id = attempt.id
      WHERE change.id = ${change.id}`;
    const ensured =
      existingRuntime?.state === "ready"
        ? undefined
        : page.waitForResponse(
            (response) =>
              response.url().endsWith(`/api/changes/${change.id}/ticket-workspace/ensure`) &&
              response.request().method() === "POST",
          );
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
    const response = ensured ? await ensured : undefined;
    if (response) expect(response.ok()).toBe(true);
    const runtime = response ? runtimeAttemptSchema.parse(await response.json()) : existingRuntime;
    if (!runtime) throw new Error("Missing Starter Runtime Attempt");
    await expect
      .poll(
        async () => {
          const [attempt] = await database.client<Array<{ state: string; failure: string | null }>>`
        SELECT state, failure FROM factory.runtime_attempt WHERE id = ${runtime.id}`;
          if (attempt?.state === "failed" || attempt?.state === "cleanup-failed") {
            throw new Error(`Original Starter Workspace failed: ${attempt.failure}`);
          }
          return attempt?.state;
        },
        { timeout: 600_000, intervals: [500, 1_000] },
      )
      .toBe("ready");
    const ide = page.locator('iframe[title="Factory IDE"]').contentFrame();
    await page.screenshot({ path: ".factory/screenshots/ux-followup/starter-ide-attachment.png" });
    await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 60_000 });
    await expect(ide.locator(".theia-preload")).toHaveCount(0);
    const shellMS = Math.round(performance.now() - started);
    await ide.getByText("src", { exact: true }).first().click();
    await ide.getByText("server.mjs", { exact: true }).first().click();
    await expect(ide.locator(".monaco-editor:visible .view-lines").first()).toContainText(
      "createServer",
    );
    const editorMS = Math.round(performance.now() - started);
    await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
    const terminal = ide.locator(".factory-terminal-host:not([hidden])");
    await expect(terminal).toHaveAttribute("data-connection-state", "connected");
    await terminal.locator(".xterm").click({ force: true });
    await page.keyboard.type("printf 'starter-workspace='; pwd");
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(
      "starter-workspace=/workspace/project",
    );
    const terminalMS = Math.round(performance.now() - started);
    await page.screenshot({ path: ".factory/screenshots/ux-followup/starter-source-terminal.png" });
    await ide.locator(".lm-TabBar-tab").filter({ hasText: "Run" }).click();
    await ide.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.locator('iframe[title="Factory Preview"]:visible').contentFrame();
    await expect(
      preview.getByRole("heading", { name: /Ready for your first change/ }),
    ).toBeVisible();
    await preview.getByRole("button", { name: "Add one", exact: true }).click();
    await expect(preview.getByLabel("Count", { exact: true })).toHaveText("1");
    await page.screenshot({
      path: ".factory/screenshots/ux-followup/starter-development-preview.png",
    });
    expect(await turns()).toEqual(before);
    await writeFile(
      ".factory/screenshots/ux-followup/starter-dev-timings.json",
      JSON.stringify(
        {
          shellMS,
          editorMS,
          terminalMS,
          meaning:
            "Existing original Ticket Workspace; see runtime signals for whether compute was already ready. Not an empty-cache cold start.",
        },
        null,
        2,
      ),
    );
  } finally {
    await database.client.end({ timeout: 2 });
  }
});

test("the original Starter opens an authenticated live Preview without changing planning or delivery", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const database = createDatabase(1);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const [starter] = await database.client<Array<{ id: string }>>`
      SELECT id FROM factory.project WHERE slug = 'factory-starter'`;
    if (!starter) throw new Error("Missing original Starter Project");
    const projectID = starter.id;
    const planning = async () =>
      database.client`
        SELECT
          (SELECT count(*) FROM factory.ticket WHERE project_id = ${projectID}) AS tickets,
          (SELECT count(*) FROM factory.epic WHERE project_id = ${projectID}) AS epics,
          (SELECT count(*) FROM factory.agent_turn WHERE project_id = ${projectID}) AS turns,
          (SELECT count(*) FROM factory.delivery_approval approval JOIN factory.change change
            ON change.id = approval.change_id WHERE change.project_id = ${projectID}) AS approvals`;
    const before = await planning();
    await mkdir(".factory/screenshots/ux-followup", { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: "factory-starter" }).click();
    for (const stage of ["ideas", "requirements", "implementation", "review"]) {
      await expect(page.getByRole("region", { name: stage, exact: true })).toBeVisible();
    }
    await page.screenshot({ path: ".factory/screenshots/ux-followup/starter-board-desktop.png" });
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect
      .poll(
        async () => {
          const { attempts } = await (
            await page.request.get(`/api/runtime-attempts?projectId=${projectID}`)
          ).json();
          return attempts.find(
            (attempt: { projectId: string; currentStaging: boolean }) =>
              attempt.projectId === projectID && attempt.currentStaging,
          )?.state;
        },
        { timeout: 540_000 },
      )
      .toBe("ready");
    const preview = page.locator('iframe[title="Factory Preview"]').contentFrame();
    await expect(
      preview.getByRole("heading", { name: /Ready for your first change/ }),
    ).toBeVisible();
    await preview.getByRole("button", { name: "Add one", exact: true }).click();
    await expect(preview.getByLabel("Count", { exact: true })).toHaveText("1");
    await page.screenshot({ path: ".factory/screenshots/ux-followup/starter-preview-desktop.png" });
    await page.setViewportSize({ width: 430, height: 900 });
    await expect(
      preview.getByRole("heading", { name: /Ready for your first change/ }),
    ).toBeVisible();
    await page.screenshot({ path: ".factory/screenshots/ux-followup/starter-preview-narrow.png" });
    expect(await planning()).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    await database.client.end();
  }
});
