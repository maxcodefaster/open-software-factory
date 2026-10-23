import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { teardownFactoryProject } from "../support/factory-fixture";

const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
const password = process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password";
const userID = "01994a7d-0000-7000-8000-000000000001";
const repositoryURL = "http://127.0.0.1:33030/factory-mutation/runtime-fixture.git";
const evidenceDirectory = ".factory/test-results/project-agent";
const realModelConfigured = Boolean(
  process.env["FACTORY_MODEL_BASE_URL"] && process.env["FACTORY_MODEL_API_KEY"],
);

let database: ReturnType<typeof createDatabase> | undefined;
let projectID = "";
let projectSlug = "";
let buildChangeID = "";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
}

async function selectProject(page: Page) {
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toContainText(
    "Conversation fixture",
  );
}

test.beforeEach(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  projectSlug = `conversation-${projectID.slice(0, 8)}`;
  await database.client`
    INSERT INTO factory.project(
      id, slug, name, repository_url, default_branch, devcontainer_path, created_by
    ) VALUES (
      ${projectID}, ${projectSlug}, 'Conversation fixture', ${repositoryURL}, 'main',
      '.devcontainer/devcontainer.json', ${userID}
    )
  `;
  await database.client`
    INSERT INTO factory.knowledge_page(
      id, project_id, slug, title, current_body, generated_body,
      source_commit_sha, citations, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${projectID}, 'release-notes', 'Release notes guide',
      'Release notes live in the Project overview and name the exact delivered revision.',
      'Release notes live in the Project overview and name the exact delivered revision.',
      ${"a".repeat(40)}, '[]'::jsonb, ${userID}
    )
  `;
  await database.client`
    INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
    VALUES (
      ${crypto.randomUUID()}, ${projectID}, 'Existing release summary',
      'The existing ticket also covers release notes.', 'done', ${userID}
    )
  `;
});

test.afterEach(async ({ context }) => {
  if (buildChangeID) {
    await context.request.post(`/api/changes/${buildChangeID}/cancel`, {
      headers: { origin: "http://127.0.0.1:3000" },
    });
    await expect
      .poll(
        async () => {
          const response = await context.request.get("/api/runtime-attempts");
          if (!response.ok()) return false;
          const body = (await response.json()) as {
            attempts: Array<{ changeId: string | null; state: string }>;
          };
          return body.attempts
            .filter((attempt) => attempt.changeId === buildChangeID)
            .every((attempt) => attempt.state === "stopped");
        },
        { timeout: 180_000 },
      )
      .toBe(true);
  }
  await teardownFactoryProject(context.request, projectID);
  await database?.client.end();
  database = undefined;
  projectID = "";
  projectSlug = "";
  buildChangeID = "";
});

