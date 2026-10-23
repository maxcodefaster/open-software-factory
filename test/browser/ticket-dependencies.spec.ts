import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { createPlanningEpic, deleteFactoryProject, signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(90_000);

test("named prerequisites block Build and remain linked after cancellation until explicitly removed", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectId = crypto.randomUUID();
  const slug = `dependency-qa-${projectId.slice(0, 8)}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/projects/*/source-workspace/ensure", (route) =>
    route.fulfill({ status: 503, json: { error: "Controlled planning fixture" } }),
  );
  await page.route("**/api/projects/*/developer-ide/ensure", (route) =>
    route.fulfill({ status: 503, json: { error: "Controlled planning fixture" } }),
  );
  try {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const administrator = z
      .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
      .parse(await (await page.request.get("/api/session")).json()).session.user.id;
    await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectId}, ${slug}, 'Dependency QA', 'https://example.invalid/dependency-qa.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    async function createEpic(title: string, parentId: string | null = null) {
      return createPlanningEpic({
        database,
        userID: administrator,
        projectID: projectId,
        title,
        parentID: parentId,
      });
    }
    const root = await createEpic("Release");
    await createEpic("Onboarding", root);
    async function createTicket(title: string, requirements = false) {
      await page.getByRole("button", { name: "New Ticket", exact: true }).click();
      await page.getByLabel("Ticket title", { exact: true }).fill(title);
      await page
        .getByRole("button", {
          name: requirements ? "Write requirements" : "Create as idea",
          exact: true,
        })
        .click();
      await expect(page.getByLabel("Ticket title", { exact: true })).toHaveText(title);
      await expect
        .poll(async () => {
          const [row] =
            await database.client`SELECT id FROM factory.ticket WHERE project_id = ${projectId} AND title = ${title}`;
          return Boolean(row);
        })
        .toBe(true);
      const [ticket] = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.ticket WHERE project_id = ${projectId} AND title = ${title}`;
      if (!ticket) throw new Error("Actual Ticket planning mutation missing");
      return ticket.id;
    }
    const first = await createTicket("Publish the sign-in contract");
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Assign to Epic", exact: true })
      .getByRole("button", { name: "Release", exact: true })
      .click();
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    const second = await createTicket("Build onboarding on the sign-in contract", true);
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Assign to Epic", exact: true })
      .getByRole("button", { name: "Onboarding", exact: true })
      .click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add dependency…", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search Tickets", exact: true }).fill("sign-in");
    await page
      .getByRole("dialog", { name: "Add dependency", exact: true })
      .getByRole("button", { name: "Publish the sign-in contract", exact: true })
      .click();
    const prerequisites = page.getByRole("region", { name: "Blocked by", exact: true });
    await expect(
      prerequisites.getByRole("button", { name: "Publish the sign-in contract", exact: true }),
    ).toBeVisible();
    await expect(prerequisites.getByText("Awaiting delivery", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add dependency", exact: true })).toBeHidden();
    const revisionResponse = await page.request.post(`/api/tickets/${second}/requirements`, {
      headers: { origin: new URL(page.url()).origin },
      data: {
        summary: "Build onboarding on the delivered contract",
        acceptanceCriteria: ["Use the delivered sign-in contract"],
        nonGoals: [],
      },
    });
    expect(revisionResponse.status()).toBe(201);
    const revision = z.object({ id: z.uuid() }).parse(await revisionResponse.json());
    expect(
      (
        await page.request.post(`/api/tickets/${second}/requirements/${revision.id}/approve`, {
          headers: { origin: new URL(page.url()).origin },
        })
      ).status(),
    ).toBe(201);
    await page.reload();
    const board = page.getByRole("region", { name: "Ticket board", exact: true });
    await board.getByRole("button", { name: "Open Epic Release", exact: true }).first().click();
    const rootFolder = page.getByRole("dialog", { name: "Release", exact: true });
    await rootFolder.getByRole("button", { name: "Open Epic Onboarding", exact: true }).click();
    const childFolder = page.getByRole("dialog", { name: "Onboarding", exact: true });
    await childFolder
      .getByRole("button", { name: /Build onboarding on the sign-in contract/ })
      .click();
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
    const denied = await page.request.post(`/api/tickets/${second}/change`, {
      headers: { origin: new URL(page.url()).origin },
    });
    expect(denied.status()).toBe(409);
    expect(z.object({ error: z.string() }).parse(await denied.json()).error).toContain(
      "Publish the sign-in contract",
    );
    await mkdir(".factory/test-results/epic-folders", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/epic-folders/dependencies-ticket-wide.png",
    });
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await board.getByRole("button", { name: "Open Epic Release", exact: true }).first().click();
    await expect(rootFolder.locator(".epic-progress")).toHaveText("0/2 done");
    await rootFolder.getByRole("button", { name: "Open Epic Onboarding", exact: true }).click();
    await expect(childFolder.getByText("Blocked by", { exact: true })).toBeVisible();
    await expect(childFolder.locator(".ticket-card")).toHaveCount(1);
    const blockedCard = childFolder
      .locator(".ticket-card")
      .filter({ hasText: "Build onboarding on the sign-in contract" });
    await blockedCard
      .getByRole("button", { name: "Publish the sign-in contract", exact: true })
      .click();
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveText(
      "Publish the sign-in contract",
    );
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Assign to Epic", exact: true })
        .getByRole("button", { name: "Release", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Add dependency", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await board.getByRole("button", { name: "Open Epic Release", exact: true }).first().click();
    await page.screenshot({
      path: ".factory/test-results/epic-folders/dependencies-board-wide.png",
    });
    await database.client`UPDATE factory.ticket SET state = 'cancelled' WHERE id = ${first}`;
    await rootFolder.getByRole("button", { name: "Open Epic Onboarding", exact: true }).click();
    await childFolder
      .getByRole("button", { name: /Build onboarding on the sign-in contract/ })
      .click();
    await expect(
      prerequisites.getByText("Cancelled · still blocking", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 430, height: 860 });
    await page.screenshot({
      path: ".factory/test-results/epic-folders/dependencies-ticket-narrow.png",
    });
    expect(
      await page
        .locator(".ticket-document")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await prerequisites
      .getByRole("button", {
        name: "Remove prerequisite Publish the sign-in contract",
        exact: true,
      })
      .click();
    await expect(
      prerequisites.getByText("Cancelled · still blocking", { exact: true }),
    ).toBeHidden();
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeEnabled();
    const [count] = await database.client<
      Array<{ count: number }>
    >`SELECT count(*)::integer AS count FROM factory.ticket_dependency WHERE project_id = ${projectId}`;
    expect(count?.count).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    const [owned] =
      await database.client`SELECT id FROM factory.project WHERE id = ${projectId} AND slug = ${slug}
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id = ${projectId})`;
    if (owned) await deleteFactoryProject(projectId);
    await database.client.end();
  }
});
