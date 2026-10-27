import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  type AgentView,
  agentViewSchema,
  changesResponseSchema,
  conversationViewSchema,
  deliveryViewSchema,
  developerIDEViewSchema,
  sourceWorkspaceViewSchema,
  writerViewSchema,
} from "../../apps/factory/src/api-contracts";
import { CommandError } from "../../apps/factory/src/command-error";
import { developerIDEOrigin } from "../../apps/factory/src/developer-ide-origin";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import {
  type ReviewFeedback,
  visualReviewSchema,
} from "../../packages/conversation-domain/src/visual-review";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  browserBootstrap,
  browserFunction,
  completedConversation,
  factoryFunctionMatches,
  mockAgentView,
  mockBootstrap,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { streamedAgentView } from "../support/agent-activity-route";
import { serveChatAssets } from "../support/chat-assets";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";
import { fixtureValue } from "../fixtures/value";

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(30_000);
let projectID = "";
let ticketID = "";
let revisionID = "";
const title = "A calm implementation journey";

test.beforeEach(async ({ page }) => {
  await serveChatAssets(page);
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  projectID = crypto.randomUUID();
  ticketID = crypto.randomUUID();
  revisionID = crypto.randomUUID();
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
  // Scripted Changes have no database review. Individual cases override the service double.
  await mockFactoryFunctions(page, {
    review: {
      get: async () =>
        visualReviewSchema.parse({
          feedback: [],
          recording: null,
          scenarios: [],
        }),
    },
  });
  const canonical = canonicalRequirementContent({
    summary: "Make the **starter** welcoming.",
    acceptanceCriteria: ["A clear first action."],
    nonGoals: [],
  });
  const db = createDatabase(1);
  try {
    await db.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`implementation-ux-${projectID}`}, 'Implementation UX', 'https://example.invalid/owned-implementation-ux.git', 'main', '.devcontainer/devcontainer.json', ${session.user.id})`;
    await db.client`INSERT INTO factory.ticket(id, project_id, title, state, created_by)
      VALUES (${ticketID}, ${projectID}, ${title}, 'ready', ${session.user.id})`;
    await db.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${revisionID}, ${ticketID}, 1, ${canonical}, ${createHash("sha256").update(canonical).digest("hex")}, ${session.user.id})`;
  } finally {
    await db.client.end();
  }
});
test.afterEach(async () => {
  if (projectID) await deleteFactoryProject(projectID);
  projectID = "";
});

async function selectProject(page: Parameters<typeof signIn>[0]) {
  await openProjectMenu(page);
  await page
    .getByRole("button")
    .filter({ hasText: `implementation-ux-${projectID}` })
    .click();
}