test("takes one cited Project conversation through interview, approval, and Build", async ({
  page,
}) => {
  test.setTimeout(720_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await signIn(page);
  await selectProject(page);

  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("complementary", { name: "Agent panel" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: /^(Investigate|Plan|Build)$/ })).toHaveCount(0);
  await panel
    .getByLabel("Message conversation")
    .fill("Where are release notes documented in this Project?");
  await panel.getByRole("button", { name: "Send message" }).click();
  if (realModelConfigured) {
    await expect(panel.locator(".agent-message.assistant").last()).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator(".markdown-body .inline-citation").first()).toBeVisible();
  } else {
    await expect(panel.getByText("Knowledge · Release notes guide")).toBeVisible();
    await expect(panel.getByText("Ticket · Existing release summary")).toBeVisible();
  }

  const planningCompute = await database!.client<Array<{ workspaces: number; attempts: number }>>`
    SELECT
      (SELECT count(*)::integer FROM factory.development_workspace
        WHERE project_id = ${projectID}) AS workspaces,
      (SELECT count(*)::integer FROM factory.runtime_attempt
        WHERE project_id = ${projectID}) AS attempts
  `;
  expect(planningCompute[0]).toEqual({ workspaces: 0, attempts: 0 });

  await panel
    .getByLabel("Message conversation")
    .fill("Interview me before you define a compact release summary for the Project overview.");
  await panel.getByRole("button", { name: "Send message" }).click();
  if (realModelConfigured) {
    await expect(
      panel.locator(".conversation-question, .conversation-requirement").last(),
    ).toBeVisible({ timeout: 60_000 });
    for (let answerIndex = 0; answerIndex < 6; answerIndex += 1) {
      if (await panel.locator(".conversation-requirement").last().isVisible()) break;
      const question = panel.locator(".conversation-question").last();
      await expect(question).toBeVisible({ timeout: 60_000 });
      if (answerIndex === 0) {
        await page.screenshot({ path: `${evidenceDirectory}/interview.png` });
      }
      const optionInputs = question.locator('input[name="option"]');
      const optionCount = await optionInputs.count();
      if (optionCount > 0) {
        await optionInputs.first().check();
        if ((await optionInputs.first().getAttribute("type")) === "checkbox" && optionCount > 1) {
          await optionInputs.nth(1).check();
        }
      } else {
        await question.getByLabel("Custom answer").fill("No runtime or deployment changes.");
      }
      const previousTurns = await panel
        .locator(".conversation-question, .conversation-requirement")
        .count();
      await question.getByRole("button", { name: "Continue" }).click();
      await expect
        .poll(() => panel.locator(".conversation-question, .conversation-requirement").count(), {
          timeout: 60_000,
        })
        .toBeGreaterThan(previousTurns);
    }
  } else {
    await expect(panel.getByText("Who is the primary user for this change?")).toBeVisible();
    await page.screenshot({ path: `${evidenceDirectory}/interview.png` });
    await panel.getByLabel(/Product owner/).check();
    await panel.getByRole("button", { name: "Continue" }).click();
    await expect(panel.getByText("Where must the change work?")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 820 });
    await panel.getByLabel(/Desktop/).check();
    await panel.getByLabel(/Narrow screen/).check();
    const narrowLayout = await panel.evaluate((element) => {
      const panelBounds = element.getBoundingClientRect();
      const question = element.querySelector(".conversation-question")?.getBoundingClientRect();
      const composer = element.querySelector(".conversation-composer")?.getBoundingClientRect();
      return {
        withinViewport: panelBounds.left >= 0 && panelBounds.right <= innerWidth,
        questionWithinPanel: Boolean(
          question && question.left >= panelBounds.left && question.right <= panelBounds.right,
        ),
        questionClearsComposer: Boolean(question && composer && question.bottom <= composer.top),
      };
    });
    expect(narrowLayout).toEqual({
      withinViewport: true,
      questionWithinPanel: true,
      questionClearsComposer: true,
    });
    await page.screenshot({ path: `${evidenceDirectory}/narrow-interview.png`, fullPage: true });
    await panel.getByRole("button", { name: "Continue" }).click();
    await expect(panel.getByText("What should explicitly remain out of scope?")).toBeVisible();
    await panel.getByLabel("Custom answer").fill("No runtime or deployment changes.");
    await panel.getByRole("button", { name: "Continue" }).click();
  }
  await expect(panel.getByText("Requirement revision", { exact: true })).toBeVisible();

  const plannedTickets = await database!.client<Array<{ id: string; title: string }>>`
    SELECT id, title FROM factory.ticket
    WHERE project_id = ${projectID} AND state <> 'done'
    ORDER BY created_at DESC LIMIT 1
  `;
  const plannedTicket = plannedTickets[0];
  if (!plannedTicket) throw new Error("The Project Agent did not create a Ticket");

  const afterPlan = await database!.client<Array<{ workspaces: number; attempts: number }>>`
    SELECT
      (SELECT count(*)::integer FROM factory.development_workspace
        WHERE project_id = ${projectID}) AS workspaces,
      (SELECT count(*)::integer FROM factory.runtime_attempt
        WHERE project_id = ${projectID}) AS attempts
  `;
  expect(afterPlan[0]).toEqual({ workspaces: 0, attempts: 0 });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await selectProject(page);
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button")
    .filter({ hasText: plannedTicket.title })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  if (!realModelConfigured) {
    await expect(panel.getByText("Product owner", { exact: true })).toBeVisible();
    await expect(panel.getByText("Desktop, Narrow screen", { exact: true })).toBeVisible();
    await expect(
      panel.getByText("No runtime or deployment changes.", { exact: true }),
    ).toBeVisible();
  }
  await expect(panel.getByRole("button", { name: "Start implementation" })).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${evidenceDirectory}/desktop-requirement.png` });

  await panel.getByRole("button", { name: "Approve exact revision" }).click();
  await expect(panel.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Change", exact: true }).click();
  await expect
    .poll(async () => {
      const rows = await database!.client<Array<{ id: string; state: string }>>`
        SELECT id, state FROM factory.change WHERE project_id = ${projectID}
      `;
      buildChangeID = rows[0]?.id ?? "";
      return rows[0]?.state;
    })
    .toBe("active");
  await expect(page.getByText("The approved revision is fixed for this Change.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready for specification" })).toHaveCount(0);

  if (realModelConfigured) {
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Start implementation" })).toBeEnabled();
    await panel.getByRole("button", { name: "Start implementation" }).click();
    await expect(page.locator(".agent-state")).toHaveText(/working|committed/, {
      timeout: 300_000,
    });
    await expect(page.locator(".agent-activity, .agent-message.assistant").last()).toBeVisible({
      timeout: 300_000,
    });
    const stop = panel.getByRole("button", { name: "Stop OpenCode" });
    if (await stop.isVisible()) await stop.click();
  } else {
    await expect(panel.getByRole("button", { name: "Start implementation" })).toBeDisabled();
    await expect(
      panel.getByText("Model connection required before implementation can start."),
    ).toBeVisible();
  }
  await page.screenshot({ path: `${evidenceDirectory}/build-handoff.png` });

  const finalState = await database!.client<
    Array<{ attempts: number; mode: string; requirements: number; approvals: number }>
  >`
    SELECT
      (SELECT count(*)::integer FROM factory.runtime_attempt
        WHERE project_id = ${projectID}) AS attempts,
      conversation.mode::text AS mode,
      (SELECT count(*)::integer FROM factory.requirement_revision revision
        JOIN factory.ticket ticket ON ticket.id = revision.ticket_id
        WHERE ticket.project_id = ${projectID}) AS requirements,
      (SELECT count(*)::integer FROM factory.requirement_approval approval
        JOIN factory.ticket ticket ON ticket.id = approval.ticket_id
        WHERE ticket.project_id = ${projectID}) AS approvals
    FROM factory.ticket_conversation conversation WHERE conversation.project_id = ${projectID}
  `;
  expect(finalState[0]).toEqual({
    attempts: realModelConfigured ? 1 : 0,
    mode: "build",
    requirements: 1,
    approvals: 1,
  });
});
