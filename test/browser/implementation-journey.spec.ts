import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";
import { fulfillAgentView, streamedAgentView } from "../support/agent-activity-route";
import type { AgentView } from "../../apps/factory/src/api-contracts";

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(30_000);
let projectID = "";
let ticketID = "";
let revisionID = "";
const title = "A calm implementation journey";

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await (await page.request.get("/api/session")).json();
  projectID = crypto.randomUUID();
  ticketID = crypto.randomUUID();
  revisionID = crypto.randomUUID();
  await page.route(`**/api/projects/${projectID}/source-workspace/ensure`, (route) =>
    route.fulfill({ status: 503, json: { error: "Controlled planning fixture has no source" } }),
  );
  await page.route(`**/api/projects/${projectID}/developer-ide/ensure`, (route) =>
    route.fulfill({ status: 503, json: { error: "Controlled planning fixture has no IDE" } }),
  );
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
  await page.getByRole("button", { name: "Open project menu", exact: true }).click();
  await page
    .getByRole("button")
    .filter({ hasText: `implementation-ux-${projectID}` })
    .click();
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
      .getByRole("button")
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
  await page.route(`**/api/changes?projectId=${projectID}`, (route) =>
    route.fulfill({ json: { changes: [change] } }),
  );
  await page.route(`**/api/changes/${changeID}/agent{,?*,/activity}`, (route) =>
    fulfillAgentView(route, {
      json: {
        state: "starting",
        sessionAvailable: true,
        runtimeConnected: false,
        messagesAvailable: true,
        messages: [],
        stopPending: false,
        stopId: null,
        computeWait: paused ? null : "capacity",
        codingPause: paused ? { turnID, reason: "finish-reserve-used" } : null,
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/delivery`, (route) => route.fulfill({ json: {} }));
  await page.route(`**/api/changes/${changeID}/agent/resume`, (route) => {
    resumes.push(route.request().postDataJSON());
    return route.abort("failed");
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

test("Implement is one explicit recoverable action and does not open IDE or Assistant", async ({
  page,
}) => {
  const requests: Array<{ commandId: string; revisionId: string }> = [];
  await page.route(`**/api/tickets/${ticketID}/implement`, async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.abort("failed");
    return route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
  });
  await selectProject(page);
  await page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").click();
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
  const requests: Array<{ commandId: string; revisionId: string; codingReasoning?: string }> = [];
  const codingTitle =
    "Implement the staff support inbox with personal request tracking, open and done filters, keyboard access, and safe account switching";
  const fixtureDatabase = createDatabase(1);
  try {
    await fixtureDatabase.client`UPDATE factory.ticket SET title=${codingTitle} WHERE id=${ticketID}`;
  } finally {
    await fixtureDatabase.client.end();
  }
  const sessionSnapshot = await (await page.request.get("/api/session")).json();
  const configuration = await (
    await page.request.get(`/api/projects/${projectID}/model-settings`)
  ).json();
  configuration.system.connection.buildProvider = "openai";
  configuration.system.rules.build.reasoningEffort = "medium";
  configuration.effective.build.modelId = "gpt-6.1-sol";
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { ...sessionSnapshot, modelRelayConfigured: true } }),
  );
  await page.route(`**/api/projects/${projectID}/model-settings`, (route) =>
    route.fulfill({ json: configuration }),
  );
  await page.route(`**/api/tickets/${ticketID}/implement`, (route) => {
    requests.push(route.request().postDataJSON());
    return requests.length === 1
      ? route.abort("connectionreset")
      : route.fulfill({ status: 202, json: {} });
  });
  await selectProject(page);
  await page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").click();
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
  await page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").click();
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
  const session = await (await page.request.get("/api/session")).json();
  const configuration = await (
    await page.request.get(`/api/projects/${projectID}/model-settings`)
  ).json();
  configuration.system.connection.buildProvider = "openai";
  configuration.effective.build.modelId = "gpt-6.1-sol";
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { ...session, modelRelayConfigured: true } }),
  );
  await page.route(`**/api/projects/${projectID}/model-settings`, (route) =>
    route.fulfill({ json: configuration }),
  );
  await page.route(`**/api/tickets/${ticketID}/implement`, (route) => {
    requests.push(route.request().postDataJSON());
    admitted = true;
    return route.abort("connectionreset");
  });
  await page.route(`**/api/changes?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/agent{,?*,/activity}`, (route) =>
    fulfillAgentView(route, {
      json: {
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
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/delivery`, (route) => route.fulfill({ json: {} }));
  await selectProject(page);
  await page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").click();
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
    await page.route(`**/api/changes?projectId=${projectID}`, async (route) => {
      await release.promise;
      await route.fulfill({ json: { changes: [] } });
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
  await page.route(`**/api/changes?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/agent{,?*,/activity}`, (route) =>
    fulfillAgentView(route, {
      json: {
        state: "failed",
        sessionAvailable: true,
        runtimeConnected: false,
        messagesAvailable: true,
        messages: [],
        stopPending: false,
        stopId: null,
        lastError: "Owned Sandbox startup failed",
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/delivery`, (route) => route.fulfill({ json: {} }));
  await page.route(`**/api/changes/${changeID}/writer`, (route) =>
    route.fulfill({
      json: { state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
    }),
  );
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Open IDE", exact: true }).click();
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
  let commandId = crypto.randomUUID();
  const starts: Array<{ commandId: string; codingReasoning?: string }> = [];
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
  const sessionSnapshot = await (await page.request.get("/api/session")).json();
  const configurationSnapshot = await (
    await page.request.get(`/api/projects/${projectID}/model-settings`)
  ).json();
  configurationSnapshot.system.connection.buildProvider = "openai";
  configurationSnapshot.system.rules.build.reasoningEffort = "medium";
  configurationSnapshot.effective.build.modelId = "gpt-6.1-sol";
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: { ...sessionSnapshot, modelRelayConfigured: true },
    }),
  );
  await page.route(`**/api/projects/${projectID}/model-settings`, (route) => {
    configurationReads++;
    return route.fulfill({ json: configurationSnapshot });
  });
  await page.route(`**/api/changes?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/agent{,?*,/activity}`, async (route) => {
    agentReads++;
    if (holdingFirstObservation) await firstObservation.promise;
    return fulfillAgentView(route, { json: view() });
  });
  await page.route(`**/api/changes/${changeID}/delivery`, (route) => route.fulfill({ json: {} }));
  await page.route(`**/api/changes/${changeID}/writer`, (route) =>
    route.fulfill({
      json: { state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
    }),
  );
  await page.route(`**/api/projects/${projectID}/conversation/mode`, (route) =>
    route.fulfill({
      json: {
        id: crypto.randomUUID(),
        projectId: projectID,
        ticketId: ticketID,
        mode: "build",
        version: 1,
        entries: [],
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/agent/start`, (route) => {
    const input = route.request().postDataJSON();
    starts.push(input);
    if (starts.length === 1) return route.abort("connectionreset");
    commandId = input.commandId;
    state = "working";
    return route.fulfill({ json: view() });
  });
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Open IDE", exact: true }).click();
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
    const toolbar = panel.locator(".agent-compose-toolbar");
    const button = toolbar.getByRole("button", { name: action, exact: true });
    await expect(button).toBeVisible();
    await expect
      .poll(() =>
        toolbar.evaluate((element) => {
          const selection = element.querySelector("select")?.getBoundingClientRect();
          const action = element.querySelector("button")?.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          return selection && action
            ? {
                sameLine:
                  Math.abs(selection.y + selection.height / 2 - action.y - action.height / 2) <= 2,
                selectionBeforeAction: selection.right <= action.x,
                actionAtRight: Math.abs(bounds.right - action.right) <= 2,
              }
            : {};
        }),
      )
      .toEqual({ sameLine: true, selectionBeforeAction: true, actionAtRight: true });
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
  await page.getByRole("button", { name: "Open IDE", exact: true }).click();
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
  const footerBox = await panel.locator(".agent-compose-toolbar").boundingBox();
  expect(inputBox && footerBox && inputBox.width >= footerBox.width - 2).toBe(true);
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
    const created = await page.request.post("/api/admin/users", {
      headers: { origin: "http://127.0.0.1:3000" },
      data: { name: `Coding model ${role}`, email, password },
    });
    expect(created.status()).toBe(201);
    const user: { id: string } = await created.json();
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
      const membership = await page.request.post(`/api/projects/${projectID}/members`, {
        headers: { origin: "http://127.0.0.1:3000" },
        // Managing a Project does not grant developer access.
        data: { email, role, manageProject: role === "product-contributor" },
      });
      expect(membership.ok()).toBe(true);
      for (const resource of ["source-workspace", "developer-ide"]) {
        await member.route(`**/api/projects/${projectID}/${resource}/ensure`, (route) =>
          route.fulfill({ status: 503, json: { error: "No runtime in model control fixture" } }),
        );
      }
      await member.route(`**/api/changes?projectId=${projectID}`, (route) =>
        route.fulfill({
          json: {
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
          },
        }),
      );
      await member.route(`**/api/changes/${changeID}/agent{,?*,/activity}`, (route) =>
        fulfillAgentView(route, {
          json: {
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
          },
        }),
      );
      await member.route(`**/api/changes/${changeID}/delivery`, (route) =>
        route.fulfill({ json: {} }),
      );
      await member.goto("/");
      await member.getByLabel("Email", { exact: true }).fill(email);
      await member.getByLabel("Password", { exact: true }).fill(password);
      await member.getByRole("button", { name: "Sign in", exact: true }).click();
      await selectProject(member);
      await member
        .getByRole("region", { name: "requirements", exact: true })
        .getByRole("button")
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
      await member.getByRole("button", { name: "Request changes", exact: true }).click();
      await expect(panel.locator(".agent-state")).toHaveText("Submitted for verification");
      await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
      if (role === "developer") {
        await expect(panel.getByLabel("Reasoning", { exact: true })).toBeVisible();
        await expect(panel.getByLabel("Reasoning", { exact: true })).toBeDisabled();
      } else {
        await expect(controls).toHaveCount(0);
        await expect(panel.locator("select")).toHaveCount(0);
        await expect(member.getByRole("button", { name: "Open IDE", exact: true })).toHaveCount(0);
      }
      await member.screenshot({ path: `${evidence}/${role}-coding.png` });
      await member.setViewportSize({ width: 390, height: 844 });
      await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      expect(await member.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await member.screenshot({ path: `${evidence}/${role}-coding-narrow.png` });
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
  await page.route(`**/api/changes/${changeID}/writer`, (route) =>
    route.fulfill({
      json: { state: "agent", epoch: 1, canWrite: false, yours: false, commandID: null },
    }),
  );
  await page.route(`**/api/changes?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/agent{,?*,/activity}`, (route) =>
    fulfillAgentView(route, {
      json: {
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
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/delivery`, (route) => route.fulfill({ json: {} }));
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation", exact: true })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Open IDE", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  const rows = page.locator("details.agent-activity");
  await expect(rows).toHaveCount(3);
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
  expect((await row.boundingBox())?.height).toBeLessThanOrEqual(32);
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
  const stream = await streamedAgentView(view, new URL(page.url()).origin);
  let statusReads = 0;
  let mutations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/changes/${changeID}/agent`))
      mutations++;
  });
  await page.route(`**/api/changes?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route(`**/api/changes/${changeID}/agent{,?*}`, (route) => {
    statusReads++;
    return route.fulfill({ json: view });
  });
  await page.route(`**/api/changes/${changeID}/agent/activity`, (route) =>
    route.continue({ url: stream.url }),
  );
  await page.route(`**/api/changes/${changeID}/delivery`, (route) => route.fulfill({ json: {} }));
  await page.route(`**/api/changes/${changeID}/writer`, (route) =>
    route.fulfill({
      json: {
        state: "agent",
        epoch: 1,
        canWrite: false,
        yours: false,
        commandID: null,
      },
    }),
  );
  const workspaceID = crypto.randomUUID();
  const source = {
    workspaceID,
    serviceID: "owned-live-activity",
    epoch: 1,
    state: "preparing",
    failure: null,
  };
  await page.route(`**/api/changes/${changeID}/source-workspace/ensure`, (route) =>
    route.fulfill({ json: source }),
  );
  await page.route(`**/api/workspaces/${workspaceID}/source`, (route) =>
    route.fulfill({ json: source }),
  );
  try {
    await selectProject(page);
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .click();
    await page.getByRole("button", { name: "Open IDE", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const rows = page.locator("details.agent-activity");
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

test("Review corrections send to the retained Build without IDE; checks and controls remain compact", async ({
  page,
}) => {
  const changeID = crypto.randomUUID();
  let received: { commandId: string; text: string } | undefined;
  let researchRequests = 0;
  let state = "committed";
  let holdRead = false;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
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
  await page.route(`**/api/changes?projectId=${projectID}`, (route) =>
    route.fulfill({ json: { changes: [change] } }),
  );
  await page.route(`**/api/changes/${changeID}/agent{,?*,/activity}`, async (route) => {
    const snapshot = { ...agent, state };
    if (holdRead) {
      holdRead = false;
      held.resolve();
      await release.promise;
    }
    await fulfillAgentView(route, { json: snapshot });
  });
  await page.route(`**/api/changes/${changeID}/agent/stop`, (route) => {
    state = "stopped";
    return route.fulfill({ json: { ...agent, state } });
  });
  await page.route(`**/api/changes/${changeID}/delivery`, (route) =>
    route.fulfill({
      json: {
        pullRequestNumber: 1,
        pullRequestUrl: "http://127.0.0.1:33030/owned/starter/pulls/1",
        verificationState: "succeeded",
        actionRunUrl: "http://127.0.0.1:33030/owned/starter/actions/runs/1",
      },
    }),
  );
  await page.route(`**/api/projects/${projectID}/conversation/mode`, (route) =>
    route.fulfill({ json: conversation }),
  );
  await page.route(`**/api/projects/${projectID}/conversation/message`, (route) => {
    researchRequests += 1;
    return route.fulfill({ json: conversation });
  });
  await page.route(`**/api/changes/${changeID}/agent/request-changes`, (route) => {
    received = route.request().postDataJSON();
    state = "working";
    return route.fulfill({ json: { ...agent, state } });
  });
  await selectProject(page);
  await page.getByRole("region", { name: "review", exact: true }).getByRole("button").click();
  await expect(page.getByRole("button", { name: "Deliver", exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review source changes", exact: true }),
  ).toHaveAttribute("href", "http://127.0.0.1:33030/owned/starter/pulls/1/files");
  await expect(
    page.getByRole("link", { name: "Review source changes", exact: true }),
  ).toHaveAttribute("rel", "noreferrer");
  await expect(page.getByRole("link", { name: "Review source changes", exact: true })).toHaveCSS(
    "text-decoration-line",
    "none",
  );
  await expect(page.getByRole("button", { name: "Cancel Change", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Forgejo checks" })).toBeHidden();
  await page.locator(".ticket-checks summary").click();
  await expect(page.getByRole("link", { name: "Open Forgejo checks" })).toBeVisible();
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message conversation", exact: true });
  await expect(input).toBeVisible();
  await expect(page.locator(".agent-state")).toHaveText("Submitted for verification");
  await expect(
    page.getByText("Review the submitted changes, or describe a correction.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Workspace status unavailable", { exact: true })).toBeVisible();
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
  await expect(page.getByText("Details", { exact: true })).toHaveCount(0);
  await input.fill("Correct the first action within the original requirements.");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect
    .poll(() => received?.text)
    .toBe("Correct the first action within the original requirements.");
  expect(researchRequests).toBe(0);
  await expect(page.locator(".agent-state")).toHaveText("Working");
  await expect(input).toHaveValue("");
  // The command response arrives before the cached Change reflects the new turn.
  await expect(page.getByRole("button", { name: "Deliver", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request changes", exact: true })).toHaveCount(0);
  await mkdir(".factory/test-results/implementation-journey", { recursive: true });
  await page.screenshot({
    path: ".factory/test-results/implementation-journey/correction-composer-cleared.png",
  });
  await input.fill("Keep this newer draft while the accepted correction runs.");
  holdRead = true;
  await held.promise;
  await page.getByRole("button", { name: "Stop OpenCode", exact: true }).click();
  await expect(page.locator(".agent-state")).toHaveText("Stopped");
  const oldResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/changes/${changeID}/agent/activity`,
  );
  release.resolve();
  await oldResponse;
  // Assert in the next rendered frame, before a later truthful poll can conceal rollback.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator(".agent-state")).toHaveText("Stopped", { timeout: 100 });
  await expect(input).toHaveValue("Keep this newer draft while the accepted correction runs.");
  await expect(page.getByRole("tab", { name: /^IDE/ })).toHaveCount(0);
  await mkdir(".factory/test-results/implementation-journey", { recursive: true });
  await page.getByRole("button", { name: "Minimize Agent panel", exact: true }).click();
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
  await page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(settings.getByRole("heading", { name: "Personal", exact: true })).toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "Implementation UX", exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Factory", exact: true })).toBeVisible();
  const skills = settings
    .getByRole("navigation", { name: "Settings navigation" })
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Personal", exact: true }) })
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
    const { session } = await (await page.request.get("/api/session")).json();
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
  await page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").click();
  const summary = page.getByRole("textbox", { name: "Specification summary", exact: true });
  await expect(summary).toContainText("starter");
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeEnabled();
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
    const { session } = await (await page.request.get("/api/session")).json();
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