test("review distinguishes source checks from App video timing", async ({ page }) => {
  const changeID = crypto.randomUUID();
  const recordingID = crypto.randomUUID();
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-source-case",
              baseSha: "a".repeat(40),
              state: "active",
              runtimeState: "ready",
              branchState: "succeeded",
              implementationState: "committed",
              buildTurnState: "completed",
            },
          ],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async () => ({
      state: "committed",
      sessionAvailable: true,
      runtimeConnected: true,
      messagesAvailable: true,
      messages: [],
      stopPending: false,
      stopId: null,
    }),
    { activity: true },
  );
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({
          verificationState: "succeeded",
          reviewState: "passed",
          reviewCurrent: true,
        });
      },
    },
  });
  await page.route(`**/api/changes/${changeID}/review/media/${recordingID}`, (route) =>
    route.fulfill({ status: 503, body: "Controlled video unavailability, not an App result." }),
  );
  await mockFactoryFunctions(page, {
    review: {
      get: async () =>
        visualReviewSchema.parse({
          feedback: [],
          recordingCurrent: true,
          recording: {
            id: recordingID,
            state: "complete",
            commitSha: "b".repeat(40),
            durationMs: 15000,
            reason: null,
          },
          scenarios: [
            {
              id: "source-check",
              title: "Protected repository checks",
              category: "normal",
              observationKind: "source",
              startedMs: 0,
              endedMs: null,
              hasRecordingPosition: false,
              status: "passed",
              expected: "The reviewed commit has relevant protected checks.",
              observed:
                "Read the exact workflow and tests; Factory confirmed the same commit's CI.",
            },
            {
              id: "app-check",
              title: "Invalid App input",
              category: "error",
              observationKind: "app",
              startedMs: 0,
              endedMs: null,
              hasRecordingPosition: false,
              status: "passed",
              expected: "Invalid input is rejected.",
              observed: "The App showed its validation error.",
            },
          ],
        }),
    },
  });
  await selectProject(page);
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button")
    .filter({ hasText: title })
    .click();
  const review = page.getByRole("region", { name: "Visual review", exact: true });
  const source = review.getByRole("button", { name: /Protected repository checks Source check/ });
  await expect(source).toBeVisible();
  await expect(source).not.toContainText("Timing unavailable");
  await expect(review.getByRole("button", { name: /Invalid App input/ })).toContainText(
    "Timing unavailable",
  );
  await source.click();
  await expect(
    review.getByRole("definition").filter({ hasText: "The reviewed commit" }),
  ).toBeVisible();
  await expect(
    review.getByText("Read the exact workflow and tests; Factory confirmed the same commit's CI.", {
      exact: true,
    }),
  ).toBeVisible();
  const evidence = ".factory/test-results/review-case-observations";
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/source-check-wide.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(source).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${evidence}/source-check-narrow.png`, fullPage: true });
});

for (const state of [
  { id: "personal-draft", primary: "Write requirements" },
  { id: "idea", primary: "Write requirements" },
  { id: "requirements", primary: "Implement" },
  { id: "proposal", primary: "Confirm answers" },
  { id: "preparing", primary: "" },
  { id: "coding", primary: "" },
  { id: "coding-paused", primary: "Resume implementation" },
  { id: "reviewing", primary: "" },
  { id: "revision", primary: "Request revision · 1 Thread" },
  { id: "checks-paused", primary: "Resume checks" },
  { id: "review-retry", primary: "Retry review" },
  { id: "ready-to-deliver", primary: "Deliver" },
  { id: "delivered", primary: "Create follow-up" },
]) {
  test(`Ticket action bar is consistent in ${state.id}`, async ({ page }) => {
    test.setTimeout(60_000);
    const evidence = ".factory/test-results/ticket-action-bar/states";
    await mkdir(evidence, { recursive: true });
    const changeID = crypto.randomUUID();
    const turnID = crypto.randomUUID();
    const hasChange = !["personal-draft", "idea", "requirements", "proposal"].includes(state.id);
    const preparing = state.id === "preparing";
    const coding = state.id === "coding";
    const paused = state.id === "coding-paused";
    const delivered = state.id === "delivered";
    const reviewState =
      state.id === "reviewing"
        ? "running"
        : state.id === "review-retry"
          ? "incomplete"
          : state.id === "checks-paused"
            ? "stopped"
            : "passed";
    const { session } = await browserBootstrap(page);
    const database = createDatabase(1);
    try {
      await database.client`UPDATE factory.ticket
        SET state=${state.id === "idea" ? "inbox" : delivered ? "done" : hasChange ? "in-progress" : "ready"}
        WHERE id=${ticketID}`;
    } finally {
      await database.client.end();
    }
    if (state.id === "proposal") {
      const detail = await serverCall(browserFunction(page, "getTicketDetail", [ticketID]));
      await mockFactoryFunctions(page, {
        tickets: {
          detail: async () => ({
            ...detail,
            proposal: {
              id: crypto.randomUUID(),
              ticket: { title, description: "A proposed, not yet approved requirement." },
              requirement: {
                summary: "Make the starter welcoming.",
                acceptanceCriteria: ["A clear first action."],
                nonGoals: [],
              },
              base: { version: detail.ticket.version, documentId: null, revisionId: revisionID },
            },
          }),
        },
      });
    }
    await mockFactoryFunctions(page, {
      runtime: {
        changes: async () =>
          changesResponseSchema.parse({
            changes: hasChange
              ? [
                  {
                    id: changeID,
                    projectId: projectID,
                    ticketId: ticketID,
                    branchName: "factory/owned-action-bar",
                    baseSha: "a".repeat(40),
                    state: delivered ? "delivered" : preparing ? "starting" : "active",
                    runtimeState: preparing ? "create-intended" : "ready",
                    branchState: "succeeded",
                    implementationState: preparing
                      ? "starting"
                      : coding || paused
                        ? "working"
                        : "committed",
                    buildTurnState:
                      preparing || paused ? "pending" : coding ? "running" : "completed",
                  },
                ]
              : [],
          }),
      },
    });
    await mockAgentView(
      page,
      changeID,
      async () => ({
        state: preparing || paused ? "starting" : coding ? "working" : "committed",
        sessionAvailable: true,
        runtimeConnected: !preparing,
        messagesAvailable: true,
        messages: [],
        stopPending: false,
        stopId: null,
        codingPause: paused ? { turnID, reason: "finish-reserve-used" } : null,
      }),
      { activity: true },
    );
    await mockFactoryFunctions(page, {
      delivery: {
        async get(_actor, id) {
          if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
          return deliveryViewSchema.parse(
            preparing || coding || paused
              ? {}
              : {
                  verificationState: state.id === "checks-paused" ? "cancelled" : "succeeded",
                  reviewState,
                  reviewCurrent: true,
                  openReviewThreads: state.id === "revision" ? 1 : 0,
                  ...(state.id === "checks-paused" ? { checksStopId: crypto.randomUUID() } : {}),
                },
          );
        },
      },
    });
    await mockFactoryFunctions(page, {
      review: {
        get: async () =>
          visualReviewSchema.parse({
            feedback:
              state.id === "revision"
                ? [
                    {
                      id: crypto.randomUUID(),
                      kind: "thread",
                      state: "open",
                      version: 1,
                      authorId: session.user.id,
                      author: "Reviewer",
                      commitSha: "a".repeat(40),
                      annotation: null,
                      createdAt: new Date().toISOString(),
                      messages: [
                        {
                          id: crypto.randomUUID(),
                          author: "Reviewer",
                          body: "Keep the entered draft after validation.",
                          createdAt: new Date().toISOString(),
                        },
                      ],
                    },
                  ]
                : [],
            recording: null,
            scenarios: [],
            canSendCorrections: state.id === "revision",
            readOnly: delivered,
          }),
      },
    });
    let commands = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/(?:implement|message|start|resume|deliver|send|retry-review)$/.test(
          new URL(request.url()).pathname,
        )
      )
        commands++;
    });
    await selectProject(page);
    if (state.id === "personal-draft") {
      await page.getByRole("button", { name: "New Ticket", exact: true }).click();
      await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(title);
    } else {
      if (delivered) await page.getByRole("button", { name: /History/ }).click();
      await page
        .getByRole("region", { name: "Ticket board" })
        .getByRole("button")
        .filter({ hasText: title })
        .last()
        .click();
    }
    const toolbar = page.locator(".ticket-header-actions");
    await expect(toolbar).toBeVisible();
    if (hasChange) {
      await expect(page.getByRole("button", { name: "Ticket actions", exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Visual review", exact: true })).toBeVisible();
    }
    if (preparing)
      await expect(page.locator(".ticket-checks > summary")).toHaveText("Preparing implementation");
    if (coding)
      await expect(page.locator(".ticket-checks > summary")).toHaveText(
        "Implementation in progress",
      );
    if (state.id === "reviewing")
      await expect(page.locator(".ticket-checks > summary")).toHaveText(
        "Independent review in progress",
      );
    if (state.primary)
      await expect(toolbar.locator('[data-primary="true"]')).toHaveText(state.primary);
    else await expect(toolbar.locator('[data-primary="true"]')).toHaveCount(0);
    for (const width of [1440, 900, 430, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.mouse.move(1, 1);
      for (const button of await toolbar.locator(":scope > button:visible").all())
        await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const metrics = await toolbar.evaluate((element) => {
        const buttons = [...element.querySelectorAll<HTMLButtonElement>(":scope > button")].filter(
          (button) => button.getClientRects().length,
        );
        return {
          icons: buttons.reduce(
            (count, button) => count + button.querySelectorAll("svg").length,
            0,
          ),
          styles: buttons.map((button) => {
            const style = getComputedStyle(button);
            return [style.backgroundColor, style.borderWidth, style.boxShadow, style.minHeight];
          }),
          last: buttons.at(-1)?.getAttribute("data-primary"),
        };
      });
      expect(metrics.icons).toBe(0);
      const header = await page.locator(".ticket-document-heading").evaluate((element) => {
        const title = element.querySelector(".workspace-heading-title")?.getBoundingClientRect();
        const actions = element.querySelector(".workspace-action-bar")?.getBoundingClientRect();
        if (!title || !actions) throw new Error("Missing document title or actions");
        return {
          title: title.toJSON(),
          actions: actions.toJSON(),
          overflow: element.scrollWidth - element.clientWidth,
        };
      });
      expect(header.overflow).toBeLessThanOrEqual(1);
      expect(header.title.top).toBeLessThanOrEqual(header.actions.top + 1);
      if (header.actions.top < header.title.bottom - 1)
        expect(header.title.right).toBeLessThanOrEqual(header.actions.left + 1);
      else expect(header.title.bottom).toBeLessThanOrEqual(header.actions.top + 1);
      if (width === 1440)
        expect(Math.abs(header.title.top - header.actions.top)).toBeLessThanOrEqual(1);
      for (const style of metrics.styles)
        expect(style).toEqual(["rgba(0, 0, 0, 0)", "0px", "none", "32px"]);
      if (state.primary) expect(metrics.last).toBe("true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await toolbar.evaluate((element) => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && element.contains(active)) active.blur();
      });
      await page.locator(".ticket-document-heading").screenshot({
        path: `${evidence}/${state.id}-${width}.png`,
      });
      if (state.id !== "personal-draft") {
        const opener = toolbar.getByRole("button", { name: "Ticket actions", exact: true });
        await opener.click();
        const menu = page.getByRole("menu", { name: "Ticket actions", exact: true });
        await expect(menu).toBeVisible();
        const bounds = await menu.boundingBox();
        expect(fixtureValue(bounds, "bounds").x).toBeGreaterThanOrEqual(0);
        expect(
          fixtureValue(bounds, "bounds").x + fixtureValue(bounds, "bounds").width,
        ).toBeLessThanOrEqual(width);
        expect(
          fixtureValue(bounds, "bounds").y + fixtureValue(bounds, "bounds").height,
        ).toBeLessThanOrEqual(960);
        if (state.id === "revision" && width === 430) {
          const refreshed = page.waitForResponse(
            async (response) => await factoryFunctionMatches(response.url(), "getVisualReview"),
          );
          await page.evaluate(
            (id) => window.dispatchEvent(new CustomEvent("factory-review-changed", { detail: id })),
            changeID,
          );
          await refreshed;
          await expect(menu).toBeVisible();
          expect(
            await menu
              .locator("svg")
              .first()
              .evaluate((element) => getComputedStyle(element).fill),
          ).toBe("none");
          const feedbackLabel = await menu
            .getByRole("menuitem", { name: "Add feedback", exact: true })
            .locator("span")
            .boundingBox();
          const reloadLabel = await menu
            .getByRole("menuitem", { name: "Reload review", exact: true })
            .locator("span")
            .boundingBox();
          expect(
            Math.abs(
              fixtureValue(feedbackLabel, "feedbackLabel").x -
                fixtureValue(reloadLabel, "reloadLabel").x,
            ),
          ).toBeLessThanOrEqual(1);
          await page.screenshot({
            path: `${evidence}/revision-menu-430.png`,
            animations: "disabled",
          });
          await expect(menu).toBeVisible();
        }
        await page.keyboard.press("Escape");
        await expect(opener).toBeFocused();
      }
    }
    expect(commands).toBe(0);
    expect(errors).toEqual([]);
  });
}

test("the specification leads while request details remain available and editable without repeated prose", async ({
  page,
}) => {
  const db = createDatabase(1);
  const request =
    "Earlier request context that must remain available without repeating the specification.";
  try {
    await db.client`UPDATE factory.ticket SET description=${request} WHERE id=${ticketID}`;
    await selectProject(page);
    await page
      .getByRole("region", { name: "requirements", exact: true })
      .locator(".ticket-card-body")
      .click();
    const details = page.locator(".ticket-request-details");
    const description = page.getByRole("textbox", { name: "Ticket description", exact: true });
    await expect(
      page.getByRole("textbox", { name: "Specification summary", exact: true }),
    ).toBeVisible();
    await expect(description).toBeHidden();
    await details.locator("summary").click();
    await expect(description).toHaveText(request);
    await description.fill("Revised request context stays intact.");
    await expect
      .poll(async () => {
        const [row] = await db.client`SELECT description FROM factory.ticket WHERE id=${ticketID}`;
        return row?.["description"];
      })
      .toBe("Revised request context stays intact.");
    await details.locator("summary").click();
    await expect(description).toBeHidden();
    await details.locator("summary").click();
    await expect(description).toHaveText("Revised request context stays intact.");
    await mkdir(".factory/test-results/implementation-journey", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/implementation-journey/request-details-expanded.png",
    });
    await details.locator("summary").click();
    await page.screenshot({
      path: ".factory/test-results/implementation-journey/specification-first.png",
    });
  } finally {
    await db.client.end();
  }
});

test("capacity wait and Coding pause retain the Ticket and expose only an explicit resume", async ({
  page,
}) => {
  const changeID = crypto.randomUUID(),
    turnID = crypto.randomUUID();
  let paused = false;
  const resumes: unknown[] = [];
  const change = {
    id: changeID,
    projectId: projectID,
    ticketId: ticketID,
    branchName: "factory/owned-usage",
    baseSha: "a".repeat(40),
    state: "active",
    branchState: "succeeded",
    implementationState: "starting",
    buildTurnState: "pending",
  };
  await mockFactoryFunctions(page, {
    runtime: { changes: async () => changesResponseSchema.parse({ changes: [change] }) },
  });
  await mockAgentView(
    page,
    changeID,
    async () => ({
      state: "starting",
      sessionAvailable: true,
      runtimeConnected: false,
      messagesAvailable: true,
      messages: [],
      stopPending: false,
      stopId: null,
      computeWait: paused ? null : "capacity",
      codingPause: paused ? { turnID, reason: "finish-reserve-used" } : null,
    }),
    { activity: true },
  );
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await mockFactoryFunctions(page, {
    agent: {
      resume: async (_actor, _factoryTargetID, factoryCommand) => {
        resumes.push(factoryCommand);
        return (() => {
          throw new Error("Controlled lost response");
        })();
      },
    },
  });
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await expect(page.getByText("Waiting for execution capacity.", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume implementation", exact: true }),
  ).toHaveCount(0);
  await mkdir(".factory/screenshots/usage-limits", { recursive: true });
  await page.screenshot({ path: ".factory/screenshots/usage-limits/capacity-wait.png" });
  paused = true;
  await expect(page.getByText("Coding paused at its allowance.", { exact: false })).toBeVisible({
    timeout: 10000,
  });
  const resume = page.getByRole("button", { name: "Resume implementation", exact: true });
  await expect(resume).toBeEnabled();
  expect(resumes).toEqual([]);
  await page.screenshot({ path: ".factory/screenshots/usage-limits/coding-pause.png" });
  await resume.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await resume.click();
  await expect.poll(() => resumes.length).toBe(2);
  expect(resumes[1]).toEqual(resumes[0]);
  expect(resumes[0]).toMatchObject({ pausedTurnId: turnID });
  await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^IDE/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(resume).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".factory/screenshots/usage-limits/coding-pause-narrow.png" });
});

test("a queued first Build shows preparation after reconnect, not active implementation or correction results", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const changeID = crypto.randomUUID();
  const turnID = crypto.randomUUID();
  const commandID = crypto.randomUUID();
  const errors: string[] = [];
  let working = false;
  let executionWrites = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:implement|start|message|retry|prompt)$/.test(new URL(request.url()).pathname)
    )
      executionWrites++;
  });
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-preparing",
              baseSha: "a".repeat(40),
              state: working ? "active" : "starting",
              branchState: "succeeded",
              runtimeState: working ? "ready" : "create-intended",
              implementationState: working ? "working" : "starting",
              buildTurnState: working ? "running" : "pending",
            },
          ],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async () => ({
      state: working ? "working" : "starting",
      sessionAvailable: working,
      runtimeConnected: working,
      messagesAvailable: true,
      messages: [],
      stopPending: false,
      stopId: null,
      turn: {
        id: turnID,
        commandId: commandID,
        mode: "build",
        engine: "opencode",
        modelId: "owned-coding-model",
        codingReasoning: "medium",
        skills: [],
        state: working ? "running" : "pending",
      },
    }),
    { activity: true },
  );
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  const open = async () => {
    await selectProject(page);
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .click();
  };
  await open();
  const summary = page.locator(".ticket-checks > summary");
  await expect(summary).toHaveText("Preparing implementation");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "Work starts automatically when preparation finishes. Your requirements and existing code are retained.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Earlier check results do not approve these corrections."),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Stop implementation", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const captures = ".factory/test-results/implementation-preparation";
  await mkdir(captures, { recursive: true });
  await page.screenshot({ path: `${captures}/pending-wide.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${captures}/pending-narrow.png` });
  await page.reload();
  await open();
  await expect(summary).toHaveText("Preparing implementation");
  working = true;
  await expect(summary).toHaveText("Implementation in progress");
  await summary.click();
  await expect(
    page.getByText(
      "The coding agent is implementing the approved requirements. Checks and independent review follow source submission.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Earlier check results do not approve these corrections."),
  ).toHaveCount(0);
  await page.screenshot({ path: `${captures}/working-narrow.png` });
  await expect(page.getByText("Updates paused. Showing the last known state.")).toHaveCount(0);
  expect(executionWrites).toBe(0);
  expect(errors).toEqual([]);
});

test("a submitted stopped candidate resumes checks explicitly, with stable retries and no implementation request", async ({
  page,
}) => {
  const changeID = crypto.randomUUID();
  const verificationID = crypto.randomUUID();
  const stopID = crypto.randomUUID();
  const requests: unknown[] = [];
  const implementationRequests: string[] = [];
  let resumed = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/agent\/(?:start|prompt)$/.test(request.url()))
      implementationRequests.push(request.url());
  });
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-stopped",
              baseSha: "a".repeat(40),
              state: "active",
              branchState: "succeeded",
              implementationState: resumed ? "committed" : "stopped",
              buildTurnState: "completed",
            },
          ],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async () => ({
      state: resumed ? "committed" : "stopped",
      sessionAvailable: true,
      runtimeConnected: false,
      messagesAvailable: true,
      messages: [],
      stopPending: false,
      stopId: null,
    }),
    { activity: true },
  );
  const delivery = () => ({
    verificationId: verificationID,
    verificationCommitSha: "b".repeat(40),
    verificationState: "runner-starting",
    ...(!resumed ? { checksStopId: stopID } : {}),
  });
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse(delivery());
      },
    },
  });
  await mockFactoryFunctions(
    page,
    {
      delivery: {
        async resumeChecks(_actor, id, input) {
          expect(id).toBe(changeID);
          requests.push(input);
          if (requests.length > 1) resumed = true;
          return deliveryViewSchema.parse(delivery());
        },
      },
    },
    (name) => name === "resumeVerification" && requests.length === 1,
  );
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  const resume = page.getByRole("button", { name: "Resume checks", exact: true });
  await expect(resume).toBeEnabled();
  const summary = page.locator(".ticket-checks > summary");
  await expect(summary).toContainText("Checks paused");
  await expect(summary.locator(".busy")).toHaveCount(0);
  await summary.click();
  await expect(
    page.getByText("The submitted version is retained.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Corrections not submitted", { exact: true })).toHaveCount(0);
  const captures = ".factory/test-results/checks-resume";
  await mkdir(captures, { recursive: true });
  await page.screenshot({ path: `${captures}/paused-wide.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(resume).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${captures}/paused-narrow.png` });
  expect(requests).toEqual([]);
  await resume.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await resume.click();
  await expect(summary).toHaveText("Preparing checks");
  await expect(resume).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ verificationId: verificationID, stopId: stopID });
  expect(implementationRequests).toEqual([]);
});

test("Implement is one explicit recoverable action and does not open IDE or Assistant", async ({
  page,
}) => {
  const requests: Array<{ commandId: string; revisionId: string }> = [];
  await mockFactoryFunctions(
    page,
    {
      tickets: {
        async implement(_actor, _id, input) {
          requests.push(input);
          return { id: crypto.randomUUID() };
        },
      },
    },
    (name) => name === "implementTicket" && requests.length === 1,
  );
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start Change", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Implement", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Implement", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]?.revisionId).toBe(revisionID);
  await expect(page.getByRole("region", { name: "Agent panel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^IDE/ })).toHaveCount(0);
  await expect(page.locator(".ticket-metadata")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Ticket Epic" })).toHaveCount(0);
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Assign to Epic…", exact: true })).toBeVisible();
  await expect(page.locator(".ticket-action-menu select")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Specification summary", exact: true })
    .click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole("combobox", { name: "Ticket Epic" })).toHaveCount(0);
});

test("developer Coding options choose reasoning before the normal atomic Implement command and retain a lost response", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: Array<{
    commandId: string;
    revisionId: string;
    codingReasoning?: string | undefined;
  }> = [];
  const codingTitle =
    "Implement the staff support inbox with personal request tracking, open and done filters, keyboard access, and safe account switching";
  const fixtureDatabase = createDatabase(1);
  try {
    await fixtureDatabase.client`UPDATE factory.ticket SET title=${codingTitle} WHERE id=${ticketID}`;
  } finally {
    await fixtureDatabase.client.end();
  }
  const sessionSnapshot = await browserBootstrap(page);
  const configuration = await serverCall(browserFunction(page, "getProjectModels", [projectID]));
  configuration.system.connection.buildProvider = "openai";
  configuration.system.rules.build.reasoningEffort = "medium";
  configuration.effective.build.modelId = "gpt-6.1-sol";
  await mockBootstrap(page, () => ({ ...sessionSnapshot, modelRelayConfigured: true }));
  await mockFactoryFunctions(page, { models: { inherited: async () => configuration } });
  await mockFactoryFunctions(
    page,
    {
      tickets: {
        async implement(_actor, _id, input) {
          requests.push(input);
          return { id: crypto.randomUUID() };
        },
      },
    },
    (name) => name === "implementTicket" && requests.length === 1,
  );
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  async function openOptions() {
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Coding options…", exact: true })
      .click({ timeout: 3_000 });
  }
  await openOptions();
  const panel = page.locator(".agent-panel");
  const reasoning = panel.getByLabel("Reasoning", { exact: true });
  await expect(reasoning).toBeEnabled({ timeout: 3_000 });
  await expect(panel.locator(".agent-implementation-title")).toHaveText(codingTitle);
  await expect(panel.locator(".agent-implementation-title")).toHaveAttribute("title", codingTitle);
  await expect(panel).toContainText("Start approves this specification and begins implementation.");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
  await panel.getByRole("button", { name: "Back to conversation", exact: true }).click();
  await expect(reasoning).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  await openOptions();
  await expect(reasoning).toBeEnabled();
  await reasoning.selectOption("high");
  const toolbar = panel.locator(".agent-compose-toolbar");
  const start = toolbar.getByRole("button", { name: "Start implementation", exact: true });
  await expect(start).toBeEnabled();
  await expect(toolbar.locator("button")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
  await mkdir(".factory/test-results/implementation-options", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/implementation-options/before-start-wide.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(start).toBeVisible();
  const positions = await toolbar.evaluate((element) => {
    const selection = element.querySelector("select");
    const button = element.querySelector("button");
    if (!selection || !button) return {};
    const select = selection.getBoundingClientRect();
    const action = button.getBoundingClientRect();
    return { before: select.right <= action.left, sameLine: Math.abs(select.y - action.y) < 8 };
  });
  expect(positions).toEqual({ before: true, sameLine: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".factory/test-results/implementation-options/before-start-narrow.png",
  });
  await start.click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(reasoning).toHaveValue("high");
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  await openOptions();
  await expect(reasoning).toHaveValue("high");
  expect(requests).toHaveLength(1);
  await start.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ revisionId: revisionID, codingReasoning: "high" });
  await expect(start).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^IDE/ })).toHaveCount(0);
  const db = createDatabase(1);
  try {
    expect(
      await db.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(await db.client`SELECT id FROM factory.change WHERE ticket_id=${ticketID}`).toHaveLength(
      0,
    );
  } finally {
    await db.client.end();
  }
  expect(errors).toEqual([]);
});

test("an admitted Coding-options request with a lost response reconnects to its exact Build without sending again", async ({
  page,
}) => {
  test.setTimeout(40_000);
  const changeID = crypto.randomUUID();
  const turnID = crypto.randomUUID();
  const requests: Array<{ commandId: string; codingReasoning: string }> = [];
  let admitted = false;
  const session = await browserBootstrap(page);
  const configuration = await serverCall(browserFunction(page, "getProjectModels", [projectID]));
  configuration.system.connection.buildProvider = "openai";
  configuration.effective.build.modelId = "gpt-6.1-sol";
  await mockBootstrap(page, () => ({ ...session, modelRelayConfigured: true }));
  await mockFactoryFunctions(page, { models: { inherited: async () => configuration } });
  await mockFactoryFunctions(
    page,
    {
      tickets: {
        async implement(_actor, _id, input) {
          if (!input.codingReasoning) throw new Error("Expected the selected reasoning");
          requests.push({ ...input, codingReasoning: input.codingReasoning });
          admitted = true;
          return { id: changeID };
        },
      },
    },
    (name) => name === "implementTicket",
  );
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: admitted
            ? [
                {
                  id: changeID,
                  projectId: projectID,
                  ticketId: ticketID,
                  branchName: "factory/owned-options-recovery",
                  baseSha: "a".repeat(40),
                  state: "starting",
                  branchState: "succeeded",
                  runtimeState: "starting",
                  implementationState: "starting",
                  buildTurnState: "pending",
                },
              ]
            : [],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async () => ({
      state: "starting",
      sessionAvailable: false,
      runtimeConnected: false,
      messagesAvailable: true,
      messages: [],
      stopPending: false,
      stopId: null,
      turn: {
        id: turnID,
        commandId: requests[0]?.commandId,
        engine: "opencode",
        mode: "build",
        modelId: "gpt-6.1-sol",
        codingReasoning: "high",
        state: "pending",
        skills: [],
      },
    }),
    { activity: true },
  );
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Coding options…", exact: true }).click();
  const panel = page.locator(".agent-panel");
  const reasoning = panel.getByLabel("Reasoning", { exact: true });
  await expect(reasoning).toBeEnabled();
  await reasoning.selectOption("high");
  await panel.getByRole("button", { name: "Start implementation", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(reasoning).toBeVisible({ timeout: 10_000 });
  await expect(reasoning).toBeDisabled({ timeout: 10_000 });
  await expect(reasoning).toHaveValue("high");
  await expect(panel.getByRole("button", { name: "Stop OpenCode", exact: true })).toBeVisible();
  await expect(reasoning).toBeVisible({ timeout: 3_000 });
  await expect(reasoning).toBeDisabled();
  await expect(reasoning).toHaveValue("high");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Start implementation", exact: true }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await page.screenshot({
    path: ".factory/test-results/implementation-options/confirmed-after-lost-response.png",
  });
});

test("an implementing Ticket never offers another Implement while its Change read is delayed", async ({
  page,
}) => {
  const release = Promise.withResolvers<void>();
  const db = createDatabase(1);
  try {
    await db.client`UPDATE factory.ticket SET state='in-progress' WHERE id=${ticketID}`;
    await mockFactoryFunctions(page, {
      runtime: {
        changes: async (_actor, _factoryTargetID) => {
          await release.promise;
          return changesResponseSchema.parse({ changes: [] });
        },
      },
    });
    await selectProject(page);
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .click();
    await expect(
      page.getByRole("textbox", { name: "Specification summary", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Implement", exact: true })).toHaveCount(0, {
      timeout: 3_000,
    });
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await db.client.end();
  }
});

test("a failed Sandbox leaves an explicit implementation retry in the Change Agent", async ({
  page,
}) => {
  const changeID = crypto.randomUUID();
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-failed",
              baseSha: "a".repeat(40),
              state: "failed",
              branchState: "succeeded",
              runtimeState: "failed",
              implementationState: "failed",
              buildTurnState: "failed",
            },
          ],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async () => ({
      state: "failed",
      sessionAvailable: true,
      runtimeConnected: false,
      messagesAvailable: true,
      messages: [],
      stopPending: false,
      stopId: null,
      lastError: "Owned Sandbox startup failed",
    }),
    { activity: true },
  );
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await mockFactoryFunctions(page, {
    writer: {
      status: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{ state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
        }),
      observe: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{ state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
        }),
    },
  });
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry implementation", exact: true }),
  ).toBeEnabled();
  const toolbar = page.locator(".agent-panel .agent-compose-toolbar");
  await expect
    .poll(() =>
      toolbar.evaluate((element) => {
        const retry = element.querySelector<HTMLButtonElement>(
          '[aria-label="Retry implementation"]',
        );
        if (!retry) return Number.POSITIVE_INFINITY;
        return Math.abs(
          element.getBoundingClientRect().right - retry.getBoundingClientRect().right,
        );
      }),
    )
    .toBeLessThanOrEqual(2);
  await expect(
    page.locator(".agent-panel").getByRole("button", { name: "Send message", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".agent-panel").getByLabel("Message conversation")).toHaveCount(0);
});

test("chat selects reasoning for the first Build, then shows the admitted value and only one execution action", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const changeID = crypto.randomUUID();
  const turnID = crypto.randomUUID();
  let state = "idle";
  let configurationReads = 0;
  let agentReads = 0;
  const firstObservation = Promise.withResolvers<void>();
  let holdingFirstObservation = true;
  let commandId: string = crypto.randomUUID();
  const starts: Array<{ commandId: string; codingReasoning?: string | undefined }> = [];
  const view = () => ({
    state,
    sessionAvailable: state !== "idle",
    runtimeConnected: true,
    messagesAvailable: true,
    messages: [],
    stopPending: false,
    stopId: null,
    ...(state === "idle"
      ? {}
      : {
          turn: {
            id: turnID,
            commandId,
            engine: "opencode",
            mode: "build",
            modelId: "gpt-6.1-sol",
            codingReasoning: "high",
            state: state === "working" ? "running" : state === "waiting" ? "completed" : "stopped",
            skills: [],
          },
        }),
  });
  const sessionSnapshot = await browserBootstrap(page);
  const configurationSnapshot = await serverCall(
    browserFunction(page, "getProjectModels", [projectID]),
  );
  configurationSnapshot.system.connection.buildProvider = "openai";
  configurationSnapshot.system.rules.build.reasoningEffort = "medium";
  configurationSnapshot.effective.build.modelId = "gpt-6.1-sol";
  await mockBootstrap(page, () => ({ ...sessionSnapshot, modelRelayConfigured: true }));
  await mockFactoryFunctions(page, {
    models: {
      inherited: async () => {
        configurationReads++;
        return configurationSnapshot;
      },
    },
  });
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-reasoning",
              baseSha: "a".repeat(40),
              state: "active",
              branchState: "succeeded",
              runtimeState: "ready",
              implementationState: state,
              buildTurnState:
                state === "idle" ? undefined : state === "working" ? "running" : "stopped",
            },
          ],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async (_factoryTargetID, _factoryHistory) => {
      agentReads++;
      if (holdingFirstObservation) await firstObservation.promise;
      return agentViewSchema.parse(view());
    },
    { activity: true },
  );
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await mockFactoryFunctions(page, {
    writer: {
      status: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{ state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
        }),
      observe: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{ state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
        }),
    },
  });
  await mockFactoryFunctions(page, {
    conversations: {
      mode: async () =>
        conversationViewSchema.parse({
          id: crypto.randomUUID(),
          projectId: projectID,
          ticketId: ticketID,
          mode: "build",
          version: 1,
          entries: [],
        }),
    },
  });
  await mockFactoryFunctions(page, {
    agent: {
      start: async (_actor, _factoryTargetID, factoryCommand) => {
        const input = factoryCommand;
        starts.push(input);
        if (starts.length === 1)
          return (() => {
            throw new Error("Controlled lost response");
          })();
        commandId = input.commandId;
        state = "working";
        return agentViewSchema.parse(view());
      },
    },
  });
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  const panel = page.locator(".agent-panel");
  const reasoning = panel.getByLabel("Reasoning", { exact: true });
  try {
    await expect(panel.locator(".agent-state")).toHaveText("Loading implementation…", {
      timeout: 2000,
    });
    await expect(
      panel.getByRole("button", { name: "Start implementation", exact: true }),
    ).toBeDisabled();
    await expect(reasoning).toHaveCount(0);
  } finally {
    holdingFirstObservation = false;
    firstObservation.resolve();
  }
  await expect(reasoning).toBeEnabled();
  await expect(reasoning.locator("option:checked")).toHaveText(/gpt-6.1-sol.*Medium.*default/, {
    timeout: 3000,
  });
  await reasoning.selectOption("high");
  await expect(
    panel.getByRole("button", { name: "Start implementation", exact: true }),
  ).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
  async function expectToolbar(action: string) {
    const composer = panel.locator(".agent-composer");
    const toolbar = panel.locator(".agent-compose-toolbar");
    const button = toolbar.getByRole("button", { name: action, exact: true });
    await expect(button).toBeVisible();
    await expect
      .poll(() =>
        composer.evaluate((element) => {
          const selection = element.querySelector("select")?.getBoundingClientRect();
          const action = element.querySelector(".composer-actions button")?.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          const padding = Number.parseFloat(getComputedStyle(element).paddingRight);
          const hasDraft = !!element.querySelector("textarea");
          return selection && action
            ? {
                selectionPositionCorrect: hasDraft
                  ? selection.bottom <= action.top
                  : Math.abs(selection.y + selection.height / 2 - action.y - action.height / 2) <=
                      2 && selection.right <= action.x,
                actionAtRight: Math.abs(bounds.right - padding - action.right) <= 2,
              }
            : {};
        }),
      )
      .toEqual({ selectionPositionCorrect: true, actionAtRight: true });
    expect(await toolbar.locator("button").count()).toBe(1);
  }
  await expectToolbar("Start implementation");
  await mkdir(".factory/test-results/implementation-journey", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/chat-reasoning-start.png",
  });
  await panel.getByRole("button", { name: "Start implementation", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  await expect(
    panel.getByRole("button", { name: "Start implementation", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  await expect(reasoning).toHaveValue("high");
  expect(starts).toHaveLength(1);
  await panel.getByRole("button", { name: "Start implementation", exact: true }).click();
  await expect.poll(() => starts.length).toBe(2);
  await expect(reasoning).toBeDisabled();
  await expect(reasoning).toHaveValue("high");
  expect(starts).toEqual([
    { commandId: expect.any(String), codingReasoning: "high" },
    { commandId: starts[0]?.commandId, codingReasoning: "high" },
  ]);
  await expect(
    panel.getByRole("button", { name: "Start implementation", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Stop OpenCode", exact: true })).toHaveCount(1);
  await expectToolbar("Stop OpenCode");
  state = "stopped";
  await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeEnabled({
    timeout: 10000,
  });
  await expect(reasoning).toHaveValue("high");
  await expect(reasoning).toBeDisabled();
  await expect(panel).toContainText("Fixed for this Change.");
  await expectToolbar("Send message");
  await panel.getByLabel("Message conversation").focus();
  await expect(panel.locator(".agent-input-shell")).toHaveCSS("outline-style", "solid");
  await expect(panel.locator(".agent-input-shell")).toHaveCSS("outline-width", "2px");
  const inputBox = await panel.getByLabel("Message conversation").boundingBox();
  const inputWidth = await panel.locator(".agent-composer").evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight)
    );
  });
  expect(inputBox && inputBox.width >= inputWidth - 2).toBe(true);
  await expect(
    panel.getByRole("button", { name: "Retry implementation", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/chat-reasoning-retained.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reasoning).toBeVisible();
  await expectToolbar("Send message");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/chat-reasoning-narrow.png",
  });
  state = "waiting";
  await expect(panel.locator(".agent-state")).toHaveText("Needs input");
  await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Stop OpenCode", exact: true })).toHaveCount(0);
  await expectToolbar("Send message");
  const readsBeforePolling = configurationReads;
  const observedBeforePolling = agentReads;
  await expect.poll(() => agentReads).toBeGreaterThan(observedBeforePolling + 1);
  expect(configurationReads).toBe(readsBeforePolling);
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/chat-waiting-for-instructions.png",
  });
  await page.unrouteAll({ behavior: "wait" });
  expect(errors).toEqual([]);
});

for (const role of ["developer", "product-contributor"] as const) {
  test(`the ${role} sees model controls only with developer access in Coding`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const password = "owned-coding-model-scope-password";
    const email = `coding-model-${projectID}@factory.local`;
    const user = await serverCall(
      browserFunction(page, "createAccount", [{ name: `Coding model ${role}`, email, password }]),
    );
    const context = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const member = await context.newPage();
    const errors: string[] = [];
    member.on("pageerror", (error) => errors.push(error.message));
    const changeID = crypto.randomUUID();
    const turnID = crypto.randomUUID();
    const commandID = crypto.randomUUID();
    let hasChange = false;
    try {
      const membership = await browserFunction(page, "saveProjectMember", [
        projectID,
        // Managing a Project does not grant developer access.
        { email, role, manageProject: role === "product-contributor" },
      ]);
      expect(membership.ok).toBe(true);
      await mockFactoryFunctions(member, {
        workspaces: {
          async ensurePersonalSource() {
            throw new CommandError("unavailable", "No runtime in model control fixture");
          },
          async ensureEditor() {
            throw new CommandError("unavailable", "No runtime in model control fixture");
          },
        },
      });
      await mockFactoryFunctions(member, {
        runtime: {
          changes: async () =>
            changesResponseSchema.parse({
              changes: hasChange
                ? [
                    {
                      id: changeID,
                      projectId: projectID,
                      ticketId: ticketID,
                      branchName: "factory/owned-model-scope",
                      baseSha: "a".repeat(40),
                      state: "active",
                      branchState: "succeeded",
                      verificationState: "succeeded",
                      implementationState: "committed",
                      buildTurnState: "completed",
                    },
                  ]
                : [],
            }),
        },
      });
      await mockAgentView(
        member,
        changeID,
        async () => ({
          state: "committed",
          sessionAvailable: true,
          runtimeConnected: false,
          messagesAvailable: true,
          messages: [],
          stopPending: false,
          stopId: null,
          turn: {
            id: turnID,
            commandId: commandID,
            engine: "opencode",
            mode: "build",
            modelId: "gpt-6.1-sol",
            codingReasoning: "medium",
            state: "completed",
            skills: [],
          },
        }),
        { activity: true },
      );
      await mockFactoryFunctions(member, {
        delivery: {
          async get(_actor, id) {
            if (id !== changeID) return serverCall(browserFunction(member, "getDelivery", [id]));
            return deliveryViewSchema.parse({});
          },
        },
      });
      await mockFactoryFunctions(member, {
        review: {
          get: async () =>
            visualReviewSchema.parse({
              feedback: [],
              recording: null,
              scenarios: [],
            }),
        },
      });
      await member.goto("/");
      await member.getByLabel("Email", { exact: true }).fill(email);
      await member.getByLabel("Password", { exact: true }).fill(password);
      await member.getByRole("button", { name: "Sign in", exact: true }).click();
      await selectProject(member);
      await member
        .getByRole("region", { name: "requirements", exact: true })
        .locator(".ticket-card-body")
        .click();
      await member.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
      const panel = member.locator(".agent-panel");
      const controls = panel.locator(".agent-model-controls");
      await expect(panel.getByLabel("Message conversation", { exact: true })).toHaveAttribute(
        "placeholder",
        "Clarify this Ticket's requirements…",
      );
      await expect(controls).toHaveCount(0);
      await member.getByRole("button", { name: "Ticket actions", exact: true }).click();
      await expect(
        member.getByRole("menuitem", { name: "Coding options…", exact: true }),
      ).toHaveCount(role === "developer" ? 1 : 0);
      await member.getByRole("button", { name: "Ticket actions", exact: true }).click();
      const evidence = ".factory/test-results/coding-model-scope";
      await mkdir(evidence, { recursive: true });
      await member.screenshot({ path: `${evidence}/${role}-plan.png` });
      hasChange = true;
      await member.reload();
      await selectProject(member);
      await member.getByRole("region", { name: "review", exact: true }).getByRole("button").click();
      await member.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
      await expect(panel.getByLabel("Message conversation", { exact: true })).toHaveAttribute(
        "placeholder",
        "Ask about this Ticket…",
      );
      await expect(controls).toHaveCount(0);
      await member.screenshot({ path: `${evidence}/${role}-investigate.png` });
      await expect(
        member.getByRole("button", { name: "Request changes", exact: true }),
      ).toHaveCount(0);
      await member.getByRole("button", { name: "Add feedback", exact: true }).click();
      const composer = member.getByRole("form", { name: "Add review feedback" });
      await composer
        .getByRole("textbox", { name: "Review comment" })
        .fill("Keep the first action clear.");
      await composer.getByRole("combobox", { name: "Feedback type" }).selectOption("thread");
      await expect(controls).toHaveCount(0);
      await expect(composer.getByRole("combobox")).toHaveCount(1);
      await expect(
        composer.getByRole("button", { name: "Save feedback", exact: true }),
      ).toBeEnabled();
      if (role !== "developer")
        await expect(member.getByRole("menuitem", { name: "Open IDE", exact: true })).toHaveCount(
          0,
        );
      await member.screenshot({ path: `${evidence}/${role}-review-feedback.png` });
      await member.setViewportSize({ width: 390, height: 844 });
      await expect(
        composer.getByRole("button", { name: "Save feedback", exact: true }),
      ).toBeVisible();
      expect(await member.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await member.screenshot({ path: `${evidence}/${role}-review-feedback-narrow.png` });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await deleteFactoryProject(projectID);
      projectID = "";
      const db = createDatabase(1);
      try {
        await db.client.begin(async (sql) => {
          await sql`DELETE FROM factory.forge_grant_intent WHERE user_id=${user.id}`;
          await sql`DELETE FROM auth.account WHERE user_id=${user.id}`;
          await sql`DELETE FROM factory.forge_account_intent WHERE user_id=${user.id}`;
          await sql`DELETE FROM factory.developer_ide WHERE user_id=${user.id} AND state='stopped'`;
          await sql`DELETE FROM auth."user" WHERE id=${user.id} AND email=${email}
            AND NOT EXISTS(SELECT 1 FROM factory.project_membership WHERE user_id=${user.id})`;
        });
      } finally {
        await db.client.end();
      }
    }
  });
}

test("tool activity is one collapsed line, keyboard expandable and compact at narrow widths", async ({
  page,
}) => {
  const changeID = crypto.randomUUID();
  const command = "node --test src/support/lifecycle.test.mjs ".repeat(8);
  const output = Array.from({ length: 80 }, (_, index) => `Test ${index + 1} passed`).join("\n");
  await mockFactoryFunctions(page, {
    writer: {
      status: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{ state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
        }),
      observe: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{ state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
        }),
    },
  });
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-tool-ui",
              baseSha: "a".repeat(40),
              state: "failed",
              branchState: "succeeded",
              runtimeState: "failed",
              implementationState: "failed",
              buildTurnState: "failed",
            },
          ],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async () => ({
      state: "failed",
      sessionAvailable: true,
      runtimeConnected: false,
      messagesAvailable: true,
      messages: [
        {
          id: "owned-tool-one",
          role: "tool",
          text: command,
          at: Date.now(),
          activity: { name: "shell", status: "completed", detail: output },
        },
        {
          id: "owned-tool-two",
          role: "tool",
          text: "Read src/web.tsx",
          at: Date.now() + 1,
          activity: { name: "read", status: "completed" },
        },
        {
          id: "owned-tool-three",
          role: "tool",
          text: "node --test invalid.mjs",
          at: Date.now() + 2,
          activity: {
            name: "shell",
            status: "error",
            detail: "The named test file was not found.",
          },
        },
      ],
      stopPending: false,
      stopId: null,
      lastError: "Owned stopped UI fixture",
    }),
    { activity: true },
  );
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  const rows = page.locator("details.agent-activity");
  await expect(rows).toHaveCount(3);
  const group = page.getByRole("region", { name: "Grouped tool activity" });
  const expandActivities = group.getByRole("button", { name: /2 commands · 1 file read/ });
  await expect(expandActivities).toHaveAttribute("aria-expanded", "false");
  await expect(rows.first()).toBeHidden();
  await expect(rows.last()).toBeVisible();
  await expandActivities.click();
  const row = rows.first();
  const summary = row.locator("summary");
  await expect(row).not.toHaveAttribute("open");
  await expect(row.locator(".activity-output")).toBeHidden();
  const collapsed = await row.boundingBox();
  expect(collapsed?.height).toBeLessThanOrEqual(32);
  expect(
    await row
      .locator(".activity-command")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("open", "");
  await expect(row.locator(".activity-command-full")).toHaveText(command.trim());
  await expect(row.locator(".activity-output")).toBeVisible();
  expect(
    await row
      .locator(".activity-output")
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await mkdir(".factory/test-results/implementation-journey", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/tool-expanded-wide.png",
  });
  await page.keyboard.press("Space");
  await expect(row).not.toHaveAttribute("open");
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/tool-collapsed-wide.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary).toBeVisible();
  await expect(summary).toHaveCSS("min-height", "44px");
  expect((await row.boundingBox())?.height).toBe(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/tool-collapsed-narrow.png",
  });
  await summary.click();
  await expect(row.locator(".activity-output")).toBeVisible();
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/tool-expanded-narrow.png",
  });
});

test("Coding uses one live read, reconciles reconnects without duplicates, and detaches a closed panel", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const changeID = crypto.randomUUID();
  const view: AgentView = {
    state: "failed",
    runtimeState: "ready",
    sessionAvailable: true,
    runtimeConnected: true,
    messagesAvailable: true,
    stopPending: false,
    stopId: null,
    messages: [
      {
        id: "assistant_owned:tool:call_owned",
        role: "tool",
        text: "bun test",
        at: 1,
        activity: { name: "shell", status: "running" },
      },
    ],
  };
  const stream = await streamedAgentView(view);
  let statusReads = 0;
  let mutations = 0;
  page.on("request", (request) => {
    if (
      /\/_server\/data\/(?:startCoding|resumeCoding|stopCoding|checkCodingStop|newCodingConversation|sendCodingPrompt|requestCodingChanges)-/.test(
        request.url(),
      )
    )
      mutations++;
  });
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-stream",
              baseSha: "a".repeat(40),
              state: "active",
              branchState: "succeeded",
              implementationState: "failed",
              buildTurnState: "failed",
              runtimeState: "ready",
            },
          ],
        }),
    },
  });
  await mockAgentView(
    page,
    changeID,
    async (_factoryTargetID, _factoryHistory) => {
      statusReads++;
      return agentViewSchema.parse(view);
    },
    { activity: false },
  );
  await mockFactoryFunctions(page, { agent: { activity: stream.activity } });
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await mockFactoryFunctions(page, {
    writer: {
      status: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{
            state: "agent",
            epoch: 1,
            canWrite: false,
            yours: false,
            commandID: null,
          },
        }),
      observe: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{
            state: "agent",
            epoch: 1,
            canWrite: false,
            yours: false,
            commandID: null,
          },
        }),
    },
  });
  const workspaceID = crypto.randomUUID();
  const source = {
    workspaceID,
    serviceID: "owned-live-activity",
    epoch: 1,
    state: "preparing",
    failure: null,
  };
  await mockFactoryFunctions(page, {
    workspaces: {
      ensureChangeSource: async () => ({
        label: "Owned source",
        ...sourceWorkspaceViewSchema.parse(source),
      }),
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      getSource: async () => ({
        label: "Owned source",
        ...sourceWorkspaceViewSchema.parse(source),
      }),
    },
  });
  try {
    await selectProject(page);
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const rows = page.locator("details.agent-activity");
    await expect.poll(stream.requests).toBe(1);
    await expect(rows).toHaveCount(1);
    const reads = statusReads;
    await page.waitForTimeout(1_200);
    expect(stream.requests()).toBe(1);
    expect(statusReads).toBe(reads);
    const message = view.messages[0];
    if (!message) throw new Error("Owned tool activity missing");
    const completed: AgentView = {
      ...view,
      messages: [
        {
          ...message,
          activity: { name: "shell", status: "completed", detail: "12 passed" },
        },
      ],
    };
    stream.publish(completed);
    stream.publish(completed);
    await expect(rows).toHaveCount(1);
    await rows.locator("summary").click();
    await expect(rows.locator(".activity-output")).toHaveText("12 passed");
    await mkdir(".factory/test-results/opencode-integration-fix-20261019", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/opencode-integration-fix-20261019/live-tool-wide.png",
    });
    stream.disconnect();
    await expect.poll(stream.requests).toBe(2);
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute("open", "");
    await expect(rows.locator(".activity-output")).toHaveText("12 passed");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".factory/test-results/opencode-integration-fix-20261019/live-tool-reconnected-narrow.png",
    });
    await page.getByRole("button", { name: "Minimize Agent panel", exact: true }).click();
    await expect.poll(stream.readers).toBe(0);
    expect(mutations).toBe(0);
  } finally {
    await stream.dispose();
  }
});

test("returning to the same Ticket keeps its retained Coding stream observable", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const changeID = crypto.randomUUID();
  const contextID = crypto.randomUUID();
  const database = createDatabase(1);
  try {
    await database.client`UPDATE factory.ticket SET state='in-progress' WHERE id=${ticketID}`;
  } finally {
    await database.client.end();
  }
  await mockFactoryFunctions(page, {
    conversations: {
      get: async () =>
        conversationViewSchema.nullable().parse(
          conversationViewSchema.parse({
            id: contextID,
            projectId: projectID,
            ticketId: ticketID,
            mode: "build",
            version: 1,
            entries: [],
            contextId: contextID,
            activeCodingContextId: contextID,
            isActiveCoding: true,
            contexts: [
              {
                id: contextID,
                kind: "coding",
                title: "Original Coding",
                ordinal: 1,
                original: true,
                createdAt: new Date(0).toISOString(),
              },
            ],
          }),
        ),
    },
  });
  const view: AgentView = {
    state: "waiting",
    runtimeState: "ready",
    sessionAvailable: true,
    runtimeConnected: true,
    messagesAvailable: true,
    stopPending: false,
    stopId: null,
    commitOperation: {
      id: crypto.randomUUID(),
      state: "push-intended",
      lastError: "Owned Forge observation unavailable.",
    },
    messages: [
      {
        id: "retained-implementation",
        role: "assistant",
        text: "Retained implementation output.",
        at: 1,
      },
    ],
  };
  const stream = await streamedAgentView(view);
  let mutations = 0;
  page.on("request", (request) => {
    if (
      /\/_server\/data\/(?:startCoding|resumeCoding|stopCoding|checkCodingStop|newCodingConversation|sendCodingPrompt|requestCodingChanges)-/.test(
        request.url(),
      )
    )
      mutations++;
  });
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-retained-stream",
              baseSha: "a".repeat(40),
              state: "active",
              branchState: "succeeded",
              implementationState: "waiting",
              buildTurnState: "completed",
              runtimeState: "ready",
            },
          ],
        }),
    },
  });
  await mockAgentView(page, changeID, async () => view, { activity: false });
  await mockFactoryFunctions(page, { agent: { activity: stream.activity } });
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await mockFactoryFunctions(page, {
    writer: {
      status: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{
            state: "agent",
            epoch: 1,
            canWrite: false,
            yours: false,
            commandID: null,
          },
        }),
      observe: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{
            state: "agent",
            epoch: 1,
            canWrite: false,
            yours: false,
            commandID: null,
          },
        }),
    },
  });
  const workspaceID = crypto.randomUUID();
  const source = {
    workspaceID,
    serviceID: "owned-retained-activity",
    epoch: 1,
    state: "preparing",
    failure: null,
  };
  await mockFactoryFunctions(page, {
    workspaces: {
      ensureChangeSource: async () => ({
        label: "Owned source",
        ...sourceWorkspaceViewSchema.parse(source),
      }),
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      getSource: async () => ({
        label: "Owned source",
        ...sourceWorkspaceViewSchema.parse(source),
      }),
    },
  });
  try {
    await selectProject(page);
    const ticket = page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button");
    await ticket.click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await expect(page.getByText("Retained implementation output.", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Commit recovery" })).toBeVisible();
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await ticket.click();
    stream.publish({
      ...view,
      messages: [
        {
          id: "retained-after-return",
          role: "assistant",
          text: "The same Change remains observable after returning.",
          at: 2,
        },
      ],
    });
    await expect(
      page.getByText("The same Change remains observable after returning.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("status", { name: "Commit recovery" })).toBeVisible();
    await expect(page.getByText("Loading implementation…", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Specification summary", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect.poll(stream.readers).toBe(1);
    expect(mutations).toBe(0);
    await mkdir(".factory/test-results/retained-agent-stream", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/retained-agent-stream/returned-wide.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".factory/test-results/retained-agent-stream/returned-narrow.png",
    });
  } finally {
    await stream.dispose();
  }
});

test("admitted instructions remain visible before native dispatch and appear once after promotion", async ({
  page,
}) => {
  const changeID = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const text = "Repair the signed-in inbox lifecycle without losing this correction.";
  const admitted = {
    id: "msg_saved_correction",
    commandId,
    role: "user" as const,
    text,
    at: Date.now(),
  };
  const view: AgentView = {
    state: "failed",
    runtimeState: "stopped",
    sessionAvailable: true,
    runtimeConnected: false,
    messagesAvailable: false,
    messages: [],
    admittedMessages: [admitted],
    stopPending: false,
    stopId: null,
    lastError: "Source Pod is no longer ready",
  };
  const stream = await streamedAgentView(view);
  await mockFactoryFunctions(page, {
    runtime: {
      changes: async () =>
        changesResponseSchema.parse({
          changes: [
            {
              id: changeID,
              projectId: projectID,
              ticketId: ticketID,
              branchName: "factory/owned-input",
              baseSha: "a".repeat(40),
              state: "active",
              branchState: "succeeded",
              implementationState: "failed",
              buildTurnState: "failed",
              runtimeState: "stopped",
            },
          ],
        }),
    },
  });
  await mockAgentView(page, changeID, async () => view, { activity: false });
  await mockFactoryFunctions(page, { agent: { activity: stream.activity } });
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({});
      },
    },
  });
  await mockFactoryFunctions(page, {
    writer: {
      status: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{
            state: "agent",
            epoch: 1,
            canWrite: false,
            yours: false,
            commandID: null,
          },
        }),
      observe: async () =>
        writerViewSchema.parse({
          actor: null,
          requester: null,
          ...{
            state: "agent",
            epoch: 1,
            canWrite: false,
            yours: false,
            commandID: null,
          },
        }),
    },
  });
  try {
    await selectProject(page);
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const panel = page.locator(".agent-panel");
    await expect(panel.getByText(text, { exact: true })).toHaveCount(1);
    await expect(panel).toContainText("Activity will load when the Workspace resumes.");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await mkdir(".factory/test-results/opencode-integration-fix-20261019", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/opencode-integration-fix-20261019/admitted-input-retained.png",
    });
    stream.publish({
      ...view,
      state: "working",
      runtimeState: "ready",
      runtimeConnected: true,
      messagesAvailable: true,
      messages: [
        {
          id: admitted.id,
          role: "user",
          text: `${text}\nInternal injected native instructions.`,
          at: admitted.at + 1,
        },
      ],
    });
    await expect(panel.locator(".agent-state")).toHaveText("Working");
    await expect(panel.getByText(text, { exact: true })).toHaveCount(1);
    await expect(panel).not.toContainText("Internal injected native instructions.");
  } finally {
    await stream.dispose();
  }
});

test("a failed editor has an explicit restart that waits for confirmed Stop without restarting Apps or Build", async ({
  page,
}) => {
  let editorState: "failed" | "stop-intended" | "stopped" | "ready" = "failed";
  let ensures = 0;
  let stops = 0;
  const runtimeCommands: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(agent\/|ticket-workspace\/|personal-workspace\/|runtime\/)/.test(
        new URL(request.url()).pathname,
      )
    )
      runtimeCommands.push(new URL(request.url()).pathname);
  });
  const editor = () => ({
    serviceID: "owned-editor",
    epoch: editorState === "ready" ? 2 : 1,
    state: editorState,
    failure:
      editorState === "failed" ? "Editor preparation failed. Stop and retry the editor." : null,
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      async ensureEditor() {
        ensures++;
        if (editorState === "stopped") editorState = "ready";
        return developerIDEViewSchema.parse(editor());
      },
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: { getEditor: async () => developerIDEViewSchema.parse(editor()) },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      async stopEditor() {
        stops++;
        editorState = "stop-intended";
      },
    },
  });
  await page.route("**/api/developer-ide/access?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Owned recovered editor</body></html>",
    }),
  );
  await selectProject(page);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const restart = page.getByRole("button", { name: "Restart editor", exact: true });
  await expect(restart).toBeVisible();
  const initialEnsures = ensures;
  await mkdir(".factory/test-results/opencode-integration-fix-20261019", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/opencode-integration-fix-20261019/editor-restart-available.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".factory/test-results/opencode-integration-fix-20261019/editor-restart-narrow.png",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Unsaved editor changes may be lost");
    await dialog.accept();
  });
  await restart.click();
  await expect.poll(() => stops).toBe(1);
  await page.waitForTimeout(300);
  expect(ensures).toBe(initialEnsures);
  editorState = "stopped";
  await expect.poll(() => ensures).toBe(initialEnsures + 1);
  await expect(page.locator('iframe[title="Factory IDE"]')).toHaveAttribute(
    "data-editor-epoch",
    "2",
  );
  expect(runtimeCommands).toEqual([]);
});

test("slow valid editor and file preparation connects without a manual retry or restarting compute", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const workspaceID = crypto.randomUUID();
  const { session } = await browserBootstrap(page);
  const origin = developerIDEOrigin(new URL(page.url()).origin, session.user.id, 1);
  let prepared = false;
  let editorReads = 0;
  let sourceReads = 0;
  let editorEnsures = 0;
  const state = () => (prepared ? "ready" : "preparing");
  const editor = () => ({ serviceID: "owned-editor", epoch: 1, state: state(), failure: null });
  const source = () => ({
    workspaceID,
    serviceID: "owned-files",
    epoch: 1,
    state: state(),
    failure: null,
  });
  const runtimeCommands: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:runtime-attempts|agent|personal-workspace|ticket-workspace|developer-ide\/stop)\b/.test(
        new URL(request.url()).pathname,
      )
    )
      runtimeCommands.push(new URL(request.url()).pathname);
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => ({
        label: "Owned source",
        ...sourceWorkspaceViewSchema.parse(source()),
      }),
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      async getSource() {
        sourceReads++;
        return { label: "Owned source", ...sourceWorkspaceViewSchema.parse(source()) };
      },
      async ensureEditor() {
        editorEnsures++;
        return developerIDEViewSchema.parse(editor());
      },
      async getEditor() {
        editorReads++;
        return developerIDEViewSchema.parse(editor());
      },
    },
  });
  await page.route("**/api/developer-ide/access?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script>location.replace(${JSON.stringify(`${origin}/owned-editor`)})</script>`,
    }),
  );
  await page.route(`${origin}/owned-editor`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>Owned editor loading<script>
addEventListener("message", event => {
  if (event.data?.type === "factory:select-workspace")
    parent.postMessage({type:"factory:workspace-selected",workspaceID:event.data.workspaceID}, "*");
});
</script></body></html>`,
    }),
  );
  await selectProject(page);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect.poll(() => editorReads).toBeGreaterThan(0);
  await expect.poll(() => sourceReads).toBeGreaterThan(0);
  const initialEnsures = editorEnsures;
  // Advance the observation clock only. Advancing every browser timer would
  // also expire Zero's unrelated connection and clear the selected Project.
  await page.evaluate(() => {
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, "now", { value: () => now() + 160_001 });
  });
  await expect(page.getByText("Preparing your editor…", { exact: true })).toBeVisible({
    timeout: 2_000,
  });
  await expect(page.getByRole("button", { name: "Retry file access", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry editor connection", exact: true }),
  ).toHaveCount(0);
  await mkdir(".factory/test-results/editor-preparation", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/editor-preparation/slow-valid-preparation.png",
  });
  prepared = true;
  const iframe = page.locator('iframe[title="Factory IDE"]');
  await expect(iframe).toHaveAttribute("data-editor-epoch", "1");
  const editorFrame = page.frameLocator('iframe[title="Factory IDE"]');
  await expect(editorFrame.locator("body")).toHaveText("Owned editor loading");
  await expect(
    page.getByText("Your editor is still opening. You can wait or retry the connection."),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("The editor did not connect. Retry opening it.")).toHaveCount(0);
  await page.screenshot({
    path: ".factory/test-results/editor-preparation/slow-editor-connection.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".factory/test-results/editor-preparation/slow-editor-connection-narrow.png",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await editorFrame.locator("body").evaluate(() => {
    window.parent.postMessage({ type: "factory:ide-ready" }, "*");
  });
  await expect(iframe).toHaveAttribute("data-workspace-id", workspaceID);
  await expect(
    page.getByRole("button", { name: "Retry editor connection", exact: true }),
  ).toHaveCount(0);
  expect(editorEnsures).toBe(initialEnsures);
  expect(runtimeCommands).toEqual([]);
});

test("a failed editor Stop leaves restart unconfirmed without ensuring another epoch", async ({
  page,
}) => {
  let ensures = 0;
  let stops = 0;
  const editor = {
    serviceID: "owned-editor",
    epoch: 1,
    state: "failed",
    failure: "Editor preparation failed. Stop and retry the editor.",
  };
  await mockFactoryFunctions(page, {
    workspaces: {
      async ensureEditor() {
        ensures++;
        return developerIDEViewSchema.parse(editor);
      },
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: { getEditor: async () => developerIDEViewSchema.parse(editor) },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      async stopEditor() {
        stops++;
      },
    },
  });
  await selectProject(page);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const restart = page.getByRole("button", { name: "Restart editor", exact: true });
  await expect(restart).toBeVisible();
  const initialEnsures = ensures;
  page.once("dialog", (dialog) => dialog.dismiss());
  await restart.click();
  expect(stops).toBe(0);
  expect(ensures).toBe(initialEnsures);
  page.once("dialog", (dialog) => dialog.accept());
  await restart.click();
  await expect(
    page.getByText("Editor Stop was not confirmed. Nothing was restarted."),
  ).toBeVisible();
  expect(stops).toBe(1);
  expect(ensures).toBe(initialEnsures);
  await expect(restart).toBeEnabled();
});

for (const reviewState of ["incomplete", "stopped"] as const)
  test(`independent review retries its exact candidate after ${reviewState} without offering Delivery`, async ({
    page,
  }) => {
    const changeID = crypto.randomUUID();
    const reviewID = crypto.randomUUID();
    const initialCommandID = crypto.randomUUID();
    let request: { commandId: string; reviewId: string } | undefined;
    let running = false;
    const turnID = crypto.randomUUID();
    const change = () => ({
      id: changeID,
      projectId: projectID,
      ticketId: ticketID,
      branchName: "factory/owned-review",
      baseSha: "a".repeat(40),
      state: reviewState === "stopped" && !running ? "starting" : "active",
      runtimeState: reviewState === "stopped" && !running ? "stopped" : "ready",
      branchState: "succeeded",
      verificationState: "succeeded",
      implementationState: running
        ? "working"
        : reviewState === "stopped"
          ? "stopped"
          : "committed",
      buildTurnState: running ? "running" : reviewState === "stopped" ? "stopped" : "completed",
      buildTurnPurpose: "review",
    });
    const delivery = () => ({
      verificationState: "succeeded",
      reviewId: request?.commandId ?? reviewID,
      reviewState: running ? "running" : reviewState,
      reviewCurrent: true,
      reviewSummary: running
        ? "Checking the same submitted version."
        : "The declared App was unavailable. This review did not pass.",
    });
    const agent = () => ({
      state: running ? "working" : reviewState === "stopped" ? "stopped" : "committed",
      runtimeState: change().runtimeState,
      sessionAvailable: true,
      runtimeConnected: running || reviewState !== "stopped",
      messagesAvailable: running || reviewState !== "stopped",
      messages: [],
      stopPending: false,
      stopId: null,
      turn: {
        id: turnID,
        commandId: request?.commandId ?? initialCommandID,
        purpose: "review",
        mode: "build",
        engine: "opencode",
        modelId: "owned-coding-model",
        codingReasoning: "medium",
        skills: [],
        state: running ? "running" : reviewState === "stopped" ? "stopped" : "completed",
      },
    });
    await mockFactoryFunctions(page, {
      runtime: { changes: async () => changesResponseSchema.parse({ changes: [change()] }) },
    });
    await mockFactoryFunctions(page, {
      delivery: {
        async get(_actor, id) {
          if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
          return deliveryViewSchema.parse(delivery());
        },
      },
    });
    await mockAgentView(page, changeID, async () => agent(), { activity: true });
    await mockFactoryFunctions(page, {
      conversations: {
        get: async () =>
          conversationViewSchema.nullable().parse({
            id: crypto.randomUUID(),
            projectId: projectID,
            ticketId: ticketID,
            mode: "build",
            version: 1,
            entries: [],
          }),
      },
    });
    await mockFactoryFunctions(page, {
      delivery: {
        async retryReview(_actor, id, input) {
          expect(id).toBe(changeID);
          request = input;
          running = true;
          return deliveryViewSchema.parse(delivery());
        },
      },
    });
    await selectProject(page);
    await page.getByRole("region", { name: "review", exact: true }).getByRole("button").click();
    const retry = page.getByRole("button", { name: "Retry review", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByRole("button", { name: "Deliver", exact: true })).toHaveCount(0);
    await page.locator(".ticket-checks > summary").click();
    await expect(
      page.getByText("The declared App was unavailable. This review did not pass."),
    ).toBeVisible();
    await mkdir(".factory/test-results/reviewer-interface", { recursive: true });
    await page.screenshot({
      path: `.factory/test-results/reviewer-interface/factory-${reviewState}.png`,
    });
    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({
      path: `.factory/test-results/reviewer-interface/factory-${reviewState}-narrow.png`,
    });
    const bounds = await retry.boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 430).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      430,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await retry.click();
    await expect.poll(() => request?.reviewId).toBe(reviewID);
    expect(request?.commandId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(retry).toHaveCount(0);
    await expect(page.locator(".ticket-checks > summary")).toHaveText(
      "Independent review in progress",
    );
    await expect(page.getByRole("button", { name: "Deliver", exact: true })).toHaveCount(0);
    await page.screenshot({
      path: ".factory/test-results/reviewer-interface/factory-reviewing.png",
    });
    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({
      path: ".factory/test-results/reviewer-interface/factory-reviewing-narrow.png",
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      430,
    );
  });

test("Review corrections send to the retained Build without IDE; checks and controls remain compact", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const changeID = crypto.randomUUID();
  let received: { commandId: string; feedback: { id: string; version: number }[] } | undefined;
  let researchRequests = 0;
  let state = "committed";
  const feedback: ReviewFeedback[] = [];
  const { session } = await browserBootstrap(page);
  const agent = {
    state: "committed",
    sessionAvailable: true,
    runtimeConnected: true,
    messagesAvailable: true,
    messages: [],
    stopPending: false,
    stopId: null,
  };
  const change = {
    id: changeID,
    projectId: projectID,
    ticketId: ticketID,
    branchName: "factory/change-123456789abc",
    baseSha: "a".repeat(40),
    state: "active",
    branchState: "succeeded",
    verificationState: "succeeded",
    implementationState: "committed",
    buildTurnState: "completed",
  };
  const conversation = {
    id: crypto.randomUUID(),
    projectId: projectID,
    ticketId: ticketID,
    mode: "build",
    version: 1,
    entries: [],
  };
  await mockFactoryFunctions(page, {
    runtime: { changes: async () => changesResponseSchema.parse({ changes: [change] }) },
  });
  await mockAgentView(page, changeID, async () => ({ ...agent, state }), { activity: true });
  await mockFactoryFunctions(page, {
    review: {
      get: async () =>
        visualReviewSchema.parse({
          feedback,
          recording: null,
          scenarios: [],
          canSendCorrections: state === "committed",
        }),
    },
  });
  await mockFactoryFunctions(page, {
    review: {
      async create(_actor, _change, input) {
        const id = crypto.randomUUID();
        feedback.push({
          id,
          kind: input.kind,
          state: "open",
          version: 1,
          authorId: session.user.id,
          author: "Reviewer",
          commitSha: "d".repeat(40),
          annotation: null,
          createdAt: new Date().toISOString(),
          messages: [
            {
              id: crypto.randomUUID(),
              author: "Reviewer",
              body: input.body,
              createdAt: new Date().toISOString(),
            },
          ],
        });
        return { feedbackId: id };
      },
    },
  });
  await mockFactoryFunctions(page, {
    delivery: {
      async get(_actor, id) {
        if (id !== changeID) return serverCall(browserFunction(page, "getDelivery", [id]));
        return deliveryViewSchema.parse({
          pullRequestNumber: 1,
          pullRequestUrl: "http://127.0.0.1:33030/owned/starter/pulls/1",
          verificationState: "succeeded",
          reviewState: "passed",
          actionRunUrl: "http://127.0.0.1:33030/owned/starter/actions/runs/1",
        });
      },
    },
  });
  await mockFactoryFunctions(page, {
    conversations: { mode: async () => conversationViewSchema.parse(conversation) },
  });
  await mockFactoryFunctions(page, {
    conversations: {
      message: async (_actor, _factoryTargetID, _factoryCommand) => {
        researchRequests += 1;
        return completedConversation(conversationViewSchema.parse(conversation));
      },
    },
  });
  await mockFactoryFunctions(page, {
    review: {
      async send(_actor, _change, input) {
        received = input;
        state = "working";
        for (const item of feedback) if (item.kind === "thread") item.correctionState = "running";
        return { turnId: crypto.randomUUID() };
      },
    },
  });
  await selectProject(page);
  await page.getByRole("region", { name: "review", exact: true }).getByRole("button").click();
  await expect(page.getByRole("button", { name: "Deliver", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Review source changes", exact: true }),
  ).toHaveAttribute("href", "http://127.0.0.1:33030/owned/starter/pulls/1/files");
  await expect(
    page.getByRole("menuitem", { name: "Review source changes", exact: true }),
  ).toHaveAttribute("rel", "noreferrer");
  await expect(
    page.getByRole("menuitem", { name: "Review source changes", exact: true }),
  ).toHaveCSS("text-decoration-line", "none");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Cancel Change", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Forgejo checks" })).toBeHidden();
  await page.locator(".ticket-checks summary").click();
  await expect(page.getByRole("link", { name: "Open Forgejo checks" })).toBeVisible();
  await page.locator(".ticket-checks summary").click();
  const review = page.getByRole("region", { name: "Visual review", exact: true });
  await page
    .locator(".ticket-header-actions")
    .getByRole("button", { name: "Add feedback", exact: true })
    .click();
  const input = review.getByRole("textbox", { name: "Review comment", exact: true });
  await input.fill("The rest of the flow is clear.");
  await review.getByRole("button", { name: "Save feedback", exact: true }).click();
  expect(received).toBeUndefined();
  await page
    .locator(".ticket-header-actions")
    .getByRole("button", { name: "Add feedback", exact: true })
    .click();
  await review.getByRole("combobox", { name: "Feedback type" }).selectOption("thread");
  await input.fill("Correct the first action within the original requirements.");
  await mkdir(".factory/test-results/implementation-journey", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/source-submitted-not-complete-wide.png",
  });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/source-submitted-not-complete-narrow.png",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(430);
  await page.setViewportSize({ width: 1440, height: 900 });
  await review.getByRole("button", { name: "Save feedback", exact: true }).click();
  expect(received).toBeUndefined();
  await expect(review.getByRole("checkbox")).toHaveCount(0);
  await page
    .locator(".ticket-header-actions")
    .getByRole("button", { name: /^Request revision · \d+ Threads?$/ })
    .click();
  await expect
    .poll(() => received?.feedback)
    .toEqual(
      feedback
        .filter((item) => item.kind === "thread")
        .map((item) => ({ id: item.id, version: item.version })),
    );
  expect(researchRequests).toBe(0);
  await expect(review.getByText("Revision in progress", { exact: true })).toBeVisible();
  // The command response arrives before the cached Change reflects the new turn.
  await expect(page.getByRole("button", { name: "Deliver", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request changes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Request revision · \d+ Threads?$/ })).toHaveCount(
    0,
  );
  await mkdir(".factory/test-results/implementation-journey", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/correction-composer-cleared.png",
  });
  await page
    .locator(".ticket-header-actions")
    .getByRole("button", { name: "Add feedback", exact: true })
    .click();
  await input.fill("Keep this newer draft while the accepted correction runs.");
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reload review", exact: true }).click();
  await expect(input).toHaveValue("Keep this newer draft while the accepted correction runs.");
  await expect(page.getByRole("tab", { name: /^IDE/ })).toHaveCount(0);
  await mkdir(".factory/test-results/implementation-journey", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/review-desktop.png",
  });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.screenshot({ path: ".factory/test-results/implementation-journey/review-narrow.png" });
  const documentBox = await page.locator(".ticket-document").boundingBox();
  expect(documentBox?.width).toBeLessThanOrEqual(430);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(430);
});

test("Settings is a retained Project-bound workspace tab with no modal", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(settings.getByRole("heading", { name: "Personal", exact: true })).toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "Project · Implementation UX", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "Factory administration", exact: true }),
  ).toBeVisible();
  const skills = settings
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "Skills", exact: true });
  await skills.click();
  await page.getByRole("tab", { name: title, exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(skills).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await expect(settings).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(1);
  await expect(skills).toHaveAttribute("aria-current", "page");
  await mkdir(".factory/screenshots/implementation-journey", { recursive: true });
  await page.screenshot({
    path: ".factory/screenshots/implementation-journey/settings-desktop.png",
  });
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(page.getByRole("button", { name: "Minimize workspace", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(430);
  await page.screenshot({
    path: ".factory/screenshots/implementation-journey/settings-narrow.png",
  });
  expect(errors).toEqual([]);
});

test("post-start human edits and selected History retain immutable scope without dispatch", async ({
  page,
}) => {
  const db = createDatabase(1);
  const changeID = crypto.randomUUID();
  try {
    const { session } = await browserBootstrap(page);
    const approvalID = crypto.randomUUID();
    await db.client`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by)
      VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${session.user.id})`;
    await db.client`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
      VALUES (${changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`}, ${"a".repeat(40)}, 'active', ${session.user.id})`;
    await db.client`INSERT INTO factory.branch_create_operation(id, change_id, repository_owner, repository_name, branch_name, start_sha, idempotency_key, state, completed_at, observed_head_sha)
      SELECT id, id, 'owned', 'implementation-ux', branch_name, base_sha, id::text, 'succeeded', now(), base_sha FROM factory.change WHERE id = ${changeID}`;
    await db.client`UPDATE factory.ticket SET state = 'in-progress' WHERE id = ${ticketID}`;
    await selectProject(page);
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .click();
    // Fail optional notice persistence only. Durable command admission intentionally
    // requires recovery storage and must not be bypassed by a presentation test.
    await page.evaluate(() => {
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith("document-notice:"))
          throw new DOMException("Notice storage disabled", "SecurityError");
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("document-notice:"))
          throw new DOMException("Notice storage disabled", "SecurityError");
        return set.call(this, key, value);
      };
    });
    const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
    await summary.click();
    await summary.fill("Keep the **starter** welcoming. Updated human wording.");
    await expect
      .poll(async () => {
        const [saved] = await db.client<
          { content: string }[]
        >`SELECT canonical_content AS content FROM factory.ticket_document_revision WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
        return saved ? JSON.parse(saved.content).summary : "";
      })
      .toContain("Updated human wording.");
    const notice = page.locator(".ticket-document-notice");
    await expect(notice).toContainText("Document updated since implementation");
    const [saved] = await db.client<Array<{ scope: string; documents: number; turns: number }>>`
      SELECT approval.requirement_revision_id AS scope,
        (SELECT count(*)::integer FROM factory.ticket_document_revision WHERE ticket_id = ${ticketID}) AS documents,
        (SELECT count(*)::integer FROM factory.agent_turn WHERE ticket_id = ${ticketID}) AS turns
      FROM factory.requirement_approval approval WHERE approval.ticket_id = ${ticketID}`;
    expect(saved).toEqual({ scope: revisionID, documents: 1, turns: 0 });
    await notice
      .getByRole("button", { name: "Document updated since implementation", exact: true })
      .click();
    const history = page.getByRole("complementary", { name: "Specification history" });
    await expect(page.locator(".historical-document")).toContainText("Updated human wording");
    await history.getByRole("button", { name: /Version 1/ }).click();
    await expect(page.locator(".historical-document")).not.toContainText("Updated human wording");
    await expect(history).toContainText(session.user.name);
    await page.screenshot({
      path: ".factory/screenshots/implementation-journey/document-history-desktop.png",
    });
    await page.setViewportSize({ width: 430, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      430,
    );
    await page.screenshot({
      path: ".factory/screenshots/implementation-journey/document-history-narrow.png",
    });
    await history.getByRole("button", { name: "Close history", exact: true }).click();
    await notice.getByRole("button", { name: "Dismiss document update", exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(summary).toHaveAttribute("aria-readonly", "false");
    const [turns] =
      await db.client`SELECT count(*)::integer AS count FROM factory.agent_turn WHERE ticket_id = ${ticketID}`;
    expect(turns?.["count"]).toBe(0);
  } finally {
    await db.client.end();
  }
});

test("Trash and Restore preserve an unimplemented Ticket without dispatch", async ({ page }) => {
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".ticket-card-body")
    .click();
  const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
  await expect(summary).toContainText("starter");
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeEnabled();
  const actions = page.locator(".ticket-header-actions");
  await expect(actions.locator('[data-primary="true"]')).toHaveText("Restore");
  await expect(actions.locator(":scope > :last-child")).toHaveAttribute("data-primary", "true");
  await mkdir(".factory/test-results/ticket-action-bar/states", { recursive: true });
  await page.locator(".ticket-document-heading").screenshot({
    path: ".factory/test-results/ticket-action-bar/states/trashed-1440.png",
  });
  await expect(summary).toHaveAttribute("aria-readonly", "true");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
  await expect(summary).toHaveAttribute("aria-readonly", "false");
  await expect(summary).toContainText("starter");
  const db = createDatabase(1);
  try {
    const [work] = await db.client`SELECT
      (SELECT count(*)::integer FROM factory.agent_turn WHERE ticket_id=${ticketID}) AS turns,
      (SELECT count(*)::integer FROM factory.change WHERE ticket_id=${ticketID}) AS changes`;
    expect(work).toMatchObject({ turns: 0, changes: 0 });
  } finally {
    await db.client.end();
  }
});

test("delivered work creates one linked unapproved follow-up without another Build", async ({
  page,
}) => {
  const db = createDatabase(1);
  try {
    const { session } = await browserBootstrap(page);
    const approvalID = crypto.randomUUID();
    await db.client`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by)
      VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${session.user.id})`;
    await db.client`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
      VALUES (${crypto.randomUUID()}, ${projectID}, ${ticketID}, ${approvalID}, 'factory/change-123456789abc', ${"a".repeat(40)}, 'delivered', ${session.user.id})`;
    await db.client`INSERT INTO factory.branch_create_operation(id, change_id, repository_owner, repository_name, branch_name, start_sha, idempotency_key, state, completed_at, observed_head_sha)
      SELECT id, id, 'owned', 'implementation-ux', branch_name, base_sha, id::text, 'succeeded', now(), base_sha FROM factory.change WHERE ticket_id = ${ticketID}`;
    await db.client`UPDATE factory.ticket SET state = 'done' WHERE id = ${ticketID}`;
    await selectProject(page);
    await page.getByRole("button", { name: /History/ }).click();
    await page.getByRole("button").filter({ hasText: title }).last().click();
    await page.getByRole("button", { name: "Create follow-up", exact: true }).click();
    await expect(page.getByRole("button", { name: /Follow-up to/ })).toBeVisible();
    const [linked] = await db.client<
      Array<{ approved: number; turns: number; changeCount: number }>
    >`
      SELECT (SELECT count(*)::integer FROM factory.requirement_approval WHERE ticket_id = link.ticket_id) AS approved,
        (SELECT count(*)::integer FROM factory.agent_turn WHERE ticket_id = link.ticket_id) AS turns,
        (SELECT count(*)::integer FROM factory.change WHERE ticket_id = link.ticket_id) AS "changeCount"
      FROM factory.ticket_follow_up link WHERE source_ticket_id = ${ticketID}`;
    expect(linked).toEqual({ approved: 0, turns: 0, changeCount: 0 });
  } finally {
    await db.client.end();
  }
});
