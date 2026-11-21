import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { z } from "zod";
import { CommandError } from "../../apps/factory/src/command-error";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  browserBootstrap,
  browserFunction,
  controlledBrowserFunction,
  mockBootstrap,
  mockFactoryFunctions,
  requestFunction,
} from "../fixtures/server-functions";
import { createPlanningEpic, deleteFactoryProject, signIn } from "../support/factory-fixture";
import {
  queuedTicketImplementation,
  ticketRequirementsInput,
} from "../fixtures/ticket-requirements";

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
  // Isolate prerequisite presentation from model connection readiness.
  // Implement below runs actual admission with a read-only Forge fixture.
  await mockBootstrap(page, (value) => ({ ...value, modelRelayConfigured: true }));
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture");
      },
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture");
      },
    },
  });
  try {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const administrator = z
      .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
      .parse(await browserBootstrap(page)).session.user.id;
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
    // The visible Zero projection is optimistic. Capture the document base only
    // after this planning mutation committed its Ticket version.
    await expect
      .poll(
        async () =>
          (
            await database.client`SELECT prerequisite_id FROM factory.ticket_dependency
              WHERE project_id=${projectId} AND ticket_id=${second} AND prerequisite_id=${first}`
          ).length,
      )
      .toBe(1);
    const detail = await serverCall(browserFunction(page, "getTicketDetail", [second]));
    const savedInput = ticketRequirementsInput(
      detail,
      {
        summary: "Build onboarding on the delivered contract",
        acceptanceCriteria: ["Use the delivered sign-in contract"],
        nonGoals: [],
      },
      crypto.randomUUID(),
    );
    const revisionResponse = await requestFunction(page.request, "saveTicketDocument", [
      second,
      savedInput,
    ]);
    const revision = z
      .object({ requirementRevisionId: z.uuid() })
      .parse(await serverCall(Promise.resolve(revisionResponse)));
    expect(
      await serverCall(requestFunction(page.request, "saveTicketDocument", [second, savedInput])),
    ).toEqual(await serverCall(Promise.resolve(revisionResponse)));
    await mockFactoryFunctions(page, {
      tickets: await queuedTicketImplementation(database, administrator, projectId),
    });
    const implementation = Object.freeze({
      commandId: crypto.randomUUID(),
      revisionId: revision.requirementRevisionId,
    });
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tickets/${second}(?:[/?#]|$)`));
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveText(
      "Build onboarding on the sign-in contract",
    );
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    const board = page.getByRole("region", { name: "Ticket board", exact: true });
    await board
      .getByRole("button", { name: /^Open Epic Release(?: |$)/ })
      .first()
      .click();
    const rootFolder = page.getByRole("dialog", { name: "Release", exact: true });
    await rootFolder.getByRole("button", { name: /^Open Epic Onboarding(?: |$)/ }).click();
    const childFolder = page.getByRole("dialog", { name: "Onboarding", exact: true });
    await childFolder
      .getByRole("button", { name: /Build onboarding on the sign-in contract/ })
      .click();
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Queue implementation", exact: true }),
    ).toBeEnabled();
    expect(
      await serverCall(
        controlledBrowserFunction(page, "implementTicket", [second, implementation]),
      ),
    ).toEqual({ id: implementation.commandId });
    const [waiting] = await database.client`
      SELECT state,requirement_revision_id AS revision,source_sha AS source,created_by AS author
      FROM factory.implementation_order WHERE command_id=${implementation.commandId}`;
    expect(waiting).toEqual({
      state: "waiting",
      revision: implementation.revisionId,
      source: "a".repeat(40),
      author: administrator,
    });
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id=${second}`,
    ).toHaveLength(0);
    await mkdir(".factory/test-results/epic-folders", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/epic-folders/dependencies-ticket-wide.png",
    });
    await serverCall(
      requestFunction(page.request, "cancelTicketImplementation", [
        second,
        implementation.commandId,
      ]),
    );
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await board
      .getByRole("button", { name: /^Open Epic Release(?: |$)/ })
      .first()
      .click();
    await expect(rootFolder.locator(".epic-progress")).toHaveText("0/2 done");
    await rootFolder.getByRole("button", { name: /^Open Epic Onboarding(?: |$)/ }).click();
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
    await board
      .getByRole("button", { name: /^Open Epic Release(?: |$)/ })
      .first()
      .click();
    await page.screenshot({
      path: ".factory/test-results/epic-folders/dependencies-board-wide.png",
    });
    await database.client`UPDATE factory.ticket SET state = 'cancelled' WHERE id = ${first}`;
    await rootFolder.getByRole("button", { name: /^Open Epic Onboarding(?: |$)/ }).click();
    await childFolder
      .getByRole("button", { name: /Build onboarding on the sign-in contract/ })
      .click();
    await expect(
      prerequisites.getByText("Cancelled · still blocking", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Queue implementation", exact: true }),
    ).toBeEnabled();
    const secondImplementation = Object.freeze({
      ...implementation,
      commandId: crypto.randomUUID(),
    });
    for (let replay = 0; replay < 2; replay++)
      expect(
        await serverCall(
          controlledBrowserFunction(page, "implementTicket", [second, secondImplementation]),
        ),
      ).toEqual({ id: secondImplementation.commandId });
    const [work] = await database.client<
      Array<{ changes: number; orders: number; turns: number; runtimes: number }>
    >`SELECT
      (SELECT count(*)::integer FROM factory.change WHERE project_id=${projectId}) AS changes,
      (SELECT count(*)::integer FROM factory.implementation_order WHERE project_id=${projectId}) AS orders,
      (SELECT count(*)::integer FROM factory.agent_turn WHERE project_id=${projectId}) AS turns,
      (SELECT count(*)::integer FROM factory.runtime_attempt WHERE project_id=${projectId}) AS runtimes`;
    expect(work).toEqual({ changes: 0, orders: 2, turns: 0, runtimes: 0 });
    const [stillWaiting] = await database.client`
      SELECT state FROM factory.implementation_order WHERE command_id=${secondImplementation.commandId}`;
    expect(stillWaiting?.["state"]).toBe("waiting");
    await page.setViewportSize({ width: 430, height: 860 });
    await page.screenshot({
      path: ".factory/test-results/epic-folders/dependencies-ticket-narrow.png",
    });
    expect(
      await page
        .locator(".ticket-document")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await serverCall(
      requestFunction(page.request, "cancelTicketImplementation", [
        second,
        secondImplementation.commandId,
      ]),
    );
    const [cancelled] = await database.client`
      SELECT state,cancelled_by AS author FROM factory.implementation_order
      WHERE command_id=${secondImplementation.commandId}`;
    expect(cancelled).toEqual({ state: "cancelled", author: administrator });
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
