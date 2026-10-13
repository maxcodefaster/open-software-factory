import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import ts from "typescript";
import { ticketDetailSchema } from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";
import { luminance, rgb } from "../support/visual-contrast";

const userID = "01994a7d-0000-7000-8000-000000000001";
const evidenceDirectory = ".factory/test-results/ux-trust";
const cleanupEvidenceDirectory = evidenceDirectory;
const frameFocusScript = ts.transpileModule(
  readFileSync(
    new URL(
      "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-frame-focus.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

test("distinguishes running compute from a still-attaching IDE document", async ({ page }) => {
  const attemptID = crypto.randomUUID();
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**/api/runtime-attempts?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
        attempts: [
          {
            id: attemptID,
            projectId: projectID,
            workspaceId: "attachment-fixture",
            workspaceKind: "personal",
            runtimeKind: "personal",
            ownerUserId: userID,
            state: "ready",
          },
        ],
      },
    }),
  );
  await page.route("**/api/runtime-access?*", async (route) => {
    requested.resolve();
    await release.promise;
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><textarea aria-label="Attached editor"></textarea></body></html>',
    });
  });
  try {
    await signIn(page);
    await selectProject(page);
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    await requested.promise;
    const connection = page.getByRole("status", { name: "IDE connection" });
    await expect(connection).toHaveText("Workspace is running. Opening IDE…", { timeout: 3_000 });
    const frame = page.locator('iframe[title="Factory IDE"]');
    await expect(frame).toHaveAttribute("inert", "");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${evidenceDirectory}/ide-attaching.png`, fullPage: true });
    release.resolve();
    await expect(
      page.frameLocator('iframe[title="Factory IDE"]').getByLabel("Attached editor"),
    ).toBeVisible();
    await expect(connection).toHaveCount(0);
    await expect(frame).not.toHaveAttribute("inert", "");
  } finally {
    release.resolve();
  }
});

test("recovers a rejected IDE access document without restarting compute", async ({ page }) => {
  const attemptID = crypto.randomUUID();
  let documentRequests = 0;
  let computeRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("workspace/ensure")) {
      computeRequests++;
    }
  });
  await page.route(`**/api/runtime-attempts?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
        attempts: [
          {
            id: attemptID,
            projectId: projectID,
            workspaceId: "rejected-attachment-fixture",
            workspaceKind: "personal",
            runtimeKind: "personal",
            ownerUserId: userID,
            state: "ready",
          },
        ],
      },
    }),
  );
  await page.route("**/api/runtime-access?*", (route) => {
    documentRequests++;
    return documentRequests === 1
      ? route.fulfill({ status: 409, json: { error: "Runtime is not ready" } })
      : route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><body><textarea aria-label="Recovered editor"></textarea></body></html>',
        });
  });
  await signIn(page);
  await selectProject(page);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const connection = page.getByRole("status", { name: "IDE connection" });
  await expect(connection).toContainText("Could not open IDE", { timeout: 3_000 });
  const frame = page.locator('iframe[title="Factory IDE"]');
  await expect(frame).toHaveAttribute("inert", "");
  const startsBeforeReload = computeRequests;
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `${evidenceDirectory}/ide-attachment-rejected.png`,
    fullPage: true,
  });
  await connection.getByRole("button", { name: "Reload view" }).click();
  await expect(
    page.frameLocator('iframe[title="Factory IDE"]').getByLabel("Recovered editor"),
  ).toBeVisible();
  await expect(connection).toHaveCount(0);
  await expect(frame).not.toHaveAttribute("inert", "");
  expect(documentRequests).toBe(2);
  expect(computeRequests).toBe(startsBeforeReload);
  await expect(frame).toHaveAttribute("data-runtime-attempt-id", attemptID);
});

let database: ReturnType<typeof createDatabase> | undefined;
let projectID = "";
let projectSlug = "";
let additionalProjectIDs: string[] = [];

for (const view of ["IDE", "Preview"] as const) {
  test(`${view} retains its document during reconnect without restarting compute`, async ({
    page,
  }) => {
    const attemptID = crypto.randomUUID();
    let reconnecting = false;
    let documents = 0;
    let creates = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/(personal-workspace|ticket-workspace|staging)\/ensure$/.test(request.url())
      )
        creates++;
    });
    await page.route(`**/api/runtime-attempts?projectId=${projectID}`, (route) =>
      route.fulfill({
        json: {
          attempts: [
            {
              id: attemptID,
              projectId: projectID,
              workspaceId: view === "IDE" ? "reconnect-workspace" : undefined,
              workspaceKind: view === "IDE" ? "personal" : undefined,
              runtimeKind: view === "IDE" ? "personal" : "staging",
              currentStaging: view === "Preview",
              ownerUserId: userID,
              state: reconnecting ? "starting" : "ready",
              failure: reconnecting ? "child connector reconnecting" : null,
            },
          ],
        },
      }),
    );
    await page.route("**/api/runtime-access?*", (route) => {
      documents++;
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><body><textarea aria-label="Unsaved runtime draft"></textarea></body></html>',
      });
    });
    await signIn(page);
    await selectProject(page);
    await page.getByRole("button", { name: view, exact: true }).click();
    const frame = page.locator(`iframe[title="Factory ${view}"]`);
    const editor = page
      .frameLocator(`iframe[title="Factory ${view}"]`)
      .getByLabel("Unsaved runtime draft");
    await editor.fill("Keep this exact document and draft");
    reconnecting = true;
    const status = page.getByRole("status", { name: `${view} connection` });
    await expect(status).toHaveText("Connection interrupted. Reconnecting to the same Workspace…");
    await expect(frame).toHaveAttribute("inert", "");
    await expect(frame).toHaveAttribute("data-runtime-attempt-id", attemptID);
    await page.screenshot({
      path: `.factory/screenshots/${view.toLowerCase()}-reconnecting.png`,
      fullPage: true,
    });
    reconnecting = false;
    await expect(status).toHaveCount(0);
    await expect(editor).toHaveValue("Keep this exact document and draft");
    await expect(frame).not.toHaveAttribute("inert", "");
    expect(documents).toBe(1);
    expect(creates).toBe(0);
  });
}

test("startup Stop, reconnect and detached chat preserve the same Build ownership", async ({
  page,
}) => {
  const ticketID = await insertChangedTicket("Startup Stop and reconnect", "active");
  await insertConversation(projectID, ticketID, "build");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<
    { id: string }[]
  >`SELECT id FROM factory.change WHERE ticket_id = ${ticketID}`;
  if (!change) throw new Error("Missing fixture Change");
  let state: "stopped" | "working" = "stopped";
  let runtimeConnected = false;
  let sessionAvailable = false;
  const attemptID = crypto.randomUUID();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  const mutations: string[] = [];
  let computeCreates = 0;
  const projectMessages: Array<{ ticketId?: string; text: string }> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/changes/${change.id}/agent`))
      mutations.push(new URL(request.url()).pathname);
    if (request.method() === "POST" && request.url().endsWith("workspace/ensure")) computeCreates++;
  });
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), modelRelayConfigured: true },
    });
  });
  const view = () => ({
    state,
    runtimeConnected,
    runtimeState: state === "working" ? (runtimeConnected ? "ready" : "starting") : undefined,
    sessionAvailable,
    messages: sessionAvailable
      ? [
          {
            id: "owned-build-reply",
            role: "assistant",
            text: "The **owned Build** continues.",
            at: 1,
          },
        ]
      : [],
    messagesAvailable: true,
    stopPending: false,
    stopId: null,
  });
  await page.route(`**/api/changes/${change.id}/agent`, (route) => route.fulfill({ json: view() }));
  await page.route(`**/api/changes/${change.id}/agent/start`, (route) => {
    state = "working";
    sessionAvailable = true;
    return route.fulfill({ json: view() });
  });
  await page.route(`**/api/changes/${change.id}/agent/stop`, (route) => {
    state = "stopped";
    return route.fulfill({ json: view() });
  });
  await page.route(`**/api/projects/${projectID}/conversation/message`, (route) => {
    projectMessages.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "Controlled response, no model request" } });
  });
  await page.route(`**/api/runtime-attempts?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
        attempts: [
          {
            id: attemptID,
            projectId: projectID,
            changeId: change.id,
            workspaceId: "owned-stop-workspace",
            workspaceKind: "ticket",
            runtimeKind: "ticket",
            state: "ready",
          },
        ],
      },
    }),
  );
  await page.route("**/api/runtime-access?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Owned implementation IDE</body></html>",
    }),
  );
  await openConversation(page);
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Startup Stop and reconnect" })
    .click();
  const panel = page.locator(".agent-panel");
  const start = panel.getByRole("button", { name: "Start implementation", exact: true });
  await expect(page.getByLabel("Ticket title", { exact: true })).toHaveText(
    "Startup Stop and reconnect",
    { timeout: 5_000 },
  );
  expect(pageErrors).toEqual([]);
  await expect(start).toHaveCount(0);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(page.locator('iframe[title="Factory IDE"]')).toHaveAttribute(
    "data-runtime-attempt-id",
    attemptID,
  );
  await expect(start).toBeEnabled();
  await expect(panel.getByLabel("Message conversation")).toBeVisible();
  await expect(panel).toContainText(
    "Stopped before Build started. Start implementation when ready.",
  );
  await page.screenshot({
    path: ".factory/screenshots/build-stopped-before-session.png",
    fullPage: true,
  });
  await start.click();
  await expect(panel.locator(".agent-state")).toHaveText("Reconnecting");
  await expect(panel.locator(".runtime-presence")).toHaveText("Workspace reconnecting");
  await expect(panel.getByRole("status", { name: "Build connection" })).toBeVisible();
  await expect(panel.getByRole("status", { name: "Build connection" })).toContainText(
    "Waiting for the same Build. Work is not restarted.",
  );
  await panel.getByLabel("Message conversation").fill("Retain next instructions");
  await page.screenshot({ path: ".factory/screenshots/build-reconnecting.png", fullPage: true });
  runtimeConnected = true;
  await expect(panel.locator(".agent-state")).toHaveText("Working");
  await expect(panel.getByLabel("Message conversation")).toHaveValue("Retain next instructions");
  expect(mutations).toEqual([`/api/changes/${change.id}/agent/start`]);
  expect(computeCreates).toBe(0);
  await expect(panel.locator(".agent-message.assistant strong")).toHaveText("owned Build");
  await panel.getByRole("button", { name: "Remove Ticket context" }).click();
  await expect(panel.locator(".agent-message.assistant")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Stop OpenCode" })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Startup Stop and reconnect", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator('iframe[title="Factory IDE"]')).toHaveAttribute(
    "data-runtime-attempt-id",
    attemptID,
  );
  await panel.getByLabel("Message conversation").fill("Project-wide research");
  await panel.getByLabel("Message conversation").press("Enter");
  await expect.poll(() => projectMessages.length).toBe(1);
  expect(projectMessages[0]).not.toHaveProperty("ticketId");
  expect(mutations).toEqual([`/api/changes/${change.id}/agent/start`]);
  await panel.getByRole("button", { name: "Attach selected Ticket" }).click();
  await expect(panel.locator(".agent-message.assistant strong")).toHaveText("owned Build");
  await expect(panel.locator(".agent-state")).toHaveText("Working");
  await panel.getByRole("button", { name: "Remove Ticket context" }).click();
  await panel.getByRole("button", { name: "Stop OpenCode" }).click();
  await expect
    .poll(() => mutations)
    .toEqual([`/api/changes/${change.id}/agent/start`, `/api/changes/${change.id}/agent/stop`]);
  expect(computeCreates).toBe(0);
  await expect(page.locator('iframe[title="Factory IDE"]')).toHaveAttribute(
    "data-runtime-attempt-id",
    attemptID,
  );
  expect(pageErrors).toEqual([]);
});

test.setTimeout(60_000);

test("a failed Change without a Session does not claim Build is ready", async ({ page }) => {
  const ticketID = await insertChangedTicket("Build unavailable after startup failure", "failed");
  await insertConversation(projectID, ticketID, "build");
  await openConversation(page);
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Build unavailable after startup failure" })
    .click();
  const panel = page.locator(".agent-panel");
  await expect(panel.locator(".agent-state")).toHaveText("Build unavailable");
  await expect(
    panel.getByRole("button", { name: "Start implementation", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: ".factory/screenshots/build-unavailable.png", fullPage: true });
});

test("Review keeps updating when the PR number is a PostgreSQL bigint", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const title = "Review projection with a real PR number";
  const ticketID = await insertChangedTicket(title, "active");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<Array<{ id: string; branch: string }>>`
    SELECT id, branch_name AS branch FROM factory.change WHERE ticket_id = ${ticketID}
  `;
  if (!change) throw new Error("Missing fixture Change");
  await database.client`
    INSERT INTO factory.pull_request_operation(
      id, change_id, repository_owner, repository_name, base_branch, head_branch,
      first_head_sha, title, body, idempotency_key, state, pull_request_number,
      pull_request_url, completed_at
    ) VALUES (
      ${crypto.randomUUID()}, ${change.id}, 'factory-mutation', 'ux-trust', 'main',
      ${change.branch}, ${"a".repeat(40)}, ${title}, '', ${`ux-trust:pr:${change.id}`},
      'succeeded', 28, 'https://example.invalid/ux-trust/pulls/28', now()
    )
  `;
  await signIn(page);
  await selectProject(page);
  const detailResponse = await page.context().request.get(`/api/tickets/${ticketID}`);
  expect(detailResponse.ok()).toBe(true);
  ticketDetailSchema.parse(await detailResponse.json());
  const browserDetail = page.waitForResponse(
    (response) => response.url().endsWith(`/api/tickets/${ticketID}`),
    { timeout: 5_000 },
  );
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button")
    .filter({ hasText: title })
    .click();
  const browserResponse = await browserDetail;
  expect(browserResponse.ok()).toBe(true);
  expect(ticketDetailSchema.parse(await browserResponse.json()).ticket.id).toBe(ticketID);
  const metadata = page.locator(".ticket-metadata");
  await expect
    .poll(
      async () => {
        if (pageErrors.length) throw new Error(pageErrors.join("\n"));
        return metadata.getByRole("link", { name: /#28/ }).isVisible();
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  await expect(page.getByText("Updates paused. Showing the last known state.")).toHaveCount(0);
});
test.use({
  viewport: { width: 1440, height: 900 },
  contextOptions: { reducedMotion: "reduce" },
});

function hexID() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

async function selectProject(page: Page, slug = projectSlug) {
  await page.getByRole("button", { name: "Open project menu" }).click();
  await page.getByRole("button").filter({ hasText: slug }).click();
}

async function openConversation(page: Page) {
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await selectProject(page);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  return page.getByRole("complementary", { name: "Agent panel" });
}

async function agentWorkspaceLayout(page: Page) {
  return page.getByRole("complementary", { name: "Agent panel" }).evaluate((panel) => {
    const workspace = document.querySelector(".workspace-window");
    if (!workspace) throw new Error("Missing workspace window");
    const agent = panel.getBoundingClientRect();
    const windowBounds = workspace.getBoundingClientRect();
    return {
      agent: { left: agent.left, right: agent.right, width: agent.width },
      workspace: {
        left: windowBounds.left,
        right: windowBounds.right,
        width: windowBounds.width,
      },
      gap: windowBounds.left - agent.right,
      moving: [panel, workspace].some((element) =>
        element.getAnimations().some((animation) => animation.playState === "running"),
      ),
    };
  });
}

async function waitForAgentWorkspaceLayout(page: Page) {
  await expect
    .poll(async () => {
      const layout = await agentWorkspaceLayout(page);
      return !layout.moving && layout.gap >= 0;
    })
    .toBe(true);
  return agentWorkspaceLayout(page);
}

async function insertConversation(
  targetProjectID = projectID,
  ticketID?: string,
  mode: "investigate" | "plan" | "build" = "investigate",
) {
  if (!database) throw new Error("Database is not ready");
  const conversationID = crypto.randomUUID();
  await database.client`
    INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
    VALUES (${conversationID}, ${targetProjectID}, ${ticketID ?? null}, ${mode}, ${userID})
  `;
  return conversationID;
}

async function insertUserMessage(conversationID: string, body: string, commandId?: string) {
  if (!database) throw new Error("Database is not ready");
  await database.client`
    INSERT INTO factory.conversation_entry(
      id, conversation_id, ordinal, kind, actor, mode, body, payload, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${conversationID},
      (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM factory.conversation_entry
        WHERE conversation_id = ${conversationID}),
      'user-message', 'user', 'investigate', ${body}, ${JSON.stringify(commandId ? { commandId } : {})}::jsonb, ${userID}
    )
  `;
}

async function insertOtherProjectConversation() {
  if (!database) throw new Error("Database is not ready");
  const id = crypto.randomUUID();
  const slug = `ux-other-${id.slice(0, 8)}`;
  additionalProjectIDs.push(id);
  await database.client`
    INSERT INTO factory.project(
      id, slug, name, repository_url, default_branch, devcontainer_path, created_by
    ) VALUES (
      ${id}, ${slug}, 'Other conversation fixture',
      'https://example.invalid/ux-other.git', 'main', '.devcontainer/devcontainer.json', ${userID}
    )
  `;
  const conversationID = await insertConversation(id);
  await insertUserMessage(conversationID, "New Project history");
  return { id, slug };
}

async function insertChangedTicket(
  title: string,
  state: "active" | "cancelled" | "delivered" | "failed",
): Promise<string> {
  if (!database) throw new Error("Database is not ready");
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const changeID = crypto.randomUUID();
  const branchName = `factory/change-${hexID()}`;
  const canonicalContent = JSON.stringify({
    summary: `${title} specification`,
    acceptanceCriteria: ["The final state is visible."],
    nonGoals: [],
  });
  const digest = createHash("sha256").update(canonicalContent).digest("hex");

  await database.client.begin(async (transaction) => {
    await transaction`
      INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
      VALUES (${ticketID}, ${projectID}, ${title}, '', 'in-progress', ${userID})
    `;
    await transaction`
      INSERT INTO factory.requirement_revision(
        id, ticket_id, ordinal, canonical_content, content_digest, created_by
      ) VALUES (${revisionID}, ${ticketID}, 1, ${canonicalContent}, ${digest}, ${userID})
    `;
    await transaction`
      INSERT INTO factory.requirement_approval(
        id, ticket_id, requirement_revision_id, approved_by
      ) VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID})
    `;
    await transaction`
      INSERT INTO factory.change(
        id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
        state, created_by, cancelled_at
      ) VALUES (
        ${changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${branchName},
        ${"a".repeat(40)}, ${state}, ${userID},
        ${state === "cancelled" ? new Date().toISOString() : null}
      )
    `;
    await transaction`
      INSERT INTO factory.branch_create_operation(
        id, change_id, repository_owner, repository_name, branch_name, start_sha,
        idempotency_key, state, observed_head_sha, completed_at
      ) VALUES (
        ${crypto.randomUUID()}, ${changeID}, 'factory-mutation', 'ux-trust', ${branchName},
        ${"a".repeat(40)}, ${`ux-trust:${changeID}`}, 'succeeded', ${"a".repeat(40)}, now()
      )
    `;
  });
  return ticketID;
}

test.beforeEach(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(cleanupEvidenceDirectory, { recursive: true });
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  projectSlug = `ux-trust-${projectID.slice(0, 8)}`;
  await database.client`
    INSERT INTO factory.project(
      id, slug, name, repository_url, default_branch, devcontainer_path, created_by
    ) VALUES (
      ${projectID}, ${projectSlug}, 'UX trust fixture', 'https://example.invalid/ux-trust.git',
      'main', '.devcontainer/devcontainer.json', ${userID}
    )
  `;
  await database.client`
    INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
    VALUES (
      ${crypto.randomUUID()}, ${projectID}, 'Needs a specification', '', 'ready', ${userID}
    )
  `;
  await insertChangedTicket("Cancelled implementation", "cancelled");
  await insertChangedTicket("Delivered implementation", "delivered");
});

test.afterEach(async () => {
  for (const id of additionalProjectIDs) await deleteFactoryProject(id);
  additionalProjectIDs = [];
  if (projectID) await deleteFactoryProject(projectID);
  await database?.client.end();
  database = undefined;
  projectID = "";
  projectSlug = "";
});

test("settles Agent/workspace geometry with normal and reduced motion", async ({ page }) => {
  await signIn(page);
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements" })
    .getByRole("button")
    .filter({ hasText: "Needs a specification" })
    .click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Needs a specification",
  );
  const observations = [];
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion });
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "Toggle Agent panel" }).click();
      const layout = await waitForAgentWorkspaceLayout(page);
      expect(layout.gap).toBeGreaterThanOrEqual(0);
      expect(layout.moving).toBe(false);
      expect(layout.workspace.right).toBeLessThanOrEqual(width);
      observations.push({ reducedMotion, width, ...layout });
      await page.getByRole("button", { name: "Minimize Agent panel" }).click();
      await expect(page.getByRole("complementary", { name: "Agent panel" })).toHaveCount(0);
    }
  }
  await writeFile(
    `${cleanupEvidenceDirectory}/agent-workspace-settled-layout.json`,
    `${JSON.stringify(observations, null, 2)}\n`,
  );
});

test("keeps unsaved Ticket drafts attached to their Ticket across tabs and minimize", async ({
  page,
}) => {
  const otherID = crypto.randomUUID();
  if (!database) throw new Error("Database is not ready");
  await database.client`
    INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
    VALUES (${otherID}, ${projectID}, 'Second draft fixture', 'Second description', 'ready', ${userID})
  `;
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await selectProject(page);
  await page
    .getByRole("region", { name: "requirements" })
    .getByRole("button")
    .filter({ hasText: "Needs a specification" })
    .click();
  await page
    .getByRole("textbox", { name: "Ticket title", exact: true })
    .fill("Unsaved first Ticket");
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  await page
    .getByRole("region", { name: "requirements" })
    .getByRole("button")
    .filter({ hasText: "Second draft fixture" })
    .click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Second draft fixture",
  );
  await page
    .getByRole("textbox", { name: "Ticket title", exact: true })
    .fill("Unsaved second Ticket");
  await page
    .getByRole("tablist", { name: "Open workspace views" })
    .getByRole("tab", { name: "Needs a specification", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Unsaved first Ticket",
  );
  await page
    .getByRole("tablist", { name: "Open workspace views" })
    .getByRole("tab", { name: "Second draft fixture", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    "Unsaved second Ticket",
  );
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const draftLayout = await waitForAgentWorkspaceLayout(page);
  await writeFile(
    `${cleanupEvidenceDirectory}/record-owned-drafts-layout.json`,
    `${JSON.stringify(draftLayout, null, 2)}\n`,
  );
  await page.screenshot({
    path: `${cleanupEvidenceDirectory}/record-owned-drafts.png`,
    fullPage: true,
  });
  expect(draftLayout.gap).toBeGreaterThanOrEqual(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  const agentBounds = await page.getByRole("complementary", { name: "Agent panel" }).boundingBox();
  const boardBounds = await page.getByRole("region", { name: "Ticket board" }).boundingBox();
  expect(
    agentBounds && boardBounds && boardBounds.x > agentBounds.x + agentBounds.width,
  ).toBeTruthy();
  await page.screenshot({
    path: `${cleanupEvidenceDirectory}/agent-board-layout.png`,
    fullPage: true,
  });
});

test("keeps New Ticket keyboard focus inside the dialog and restores it on Escape", async ({
  page,
}) => {
  await signIn(page);
  await selectProject(page);
  const opener = page.getByRole("button", { name: "New Ticket", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New ticket" });
  await expect(dialog.getByRole("textbox", { name: "Ticket title" })).toBeFocused();
  await dialog.getByRole("button", { name: "Create Ticket", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close workspace" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("updates keyed Change activity on polling without remounting its disclosure", async ({
  page,
}) => {
  const ticketID = await insertChangedTicket("Live activity fixture", "active");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.change WHERE ticket_id = ${ticketID}
  `;
  if (!change) throw new Error("Missing fixture Change");
  let completed = false;
  await page.route(`**/api/changes/${change.id}/agent`, (route) =>
    route.fulfill({
      json: {
        state: "working",
        messages: [
          {
            id: "fixture-test-run",
            role: "tool",
            text: "Check implementation",
            at: 1,
            activity: {
              name: "Tests",
              status: completed ? "completed" : "running",
              detail: completed ? "All fixture tests passed" : "Running fixture tests",
            },
          },
        ],
      },
    }),
  );
  const panel = await openConversation(page);
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Live activity fixture" })
    .click();
  const activity = panel.locator(".agent-activity");
  await expect(activity.locator(".activity-status")).toHaveText("running");
  const indicator = activity.locator(".activity-indicator");
  const readMotion = () =>
    indicator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        animation: style.animationName,
        duration: style.animationDuration,
        iterations: style.animationIterationCount,
      };
    });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const normalMotion = await readMotion();
  expect(normalMotion).toMatchObject({ reduced: false, animation: "activity-pulse" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await readMotion();
  await writeFile(
    `${evidenceDirectory}/agent-reduced-motion${reducedMotion.animation === "none" ? "" : "-before"}.json`,
    `${JSON.stringify({ normalMotion, reducedMotion }, null, 2)}\n`,
  );
  expect(reducedMotion, "Reduced-motion users must not get an infinite Agent pulse").toMatchObject({
    reduced: true,
    animation: "none",
  });
  await expect(activity.locator(".activity-status")).toHaveText("running");
  await activity.locator("summary").click();
  await expect(activity.locator("pre")).toHaveText("Running fixture tests");
  const original = await activity.elementHandle();
  completed = true;
  await expect(activity.locator(".activity-status")).toHaveText("completed");
  await expect(activity.locator("pre")).toHaveText("All fixture tests passed");
  expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
  await expect(activity.locator("details")).toHaveAttribute("open", "");
});

test("keeps unconfirmed Stop distinct from a resumable stopped session", async ({ page }) => {
  const ticketID = await insertChangedTicket("Unconfirmed Stop recovery", "active");
  await insertConversation(projectID, ticketID, "build");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.change WHERE ticket_id = ${ticketID}
  `;
  if (!change) throw new Error("Missing fixture Change");
  let stopPending = true;
  const stopId = crypto.randomUUID();
  let state: "stopped" | "idle" | "failed" = "stopped";
  let runtimeState = "ready";
  let messagesAvailable = true;
  const turn = {
    id: crypto.randomUUID(),
    commandId: crypto.randomUUID(),
    state: "stopped",
    engine: "opencode",
    mode: "build",
    modelId: "controlled-stop-model",
    skills: [],
  };
  let reads = 0;
  let mutations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/changes/${change.id}/agent`))
      mutations++;
  });
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, modelRelayConfigured: true } });
  });
  await page.route(`**/api/changes/${change.id}/agent`, (route) => {
    reads++;
    return route.fulfill({
      json: {
        state,
        runtimeState,
        messagesAvailable,
        sessionAvailable: true,
        runtimeConnected: runtimeState === "ready",
        stopPending,
        stopId: stopPending ? stopId : null,
        messages: [],
        turn,
      },
    });
  });
  await openConversation(page);
  const panel = page.locator(".agent-panel");
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Unconfirmed Stop recovery" })
    .click();
  await expect(panel.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(panel).not.toContainText("Your next message resumes the session.", {
    timeout: 1_500,
  });
  await expect(panel.locator(".agent-state")).toHaveText("Stop unconfirmed", { timeout: 3_000 });
  const check = panel.getByRole("button", { name: "Check Stop status" });
  await expect(check).toBeVisible();
  // Hold the next lifecycle read before it reaches Agent status. The manual
  // check must work independently, not pass through the one-second poller.
  const releaseBackground = Promise.withResolvers<void>();
  let backgroundBlocked = false;
  await page.route(`**/api/changes?projectId=${projectID}`, async (route) => {
    backgroundBlocked = true;
    await releaseBackground.promise;
    await route.continue();
  });
  try {
    await expect.poll(() => backgroundBlocked).toBe(true);
    const before = reads;
    await check.click();
    await expect.poll(() => reads).toBe(before + 1);
    await expect(panel.locator(".agent-state")).toHaveText("Stop unconfirmed");
    expect(mutations).toBe(0);
    await mkdir(".factory/screenshots", { recursive: true });
    await page.screenshot({ path: ".factory/screenshots/unconfirmed-stop.png" });
    // Defensive fallback projections are a separate sequence from draft
    // retention: idle/failed legitimately unmount the existing composer.
    for (const nextState of ["idle", "failed"] as const) {
      state = nextState;
      await check.click();
      const start = panel.getByRole("button", {
        name: state === "idle" ? "Start implementation" : "Retry implementation",
      });
      await expect(start).toBeVisible();
      await expect(check).toBeEnabled();
      await expect(start).toBeDisabled();
    }
    state = "stopped";
    await check.click();
    await panel.getByLabel("Message conversation").fill("Retain my next instructions");
    runtimeState = "stopped";
    messagesAvailable = false;
    await check.click();
    await panel.getByText("Why is Build blocked?", { exact: true }).click();
    await expect(panel.getByRole("region", { name: "Stop recovery" })).toContainText(
      "reconnecting alone does not confirm Stop",
    );
    await expect(panel.getByLabel("Message conversation")).toHaveValue(
      "Retain my next instructions",
    );
    await page.setViewportSize({ width: 900, height: 900 });
    const bounds = await panel.boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 900).toBe(true);
    await page.screenshot({ path: `${evidenceDirectory}/unavailable-stop-narrow.png` });
    stopPending = false;
    runtimeState = "ready";
    messagesAvailable = true;
    await check.click();
    await expect(panel.locator(".agent-state")).toHaveText("Stopped");
    await expect(panel).toContainText("Your next message resumes the session.");
    await expect(check).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled();
    await expect(panel.getByLabel("Message conversation")).toHaveValue(
      "Retain my next instructions",
    );
    expect(mutations).toBe(0);
  } finally {
    releaseBackground.resolve();
  }
});

test("explicit Stop confirmation preserves the draft and sends only the displayed Stop identity", async ({
  page,
}) => {
  const ticketID = await insertChangedTicket("Explicit Stop confirmation", "active");
  await insertConversation(projectID, ticketID, "build");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.change WHERE ticket_id = ${ticketID}
  `;
  if (!change) throw new Error("Missing fixture Change");
  const stopId = crypto.randomUUID();
  let stopPending = true;
  let canConfirm = false;
  const mutations: string[] = [];
  const confirmations: unknown[] = [];
  const view = () => ({
    state: "stopped",
    stopPending,
    stopId: stopPending ? stopId : null,
    runtimeState: "ready",
    messagesAvailable: true,
    sessionAvailable: true,
    runtimeConnected: true,
    messages: [],
    lastError: stopPending ? "Stop remains unconfirmed. Ordered history is incomplete." : null,
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/"))
      mutations.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), modelRelayConfigured: true },
    });
  });
  await page.route(`**/api/changes/${change.id}/agent`, (route) => route.fulfill({ json: view() }));
  await page.route(`**/api/changes/${change.id}/agent/check-stop`, (route) => {
    confirmations.push(route.request().postDataJSON());
    if (canConfirm) stopPending = false;
    return route.fulfill({ json: view() });
  });
  await openConversation(page);
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Explicit Stop confirmation" })
    .click();
  const panel = page.locator(".agent-panel");
  await expect(panel.locator(".agent-state")).toHaveText("Stop unconfirmed");
  const draft = panel.getByLabel("Message conversation");
  await draft.fill("Keep these instructions for my next turn");
  const check = panel.getByRole("button", { name: "Recheck confirmation" });
  await expect(check).not.toBeVisible();
  await panel.getByText("Why is Build blocked?", { exact: true }).click();
  await expect(check).toBeVisible();
  const before = mutations.length;
  await check.click();
  await expect.poll(() => confirmations.length).toBe(1);
  await expect(check).toBeEnabled();
  await expect(panel.locator(".agent-state")).toHaveText("Stop unconfirmed");
  await expect(panel.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(draft).toHaveValue("Keep these instructions for my next turn");
  await expect(panel.getByRole("region", { name: "Stop recovery" })).toContainText(
    "Ordered history is incomplete.",
  );
  await expect(panel.locator(".agent-input-shell .inline-error")).toHaveCount(0);
  const directory = ".factory/test-results/ux-trust/stop-confirmation";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/unconfirmed-wide.png` });
  await page.setViewportSize({ width: 900, height: 900 });
  const bounds = await panel.boundingBox();
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 900).toBe(true);
  await page.screenshot({ path: `${directory}/unconfirmed-narrow.png` });
  canConfirm = true;
  await check.click();
  await expect(panel.locator(".agent-state")).toHaveText("Stopped");
  await expect(check).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled();
  await expect(draft).toHaveValue("Keep these instructions for my next turn");
  expect(confirmations).toEqual([{ stopId }, { stopId }]);
  expect(mutations.slice(before)).toEqual([
    `/api/changes/${change.id}/agent/check-stop`,
    `/api/changes/${change.id}/agent/check-stop`,
  ]);
  await page.screenshot({ path: `${directory}/confirmed-narrow.png` });
});

test("Stop confirmation endpoint authenticates and rejects missing or stale identity without starting compute", async ({
  page,
  request,
}) => {
  const ticketID = await insertChangedTicket("Stop confirmation endpoint", "active");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.change WHERE ticket_id = ${ticketID}
  `;
  if (!change) throw new Error("Missing fixture Change");
  const attemptId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const workspaceNamespace = `factory-workspace-${workspaceId.replaceAll("-", "").slice(0, 12)}`;
  const stopId = crypto.randomUUID();
  await database.client.begin(async (sql) => {
    await sql`INSERT INTO factory.development_workspace(id, project_id, kind, ticket_id, change_id,
      source_branch, source_revision, kubernetes_namespace, volume_name, created_by)
      SELECT ${workspaceId}, project_id, 'ticket', ticket_id, id, branch_name, base_sha,
        ${workspaceNamespace}, 'never-created', created_by FROM factory.change WHERE id = ${change.id}`;
    await sql`INSERT INTO factory.runtime_attempt(id, project_id, change_id, workspace_id, generation,
      revision, state, kubernetes_namespace, kubernetes_pod_name, parent_connector_token_hash,
      child_connector_token_hash, create_intended_at, created_by)
      SELECT ${attemptId}, project_id, id, ${workspaceId}, 1, base_sha, 'failed',
        ${workspaceNamespace}, 'never-created', ${"b".repeat(64)}, ${"c".repeat(64)}, now(), created_by
      FROM factory.change WHERE id = ${change.id}`;
    await sql`UPDATE factory.change SET runtime_attempt_id = ${attemptId} WHERE id = ${change.id}`;
    await sql`INSERT INTO factory.change_agent_session(change_id, runtime_attempt_id, opencode_session_id,
      state, stop_pending, stop_dispatched, stop_id, created_by)
      VALUES (${change.id}, ${attemptId}, 'ses_endpoint_fixture', 'stopped', true, true, ${stopId}, ${userID})`;
  });
  const endpoint = `/api/changes/${change.id}/agent/check-stop`;
  const headers = { origin: "http://127.0.0.1:3000" };
  expect((await request.post(endpoint, { headers, data: { stopId } })).status()).toBe(401);
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  const authenticated = page.context().request;
  expect((await authenticated.get(endpoint)).status()).toBe(405);
  for (const data of [{}, { stopId: "invalid" }, { stopId, restart: true }])
    expect((await authenticated.post(endpoint, { headers, data })).status()).toBe(400);
  expect(
    (
      await authenticated.post(endpoint, { headers, data: { stopId: crypto.randomUUID() } })
    ).status(),
  ).toBe(409);
  const response = await authenticated.post(endpoint, { headers, data: { stopId } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "stopped",
    stopPending: true,
    stopId,
    lastError: expect.stringContaining("Live Workspace status is unavailable"),
  });
  const attempts = await database.client<Array<{ state: string; uid: string | null }>>`
    SELECT state, kubernetes_uid AS uid FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
  expect([...attempts]).toEqual([{ state: "failed", uid: null }]);
  const turns =
    await database.client`SELECT id FROM factory.agent_turn WHERE project_id = ${projectID}`;
  expect(turns.length).toBe(0);
});

test("pending commit recovery blocks new Build without consuming the draft", async ({ page }) => {
  const ticketID = await insertChangedTicket("Pending commit recovery", "active");
  await insertConversation(projectID, ticketID, "build");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.change WHERE ticket_id = ${ticketID}
  `;
  if (!change) throw new Error("Missing fixture Change");
  const operationID = crypto.randomUUID();
  type CommitPhase = "commit-intended" | "committed" | "push-intended";
  let phase: CommitPhase = "commit-intended";
  let observedPhase: CommitPhase | undefined;
  let lastError: string | null = null;
  let state: "waiting" | "stopped" | "idle" | "failed" = "waiting";
  let stopPending = false;
  const stopId = crypto.randomUUID();
  const mutations: string[] = [];
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), modelRelayConfigured: true },
    });
  });
  await page.route(`**/api/changes/${change.id}/agent`, (route) => {
    observedPhase = phase;
    return route.fulfill({
      json: {
        state,
        runtimeState: "ready",
        stopPending,
        stopId: stopPending ? stopId : null,
        commitOperation: { id: operationID, state: phase, lastError },
        messagesAvailable: true,
        sessionAvailable: true,
        runtimeConnected: true,
        messages: [],
      },
    });
  });
  await openConversation(page);
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Pending commit recovery" })
    .click();
  const panel = page.locator(".agent-panel");
  const status = panel.locator(".agent-state");
  const draft = panel.getByLabel("Message conversation");
  const send = panel.getByRole("button", { name: "Send message" });
  await expect(status).toHaveText("Saving commit");
  const recoveryNotice = panel.getByRole("status", { name: "Commit recovery" });
  await expect(recoveryNotice).toBeVisible({ timeout: 3_000 });
  await expect(recoveryNotice).toHaveText(
    "Saving completed Build. New work waits for this commit.",
  );
  await draft.fill("Keep my next instructions while the commit is recovered");
  const directory = ".factory/test-results/ux-trust/commit-recovery-ux";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/saving-wide.png` });
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      request.url().includes("/api/")
    )
      mutations.push(new URL(request.url()).pathname);
  });
  for (const nextPhase of ["commit-intended", "committed", "push-intended"] as const) {
    phase = nextPhase;
    lastError = null;
    await expect.poll(() => observedPhase).toBe(nextPhase);
    await expect(status).toHaveText("Saving commit");
    lastError = `Commit outcome not confirmed for ${phase}.`;
    await expect(status).toHaveText("Commit unconfirmed");
    await expect(recoveryNotice).toHaveText(
      "Commit outcome unconfirmed. New Build waits for recovery.",
    );
    await expect(send).toBeDisabled();
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue("Keep my next instructions while the commit is recovered");
  }
  await page.screenshot({ path: `${directory}/unconfirmed-wide.png` });
  await page.setViewportSize({ width: 900, height: 900 });
  const bounds = await panel.boundingBox();
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 900).toBe(true);
  await page.screenshot({ path: `${directory}/unconfirmed-narrow.png` });
  state = "stopped";
  stopPending = true;
  await expect(status).toHaveText("Stop unconfirmed");
  await expect(recoveryNotice).toHaveCount(0);
  await expect(panel).not.toContainText("Your next message resumes the session.");
  await expect(send).toBeDisabled();
  await expect(draft).toHaveValue("Keep my next instructions while the commit is recovered");
  await page.screenshot({ path: `${directory}/stop-priority-narrow.png` });
  stopPending = false;
  for (const nextState of ["idle", "failed"] as const) {
    state = nextState;
    const start = panel.getByRole("button", {
      name: state === "idle" ? "Start implementation" : "Retry implementation",
    });
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute(
      "title",
      "Wait for the current commit operation to be recovered",
    );
  }
  expect(mutations).toEqual([]);
});

test("restores an unacknowledged message and its command identity after browser refresh", async ({
  page,
}) => {
  const submissions: Array<{ commandId: string; text: string }> = [];
  await page.route(`**/api/projects/${projectID}/conversation/message`, async (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) return route.abort("connectionreset");
    const submitted = submissions.at(-1);
    if (!submitted) throw new Error("Missing submitted command");
    return route.fulfill({
      json: {
        id: crypto.randomUUID(),
        projectId: projectID,
        mode: "investigate",
        version: 1,
        entries: [
          {
            id: crypto.randomUUID(),
            ordinal: 1,
            kind: "user-message",
            actor: "user",
            mode: "investigate",
            body: submitted.text,
            payload: { commandId: submitted.commandId },
            citations: [],
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
  });
  await openConversation(page);
  const panel = page.locator(".agent-panel");
  const message = "Keep this input until Factory confirms admission";
  await panel.getByLabel("Message conversation").fill(message);
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(panel.getByLabel("Message conversation")).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await selectProject(page);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(panel.getByLabel("Message conversation")).toHaveValue(message, {
    timeout: 3_000,
  });
  expect(submissions).toHaveLength(1);
  const directory = ".factory/test-results/ux-trust/browser-command-recovery";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/restored-message-wide.png` });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({ path: `${directory}/restored-message-narrow.png` });
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submissions.length).toBe(2);
  await expect(panel.getByLabel("Message conversation")).toHaveValue("");
  expect(submissions[1]?.commandId).toBe(submissions[0]?.commandId);
  // Acknowledged identical input is a new explicit request, not recovery of the earlier one.
  await panel.getByLabel("Message conversation").fill(message);
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submissions.length).toBe(3);
  expect(submissions[2]?.commandId).not.toBe(submissions[0]?.commandId);
});

for (const action of ["start", "prompt"] as const) {
  test(`retains Build ${action} command identity across refresh without automatic dispatch`, async ({
    page,
  }) => {
    const title = `Build ${action} browser identity`;
    const ticketID = await insertChangedTicket(title, "active");
    await insertConversation(projectID, ticketID, "build");
    if (!database) throw new Error("Database is not ready");
    const [change] = await database.client<Array<{ id: string }>>`
      SELECT id FROM factory.change WHERE ticket_id = ${ticketID}`;
    if (!change) throw new Error("Missing fixture Change");
    const view = {
      state: action === "start" ? "idle" : "stopped",
      messages: [],
      messagesAvailable: true,
      sessionAvailable: action !== "start",
      runtimeConnected: true,
      stopPending: false,
      stopId: null,
    };
    const submissions: Array<{ commandId: string; text?: string }> = [];
    await page.route(`**/api/changes/${change.id}/agent`, (route) => route.fulfill({ json: view }));
    await page.route(`**/api/changes/${change.id}/agent/${action}`, (route) => {
      submissions.push(route.request().postDataJSON());
      return submissions.length === 1
        ? route.abort("connectionreset")
        : route.fulfill({ json: view });
    });
    await page.route("**/api/session", async (route) => {
      const response = await route.fetch();
      return route.fulfill({
        response,
        json: { ...(await response.json()), modelRelayConfigured: true },
      });
    });
    await openConversation(page);
    const panel = page.locator(".agent-panel");
    const openTicket = () =>
      page
        .getByRole("region", { name: "implementation" })
        .getByRole("button")
        .filter({ hasText: title })
        .click();
    await openTicket();
    const button = panel.getByRole("button", {
      name: action === "start" ? "Start implementation" : "Send message",
      exact: true,
    });
    await expect(button).toBeEnabled();
    const text = "Keep the exact Build input after connection loss";
    if (action === "prompt") await panel.getByLabel("Message conversation").fill(text);
    await button.click();
    await expect.poll(() => submissions.length).toBe(1);
    await expect(button).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    await selectProject(page);
    await openTicket();
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    await expect(button).toBeEnabled();
    if (action === "prompt")
      await expect(panel.getByLabel("Message conversation")).toHaveValue(text);
    expect(submissions).toHaveLength(1);
    await button.click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1]).toEqual(submissions[0]);
  });
}

for (const type of ["free-text", "single-select", "multi-select"] as const) {
  test(`restores an Interview ${type} answer and its identity after browser refresh`, async ({
    page,
  }) => {
    const questionID = crypto.randomUUID();
    const submissions: Array<{ commandId: string; answer: { customText: string } }> = [];
    const view = {
      id: crypto.randomUUID(),
      projectId: projectID,
      mode: "plan",
      version: 1,
      entries: [
        {
          id: questionID,
          ordinal: 1,
          kind: "question",
          actor: "project-agent",
          mode: "plan",
          body: "What should happen?",
          payload: {
            question:
              type === "free-text"
                ? {
                    type,
                    prompt: "What should happen?",
                    placeholder: "Describe the result",
                  }
                : {
                    type,
                    prompt: "What should happen?",
                    allowCustom: false,
                    options: [
                      { id: "one", label: "First option" },
                      { id: "two", label: "Second option" },
                    ],
                  },
          },
          citations: [],
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await page.route(`**/api/projects/${projectID}/conversation`, (route) =>
      route.fulfill({ json: view }),
    );
    await page.route(`**/api/projects/${projectID}/conversation/answer`, (route) => {
      submissions.push(route.request().postDataJSON());
      return submissions.length === 1
        ? route.abort("connectionreset")
        : route.fulfill({ json: view });
    });
    await openConversation(page);
    const panel = page.locator(".agent-panel");
    const text = "Keep the approved services unchanged";
    if (type === "free-text") await panel.getByLabel("Custom answer").fill(text);
    else {
      await panel.getByLabel("First option", { exact: true }).check();
      if (type === "multi-select") await panel.getByLabel("Second option", { exact: true }).check();
    }
    await panel.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    await expect(panel.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    await selectProject(page);
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    if (type === "free-text") await expect(panel.getByLabel("Custom answer")).toHaveValue(text);
    else {
      await expect(panel.getByLabel("First option", { exact: true })).toBeChecked();
      if (type === "multi-select")
        await expect(panel.getByLabel("Second option", { exact: true })).toBeChecked();
    }
    expect(submissions).toHaveLength(1);
    await panel.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1]).toEqual(submissions[0]);
  });
}

test("only exact admitted command identity clears a recovered draft on read-only refresh", async ({
  page,
}) => {
  const submissions: Array<{ commandId: string; text: string }> = [];
  const text = "Identical text does not prove this command was admitted";
  let confirmed = false;
  const otherCommandID = crypto.randomUUID();
  const view = () => ({
    id: crypto.randomUUID(),
    projectId: projectID,
    mode: "investigate",
    version: 1,
    entries: submissions.length
      ? [
          {
            id: crypto.randomUUID(),
            ordinal: 1,
            kind: "user-message",
            actor: "user",
            mode: "investigate",
            body: text,
            payload: { commandId: confirmed ? submissions[0]?.commandId : otherCommandID },
            citations: [],
            createdAt: new Date().toISOString(),
          },
        ]
      : [],
  });
  await page.route(`**/api/projects/${projectID}/conversation`, (route) =>
    route.fulfill({ json: view() }),
  );
  await page.route(`**/api/projects/${projectID}/conversation/message`, (route) => {
    submissions.push(route.request().postDataJSON());
    return route.abort("connectionreset");
  });
  await openConversation(page);
  const panel = page.locator(".agent-panel");
  await panel.getByLabel("Message conversation").fill(text);
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByLabel("Message conversation")).toBeEnabled();
  await expect(panel.getByLabel("Message conversation")).toHaveValue(text);
  const returnToConversation = async () => {
    await page.reload();
    await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    await selectProject(page);
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  };
  await returnToConversation();
  await expect(panel.getByLabel("Message conversation")).toHaveValue(text);
  expect(submissions).toHaveLength(1);
  confirmed = true;
  await returnToConversation();
  await expect(panel.locator(".agent-message.user p")).toHaveText(text);
  await expect(panel.getByLabel("Message conversation")).toHaveValue("");
  await expect(panel.getByRole("status", { name: "Message recovery" })).toHaveCount(0);
  expect(submissions).toHaveLength(1);
  await panel.getByLabel("Message conversation").fill(text);
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]?.commandId).not.toBe(submissions[0]?.commandId);
});

test("blocked browser recovery storage prevents agent mutation", async ({ page }) => {
  const submissions: unknown[] = [];
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("factory:agent-commands:"))
        throw new Error("Owned recovery storage failure");
      return original.call(this, key, value);
    };
  });
  await page.route(`**/api/projects/${projectID}/conversation/message`, (route) => {
    submissions.push(route.request().postDataJSON());
    return route.abort();
  });
  await openConversation(page);
  const panel = page.locator(".agent-panel");
  await panel.getByLabel("Message conversation").fill("Do not dispatch without durable identity");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toContainText("Browser recovery storage is unavailable");
  expect(submissions).toHaveLength(0);
  await expect(panel.getByLabel("Message conversation")).toHaveValue(
    "Do not dispatch without durable identity",
  );
});

test("keeps Build ready, working and stopped states compact across workspace widths", async ({
  page,
}) => {
  const ticketID = await insertChangedTicket("Build state visual check", "active");
  await insertConversation(projectID, ticketID, "build");
  if (!database) throw new Error("Database is not ready");
  const [change] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.change WHERE ticket_id = ${ticketID}
  `;
  if (!change) throw new Error("Missing fixture Change");
  let state: "idle" | "working" | "stopped" = "idle";
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, modelRelayConfigured: true } });
  });
  await page.route(`**/api/changes/${change.id}/agent`, (route) =>
    route.fulfill({
      json: {
        state,
        stopPending: false,
        stopId: null,
        messagesAvailable: true,
        sessionAvailable: state !== "idle",
        runtimeConnected: true,
        messages:
          state === "idle"
            ? []
            : [
                {
                  id: "visual-build-reply",
                  role: "assistant",
                  text: "The implementation is in the Ticket Workspace. I am checking the approved criteria.",
                  at: 1,
                },
              ],
      },
    }),
  );
  await openConversation(page);
  const panel = page.locator(".agent-panel");
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Build state visual check" })
    .click();
  for (const nextState of ["idle", "working", "stopped"] as const) {
    state = nextState;
    if (state === "idle") {
      await expect(panel.getByRole("button", { name: "Start implementation" })).toBeEnabled();
      await expect(panel.getByLabel("Message conversation")).toHaveCount(0);
    } else {
      await expect(panel.getByLabel("Message conversation")).toBeVisible();
      await expect(panel.getByRole("button", { name: "Stop OpenCode" })).toHaveCount(
        state === "working" ? 1 : 0,
      );
      await expect(panel.getByRole("button", { name: "Send message" })).toHaveText(
        state === "working" ? /Send/ : /Resume/,
      );
      if (state === "stopped")
        await expect(panel).toContainText("Your next message resumes the session.");
    }
    const stateBounds = await panel.locator(".agent-state").boundingBox();
    await expect(panel.locator(".agent-state")).not.toHaveClass(/sr-only/);
    await expect(panel.locator(".agent-state")).toHaveText(
      state === "idle" ? "Ready to build" : state === "working" ? "Working" : "Stopped",
    );
    expect(stateBounds?.width).toBeGreaterThanOrEqual(28);
    expect(stateBounds?.height).toBeGreaterThanOrEqual(12);
    for (const width of [1440, 1280, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(panel).toBeVisible();
      const bounds = await panel.boundingBox();
      if (!bounds) throw new Error("Missing Build panel geometry");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
      const textSizes = await panel
        .locator(
          ".agent-control, .agent-activity-heading small, .activity-status, .agent-activity summary, .agent-configuration-note, .conversation-modes button",
        )
        .evaluateAll((elements) =>
          elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
        );
      expect(textSizes.length).toBeGreaterThan(0);
      for (const size of textSizes) expect(size).toBeGreaterThanOrEqual(11);
      await page.screenshot({
        path: `${evidenceDirectory}/build-${state}-${width}.png`,
        fullPage: true,
      });
    }
  }
});

test("does not offer a partial IDE target list before scoped lifecycle data arrives", async ({
  page,
}) => {
  await insertChangedTicket("Delayed runtime target", "active");
  let release = () => {};
  let observed = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  await page.route(`**/api/changes?projectId=${projectID}`, async (route) => {
    observed();
    await gate;
    await route.continue();
  });
  await signIn(page);
  await selectProject(page);
  await intercepted;
  await expect(page.getByRole("button", { name: "IDE", exact: true })).toHaveCount(0);
  release();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const menu = page.getByRole("menu", { name: "IDE instances" });
  await expect(menu.getByRole("menuitem", { name: /My workspace/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Delayed runtime target/ })).toBeVisible();
});

test("shows a retryable refresh failure without losing the desktop", async ({ page }) => {
  let unavailable = true;
  await page.route(`**/api/changes?projectId=${projectID}`, async (route) => {
    if (unavailable)
      await route.fulfill({ status: 503, json: { error: "Temporary lifecycle outage" } });
    else await route.continue();
  });
  await signIn(page);
  await selectProject(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: "Updates paused" });
  await expect(notice).toContainText("Showing the last known state.");
  await page.screenshot({
    path: `${cleanupEvidenceDirectory}/refresh-recovery.png`,
    fullPage: true,
  });
  unavailable = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(notice).toBeHidden();
});

test("can retry opening Factory after bootstrap is unavailable", async ({ page }) => {
  let unavailable = true;
  await page.route("**/api/session", (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: "Session service unavailable" } })
      : route.continue(),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Session service unavailable");
  unavailable = false;
  await page.getByRole("button", { name: "Retry opening Factory" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("keeps a delayed Workspace response in its original Project", async ({ page }) => {
  const other = await insertOtherProjectConversation();
  let release = () => {};
  let observed = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  await page.route(`**/api/projects/${projectID}/personal-workspace/ensure`, async (route) => {
    observed();
    await gate;
    await route.fulfill({
      json: {
        id: "delayed-attempt",
        projectId: projectID,
        state: "starting",
        runtimeKind: "personal",
        workspaceKind: "personal",
        workspaceId: "workspace",
        ownerUserId: userID,
      },
    });
  });
  await signIn(page);
  await selectProject(page);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await intercepted;
  await selectProject(page, other.slug);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  release();
  const tabs = page.getByRole("tablist", { name: "Open workspace views" });
  await expect(tabs.getByRole("tab", { name: /^IDE ·/ })).toHaveCount(0);
  await selectProject(page);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(tabs.getByRole("tab", { name: "IDE · My workspace", exact: true })).toHaveCount(1);
  await tabs.getByRole("tab", { name: "IDE · My workspace", exact: true }).click();
  await expect(page.locator('iframe[title="Factory IDE"]')).toHaveCount(0);
  await expect(page.getByText("The Workspace is not running. Open IDE to retry.")).toBeVisible();
});

test("contains narrow Agent focus and restores the same Ticket context", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await signIn(page);
  await selectProject(page);
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByText("Needs a specification", { exact: true })
    .click();
  const title = page.getByRole("textbox", { name: "Ticket title", exact: true });
  await title.focus();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("dialog", { name: "Agent panel" });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".workspace-window")).toHaveAttribute("inert", "");
  await expect(page.locator(".factory-topbar")).toHaveAttribute("inert", "");
  await expect(page.getByRole("region", { name: "Ticket board" })).toHaveCount(0);
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let index = 0; index < 16; index++) {
      await page.keyboard.press(key);
      expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
  }
  await page.screenshot({ path: `${evidenceDirectory}/narrow-agent.png` });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(title).toBeFocused();
  await expect(page.locator(".workspace-window")).not.toHaveAttribute("inert", "");
  await expect(
    page.getByRole("tab", { name: "Needs a specification", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await page.getByRole("button", { name: "Dismiss Agent overlay" }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Agent panel", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss Agent overlay" })).toHaveCount(0);
  await expect(page.locator(".workspace-window")).not.toHaveAttribute("inert", "");
  await title.focus();
  await expect(title).toBeFocused();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(panel).toBeVisible();
  await expect(page.locator(".workspace-window")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(title).toBeFocused();
});

for (const crossOrigin of [false, true]) {
  test(`returns to the embedded input after dismissing the narrow Agent (${crossOrigin ? "cross-origin" : "same-origin"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const attemptID = crypto.randomUUID();
    await page.route(`**/api/runtime-attempts?projectId=${projectID}`, (route) =>
      route.fulfill({
        json: {
          attempts: [
            {
              id: attemptID,
              projectId: projectID,
              workspaceId: "focus-return-fixture",
              workspaceKind: "personal",
              runtimeKind: "personal",
              ownerUserId: userID,
              state: "ready",
            },
          ],
        },
      }),
    );
    const body = `<!doctype html><html><body><textarea aria-label="Embedded input"></textarea><button type="button">Other control</button><script>{const exports = {}; ${frameFocusScript}; const unbind = exports.bindFactoryFrameFocus(window); document.addEventListener("dispose-focus-fixture", unbind, {once: true});}</script></body></html>`;
    const documentURL = `http://${attemptID.replaceAll("-", "")}.ide.runtime.localhost:3000/focus-fixture`;
    if (crossOrigin) {
      await page.route(documentURL, (route) => route.fulfill({ contentType: "text/html", body }));
    }
    await page.route("**/api/runtime-access?*", (route) =>
      crossOrigin
        ? route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><script>location.replace(${JSON.stringify(documentURL)})</script>`,
          })
        : route.fulfill({
            contentType: "text/html",
            body,
          }),
    );
    await signIn(page);
    await selectProject(page);
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    const iframe = page.locator('iframe[title="Factory IDE"]');
    const input = page.frameLocator('iframe[title="Factory IDE"]').getByLabel("Embedded input");
    await input.click();
    await expect(input).toBeFocused();
    const agent = page.getByRole("dialog", { name: "Agent panel" });
    for (const dismissal of ["Escape", "backdrop"]) {
      await page.getByRole("button", { name: "Toggle Agent panel" }).click();
      await expect(agent).toBeVisible();
      if (dismissal === "Escape") await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: "Dismiss Agent overlay" }).click();
      await expect(agent).toHaveCount(0);
      await expect(iframe).toBeFocused();
      await expect(input).toBeFocused({ timeout: 3_000 });
    }
    await page.keyboard.type("focus-return-input");
    await expect(input).toHaveValue("focus-return-input");
    const frameBody = page.frameLocator('iframe[title="Factory IDE"]').locator("body");
    for (const unavailable of ["hidden", "disabled", "removed"]) {
      await input.click();
      await page.getByRole("button", { name: "Toggle Agent panel" }).click();
      await expect(agent).toBeVisible();
      await input.evaluate((element, reason) => {
        if (!(element instanceof HTMLTextAreaElement))
          throw new Error("Expected embedded textarea");
        if (reason === "hidden") element.hidden = true;
        else if (reason === "disabled") element.disabled = true;
        else element.remove();
      }, unavailable);
      await page.keyboard.press("Escape");
      await expect(agent).toHaveCount(0);
      await expect(iframe).toBeFocused();
      expect(await frameBody.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
      await frameBody.evaluate(() => {
        let field = document.querySelector("textarea");
        if (!field) {
          field = document.createElement("textarea");
          field.setAttribute("aria-label", "Embedded input");
          document.body.prepend(field);
        }
        field.hidden = false;
        field.disabled = false;
      });
    }
    await input.click();
    await input.evaluate(() => document.dispatchEvent(new Event("dispose-focus-fixture")));
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    await expect(agent).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(agent).toHaveCount(0);
    await expect(iframe).toBeFocused();
    expect(await input.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  });
}

test("dismisses Project and Settings popovers with keyboard focus returned to their opener", async ({
  page,
}) => {
  await signIn(page);
  await selectProject(page);
  const projectOpener = page.getByRole("button", { name: "Open project menu" });
  await projectOpener.click();
  const projects = page.getByRole("region", { name: "Projects", exact: true });
  await expect(projects).toBeVisible();
  await expect
    .poll(() => projects.evaluate((element) => element.contains(document.activeElement)), {
      timeout: 5_000,
    })
    .toBe(true);
  const search = projects.getByRole("searchbox", { name: "Search projects" });
  if (await search.isVisible()) {
    await search.fill(projectSlug);
    await search.press("ArrowDown");
  }
  await page.keyboard.press("End");
  await expect(projects.locator("button").last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(projects.getByRole("button", { name: "Add project", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(projects).toHaveCount(0);
  await expect(projectOpener).toBeFocused();

  const settingsOpener = page.getByRole("button", { name: "Settings", exact: true });
  const background = await page.locator(".factory-desktop").getAttribute("data-background");
  await settingsOpener.click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.locator('[aria-pressed="true"]')).toBeFocused();
  await page.keyboard.press("End");
  await expect(settings.locator("button").last()).toBeFocused();
  await expect(page.locator(".factory-desktop")).toHaveAttribute(
    "data-background",
    background ?? "",
  );
  await page.keyboard.press("Tab");
  await expect(settings).toHaveCount(0);
  await expect(settingsOpener).not.toBeFocused();
  await settingsOpener.click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(settingsOpener).toBeFocused();
  await projectOpener.click();
  await settingsOpener.click();
  await expect(projects).toHaveCount(0);
  await expect(settings).toBeVisible();
  await page
    .getByRole("button", { name: "Close menu", exact: true })
    .click({ position: { x: 30, y: 150 } });
  await expect(settings).toHaveCount(0);
  await expect(projectOpener).toHaveAttribute("aria-expanded", "false");
  await expect(settingsOpener).toHaveAttribute("aria-expanded", "false");
});

test("aligns workspace and Agent Minimize geometry and preserves the Agent control style", async ({
  page,
}) => {
  await signIn(page);
  await selectProject(page);
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByText("Needs a specification", { exact: true })
    .click();
  const toggle = page.getByRole("button", { name: "Toggle Agent panel" });
  const closedIcon = await toggle.locator("svg").innerHTML();
  const controlStyle = () =>
    toggle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.width,
        height: style.height,
        background: style.backgroundColor,
        borderRadius: style.borderRadius,
      };
    });
  const closedStyle = await controlStyle();
  await toggle.click();
  expect(await toggle.locator("svg").innerHTML()).not.toBe(closedIcon);
  expect(await controlStyle()).toEqual(closedStyle);
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = async (container: string) =>
      page.locator(container).evaluate((element) => {
        const action = element.querySelector(".window-minimize-control");
        if (!action) throw new Error("Missing Minimize action");
        const panel = element.getBoundingClientRect();
        const button = action.getBoundingClientRect();
        return {
          top: button.top - panel.top,
          right: panel.right - button.right,
          width: button.width,
          height: button.height,
          radius: getComputedStyle(action).borderRadius,
        };
      });
    const workspace = await geometry(".workspace-window");
    await expect
      .poll(async () => {
        const measured = await geometry(".agent-panel");
        return { width: measured.width, height: measured.height };
      })
      .toEqual({ width: workspace.width, height: workspace.height });
    const agent = await geometry(".agent-panel");
    expect(agent.width).toBe(workspace.width);
    expect(agent.height).toBe(workspace.height);
    expect(agent.radius).toBe(workspace.radius);
    expect(Math.abs(agent.top - workspace.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(agent.right - workspace.right)).toBeLessThanOrEqual(1);
    await expect(page.locator(".workspace-heading")).toHaveCount(0);
  }
});

test("opens Project registration as a focused dialog and preserves rejected input", async ({
  page,
}) => {
  await signIn(page);
  await selectProject(page);
  const opener = page.getByRole("button", { name: "Open project menu" });
  await opener.click();
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a repository", exact: true });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("region", { name: "Projects" })).toHaveCount(0);
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await name.fill("A rejected project draft");
  await dialog.getByRole("textbox", { name: "Slug", exact: true }).fill("draft-registration");
  await dialog
    .getByRole("textbox", { name: "Repository URL", exact: true })
    .fill("https://example.invalid/draft.git");
  await dialog.getByText("Advanced settings", { exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Default branch", exact: true })).toHaveValue(
    "main",
  );
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({ status: 422, json: { error: "Repository cannot be registered" } });
  });
  await dialog.getByRole("button", { name: "Register Project", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Repository cannot be registered");
  await expect(name).toHaveValue("A rejected project draft");
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press(key);
      const focus = await dialog.evaluate((element) => ({
        inside: element.contains(document.activeElement),
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
      }));
      expect(focus, `Focus after ${key} at step ${index}`).toMatchObject({ inside: true });
    }
  }
  await page.screenshot({ path: `${evidenceDirectory}/project-registration-dialog.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("uses readable workspace tabs with keyboard navigation and an accessible overflow chooser", async ({
  page,
}) => {
  if (!database) throw new Error("Database is not ready");
  const tabTitle = (index: number) =>
    `Long workspace title ${index}: preserve the full readable context`;
  const titles = Array.from({ length: 7 }, (_, index) => tabTitle(index + 1));
  for (const title of titles) {
    await database.client`
      INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
      VALUES (${crypto.randomUUID()}, ${projectID}, ${title}, 'Tab navigation fixture', 'inbox', ${userID})
    `;
  }
  await page.route(`**/api/projects/${projectID}/knowledge/documents`, (route) =>
    route.fulfill({ json: { commitSha: "a".repeat(40), documents: [] } }),
  );
  await page.route(`**/api/projects/${projectID}/knowledge/generation`, (route) =>
    route.fulfill({
      json: {
        id: crypto.randomUUID(),
        sourceCommitSha: "a".repeat(40),
        state: "succeeded",
        pageCount: 0,
        conflictCount: 0,
        failure: null,
      },
    }),
  );
  await page.setViewportSize({ width: 900, height: 720 });
  await signIn(page);
  await selectProject(page);
  for (const title of titles) {
    await page
      .getByRole("region", { name: "Ticket board" })
      .getByText(title, { exact: true })
      .click();
    await page.getByRole("button", { name: "Minimize workspace" }).click();
  }
  const dock = page.getByRole("navigation", { name: "Workspace dock" });
  await dock.getByRole("button", { name: "Inbox", exact: true }).click();
  await dock.getByRole("button", { name: "Knowledge", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Open workspace views" });
  await expect(tabs).toBeVisible({ timeout: 5_000 });
  await expect(tabs.getByRole("tab")).toHaveCount(9);
  const first = tabs.getByRole("tab", { name: tabTitle(1), exact: true });
  await expect(first).toHaveAttribute("title", tabTitle(1));
  expect(
    await first.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(12);
  const knowledge = tabs.getByRole("tab", { name: "Knowledge", exact: true });
  await knowledge.focus();
  await knowledge.press("Home");
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await first.press("End");
  await expect(knowledge).toBeFocused();
  await knowledge.press("ArrowLeft");
  const inbox = tabs.getByRole("tab", { name: "Inbox", exact: true });
  await expect(inbox).toBeFocused();
  await inbox.press("ArrowRight");
  await expect(knowledge).toBeFocused();
  await knowledge.press("Delete");
  await expect(knowledge).toHaveCount(0);
  await expect(inbox).toBeFocused();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    (await inbox.getAttribute("id")) ?? "",
  );
  const overflow = page.getByRole("button", { name: "Choose an open tab", exact: true });
  await expect(overflow).toBeVisible();
  await overflow.click();
  const menu = page.getByRole("menu", { name: "Open tabs" });
  await expect(menu).toBeVisible();
  const menuMaterial = await menu.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(rgb(menuMaterial).alpha, "Chooser must not reveal competing document text").toBe(1);
  await menu.getByRole("menuitemradio", { name: tabTitle(3), exact: true }).click();
  const chosen = tabs.getByRole("tab", { name: tabTitle(3), exact: true });
  await expect(chosen).toBeFocused();
  await expect(chosen).toHaveAttribute("aria-selected", "true");
  await overflow.click();
  await page.screenshot({ path: `${evidenceDirectory}/workspace-tabs-menu.png` });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(overflow).toBeFocused();
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 5_000 });
  await page.screenshot({ path: `${evidenceDirectory}/workspace-tabs-overflow.png` });
});

test("keeps outer workspace geometry when switching Ticket, Inbox, and Knowledge", async ({
  page,
}) => {
  await page.route(`**/api/projects/${projectID}/knowledge/documents`, (route) =>
    route.fulfill({ json: { commitSha: "a".repeat(40), documents: [] } }),
  );
  await signIn(page);
  await selectProject(page);
  const dock = page.getByRole("navigation", { name: "Workspace dock" });
  const window = page.locator(".workspace-window");
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const agentOpen of [false, true]) {
      if (agentOpen) await page.getByRole("button", { name: "Toggle Agent panel" }).click();
      await page
        .getByRole("region", { name: "Ticket board" })
        .getByText("Needs a specification", { exact: true })
        .click();
      await window.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      const baseline = await window.boundingBox();
      expect(baseline).not.toBeNull();
      for (const name of ["Inbox", "Knowledge"]) {
        await dock.getByRole("button", { name, exact: true }).click();
        await expect.poll(() => window.boundingBox()).toEqual(baseline);
      }
      if (agentOpen) await page.getByRole("button", { name: "Minimize Agent panel" }).click();
      await page.getByRole("button", { name: "Minimize workspace" }).click();
    }
  }
});

test("retains exact runtime frames across tab switches and minimize, disposing only closed or replaced frames", async ({
  page,
}) => {
  let attemptID = crypto.randomUUID();
  let boots = 0;
  const originalAttemptID = attemptID;
  await page.route(`**/api/runtime-attempts?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
        attempts: [
          {
            id: attemptID,
            projectId: projectID,
            workspaceId: "personal-workspace",
            workspaceKind: "personal",
            runtimeKind: "personal",
            ownerUserId: userID,
            state: "ready",
          },
        ],
      },
    }),
  );
  await page.route("**/api/runtime-access?*", (route) => {
    boots++;
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><textarea aria-label="Unsaved editor"></textarea></body></html>',
    });
  });
  await signIn(page);
  await selectProject(page);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const frame = page.locator('iframe[title="Factory IDE"]');
  const editor = page
    .frameLocator('iframe[title="Factory IDE"]')
    .locator('textarea[aria-label="Unsaved editor"]');
  await editor.fill("unsaved buffer and selection");
  expect(boots).toBe(1);
  await expect
    .poll(async () => {
      const bodyBox = await page.locator(".workspace-view-body").boundingBox();
      const frameBox = await frame.boundingBox();
      if (!bodyBox || !frameBox) return false;
      return (["x", "y", "width", "height"] as const).every(
        (key) => Math.abs(bodyBox[key] - frameBox[key]) <= 1,
      );
    })
    .toBe(true);
  expect(await page.locator(".factory-desktop").evaluate((desktop) => desktop.scrollTop)).toBe(0);
  await page
    .getByRole("navigation", { name: "Workspace dock" })
    .getByRole("button", { name: "Inbox", exact: true })
    .click();
  await expect(frame).toHaveCount(1);
  await expect(frame).toBeHidden();
  await expect(page.locator(".runtime-workspace-tab[hidden]")).toHaveAttribute("inert", "");
  await editor.evaluate((input) => input.focus());
  expect(await frame.evaluate((element) => document.activeElement === element)).toBe(false);
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    expect(await frame.evaluate((element) => document.activeElement === element)).toBe(false);
  }
  const tabs = page.getByRole("tablist", { name: "Open workspace views" });
  await tabs.getByRole("tab", { name: "IDE · My workspace", exact: true }).click();
  await expect(editor).toHaveValue("unsaved buffer and selection");
  expect(boots).toBe(1);
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  await expect(frame).toHaveCount(1);
  await expect(frame).toBeHidden();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(editor).toHaveValue("unsaved buffer and selection");
  expect(boots).toBe(1);
  attemptID = crypto.randomUUID();
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      return frame.getAttribute("src");
    })
    .toContain(attemptID);
  await expect(frame).toHaveCount(1);
  await expect(editor).toHaveValue("");
  expect(await frame.getAttribute("src")).not.toContain(originalAttemptID);
  expect(boots).toBe(2);
  await page
    .getByRole("navigation", { name: "Workspace dock" })
    .getByRole("button", { name: "Inbox", exact: true })
    .click();
  await tabs.getByRole("button", { name: "Close IDE · My workspace", exact: true }).click();
  await expect(frame).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "Inbox", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(editor).toHaveValue("");
  expect(boots).toBe(3);
  const otherProject = await insertOtherProjectConversation();
  await selectProject(page, otherProject.slug);
  await expect(frame).toHaveCount(0);
  await selectProject(page);
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(frame).toHaveAttribute("data-runtime-attempt-id", attemptID);
  await expect(editor).toHaveValue("");
  expect(boots).toBe(4);
});

test("keeps board labels readable without repeating lane status and uses a full-width archive", async ({
  page,
}) => {
  await insertChangedTicket("Failed implementation", "failed");
  await signIn(page);
  await selectProject(page);
  const board = page.getByRole("region", { name: "Ticket board" });
  const card = board.getByRole("button").filter({ hasText: "Needs a specification" });
  await expect(card.getByText("Requirements", { exact: true })).toHaveCount(0);
  await expect(
    board.getByRole("button").filter({ hasText: "Failed implementation" }),
  ).toContainText("Change failed");
  const header = board
    .getByRole("region", { name: "requirements", exact: true })
    .locator(".lane-heading");
  await expect
    .poll(() => header.evaluate((element) => getComputedStyle(element).textTransform))
    .toBe("none");
  const separation = await card.evaluate((element) => {
    const heading = element.parentElement?.querySelector(".lane-heading");
    if (!heading) throw new Error("Missing lane heading");
    return element.getBoundingClientRect().top - heading.getBoundingClientRect().bottom;
  });
  expect(separation).toBeGreaterThanOrEqual(12);
  await page.screenshot({ path: `${evidenceDirectory}/board-active.png` });
  await board.getByRole("button", { name: "Completed 2", exact: true }).click();
  const archive = board.getByRole("region", { name: "history", exact: true });
  await expect(
    archive.getByRole("button").filter({ hasText: "Delivered implementation" }),
  ).toContainText("Delivered");
  await expect(
    archive.getByRole("button").filter({ hasText: "Cancelled implementation" }),
  ).toContainText("Cancelled");
  for (const width of [1440, 1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const ratio = await archive.evaluate(
      (element) =>
        element.getBoundingClientRect().width /
        (element.closest(".board-history")?.getBoundingClientRect().width ?? 1),
    );
    expect(ratio).toBeGreaterThan(0.95);
    const row = await archive.locator("button").first().boundingBox();
    const container = await archive.boundingBox();
    if (!row || !container) throw new Error("Missing archive geometry");
    expect(row.width / container.width).toBeGreaterThan(0.9);
  }
  await page.screenshot({ path: `${evidenceDirectory}/board-archive.png` });
  await board.getByRole("button", { name: "Active work", exact: true }).click();
  await expect(board.getByRole("region", { name: "requirements", exact: true })).toBeVisible();
});

test("keeps board text readable on every artwork at desktop and narrow widths", async ({
  page,
}) => {
  await signIn(page);
  await selectProject(page);
  const board = page.getByRole("region", { name: "Ticket board" });
  // Zero Tickets can arrive before their lifecycle projection. Capture resolved stages.
  await expect(board.getByRole("button", { name: "Completed 2", exact: true })).toBeVisible();
  await expect(
    board.getByRole("button").filter({ hasText: "Delivered implementation" }),
  ).toHaveCount(0);
  await expect(
    board.getByRole("button").filter({ hasText: "Cancelled implementation" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").filter({
      hasText: "Needs a specification",
    }),
  ).toBeVisible();
  const desktop = page.locator(".factory-desktop");
  const readings: { width: number; background: string; minimumContrast: number }[] = [];
  for (const width of [1440, 1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    for (const background of ["river-landscape", "mountainous-landscape", "the-harvesters"]) {
      // Presentation-only variants, never a write to the signed-in user's preference.
      await desktop.evaluate(async (element, key) => {
        element.setAttribute("data-background", key);
        const art = getComputedStyle(element).getPropertyValue("--desktop-art");
        const path = art.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
        if (!path) throw new Error("Selected artwork is absent");
        const image = new Image();
        image.src = path;
        await image.decode();
      }, background);
      const observed = await desktop.evaluate((element) => ({
        art: getComputedStyle(element, "::before").backgroundImage,
        scrim: getComputedStyle(element, "::after").backgroundImage,
        cards: [...element.querySelectorAll(".lane-heading, .ticket-card")].map((card) => ({
          background: getComputedStyle(card).backgroundColor,
          colors: [...card.querySelectorAll("span, small, strong")].map((text) => ({
            label: text.textContent,
            color: getComputedStyle(text).color,
          })),
        })),
      }));
      expect(observed.art).toContain(`${background}.jpg`);
      const stops = [...observed.scrim.matchAll(/rgba?\([^)]+\)/g)].map((stop) => rgb(stop[0]));
      expect(stops.length).toBeGreaterThan(0);
      // The scrim's darkest possible pixel is composited over black artwork. The card
      // material sits above that floor. This does not assume a conveniently pale painting.
      const canvasFloor = [0, 1, 2].map((index) =>
        Math.min(...stops.map((stop) => (stop.channels[index] ?? 0) * stop.alpha)),
      );
      let minimumContrast = Infinity;
      for (const card of observed.cards) {
        const material = rgb(card.background);
        const paperFloor = luminance(
          material.channels.map(
            (channel, index) =>
              channel * material.alpha + (canvasFloor[index] ?? 0) * (1 - material.alpha),
          ),
        );
        for (const { label, color } of card.colors) {
          const text = rgb(color);
          expect(text.alpha).toBe(1);
          const ratio = (paperFloor + 0.05) / (luminance(text.channels) + 0.05);
          minimumContrast = Math.min(minimumContrast, ratio);
          expect(
            ratio,
            `${width}px ${background}: ${label}, ${color} on ${card.background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      readings.push({ width, background, minimumContrast });
      await writeFile(
        `${evidenceDirectory}/board-contrast.json`,
        `${JSON.stringify(
          {
            readings,
            conditions:
              "Chromium, scrim/card material composited above black artwork. Opaque heading/reference/title/status text, no persisted preference changes. Conservative floor, not sampled artwork pixels.",
          },
          null,
          2,
        )}\n`,
      );
      await page.screenshot({
        path: `${evidenceDirectory}/board-${background}-${width}.png`,
        fullPage: true,
      });
    }
  }
});

test("respects reduced motion for the board, workspace, Agent and popovers", async ({ page }) => {
  await signIn(page);
  await selectProject(page);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true,
  );
  const assertReduced = async (selector: string) => {
    const durations = await page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return [...style.animationDuration.split(","), ...style.transitionDuration.split(",")].map(
        (duration) => Number.parseFloat(duration) * (duration.trim().endsWith("ms") ? 1 : 1000),
      );
    });
    expect(Math.max(...durations)).toBeLessThanOrEqual(1);
  };
  await assertReduced(".board-enter");
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByText("Needs a specification", { exact: true })
    .click();
  await assertReduced(".workspace-window");
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await assertReduced(".agent-panel");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await assertReduced(".settings-menu");
});

test("keeps Knowledge drafts with their page across navigation and minimize", async ({ page }) => {
  if (!database) throw new Error("Database is not ready");
  for (const name of ["First", "Second"]) {
    await database.client`
      INSERT INTO factory.knowledge_page(id, project_id, slug, title, current_body, generated_body, source_commit_sha, created_by)
      VALUES (${crypto.randomUUID()}, ${projectID}, ${name.toLowerCase()}, ${`${name} knowledge`}, ${`${name} original body`}, ${`${name} original body`}, ${"a".repeat(40)}, ${userID})
    `;
  }
  await page.route(`**/api/projects/${projectID}/knowledge/documents`, (route) =>
    route.fulfill({ json: { commitSha: "a".repeat(40), documents: [] } }),
  );
  await signIn(page);
  await selectProject(page);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: "First knowledge", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByRole("textbox", { name: "Markdown source" }).fill("Unsaved first-page draft");
  await page.getByRole("button", { name: "Second knowledge", exact: true }).click();
  await expect(page.locator(".knowledge-article")).toContainText("Second original body");
  await expect(page.locator(".knowledge-article")).not.toContainText("Unsaved first-page draft");
  await page.getByRole("button", { name: "First knowledge", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Knowledge body" })).toContainText(
    "Unsaved first-page draft",
  );
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Knowledge body" })).toContainText(
    "Unsaved first-page draft",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".knowledge-article")).toContainText("First original body");
});

test("rejects specification rewrites after approval on the server", async ({ page }) => {
  const ticketID = await insertChangedTicket("Immutable approval fixture", "active");
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  const response = await page.request.post(`/api/tickets/${ticketID}/requirements`, {
    headers: { origin: "http://127.0.0.1:3000" },
    data: { summary: "Unauthorized rewrite", acceptanceCriteria: ["Should reject"], nonGoals: [] },
  });
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: "conflict" });
});

test("shows Knowledge proposals and saves past their immutable ordinals", async ({ page }) => {
  if (!database) throw new Error("Database is not ready");
  const pageID = crypto.randomUUID();
  const original =
    "## Human section\n\nHuman content stays visible.\n\n```ts\n  const x = 1;\n```\n\n3. Third\n4. Fourth";
  await database.client`
    INSERT INTO factory.knowledge_page(id, project_id, slug, title, current_body, generated_body, source_commit_sha, created_by)
    VALUES (${pageID}, ${projectID}, 'cleanup-knowledge', 'Cleanup knowledge', ${original}, ${original}, ${"a".repeat(40)}, ${userID})
  `;
  for (const ordinal of [1, 2])
    await database.client`
    INSERT INTO factory.knowledge_revision(id, page_id, ordinal, kind, title, body, generated_body, source_commit_sha, created_by)
    VALUES (${crypto.randomUUID()}, ${pageID}, ${ordinal}, ${ordinal === 1 ? "generated" : "proposed"}, 'Cleanup knowledge', ${original}, ${ordinal === 1 ? original : "## Proposed section\n\nNew generated content."}, ${"a".repeat(40)}, ${userID})
  `;
  await database.client`
    INSERT INTO factory.knowledge_generation(id, project_id, source_commit_sha, state, page_count, conflict_count, created_by, completed_at)
    VALUES (${crypto.randomUUID()}, ${projectID}, ${"a".repeat(40)}, 'succeeded', 1, 1, ${userID}, now())
  `;
  await page.route(`**/api/projects/${projectID}/knowledge/documents`, (route) =>
    route.fulfill({ json: { commitSha: "a".repeat(40), documents: [] } }),
  );
  await signIn(page);
  await selectProject(page);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: "Cleanup knowledge", exact: true }).click();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  await page.locator(".knowledge-history summary").filter({ hasText: "Revision 2" }).click();
  await expect(page.locator(".knowledge-history")).toContainText("New generated content.");
  await page.screenshot({
    path: `${cleanupEvidenceDirectory}/knowledge-proposal.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const visual = page.getByRole("textbox", { name: "Knowledge body" });
  await expect(visual).toContainText("Human content stays visible.");
  await visual.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Manual addition.");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown source" });
  await expect(source).toHaveValue(/```ts\n {2}const x = 1;\n```/);
  await expect(source).toHaveValue(/3\. Third/);
  await page.getByRole("button", { name: "Visual", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Knowledge body" })).toContainText(
    "Manual addition.",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".knowledge-article")).toContainText("Manual addition.");
  const revisions = await database.client<
    Array<{ ordinal: number }>
  >`SELECT ordinal FROM factory.knowledge_revision WHERE page_id = ${pageID} ORDER BY ordinal`;
  expect(revisions.map((revision) => revision.ordinal)).toEqual([1, 2, 3]);
});

test("keeps lifecycle, conversation mode, delivery and Inbox signals truthful", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();

  await selectProject(page);

  const dock = page.getByRole("navigation", { name: "Workspace dock" });
  await expect(
    dock.getByRole("button", { name: "Inbox", exact: true }).locator(".notification-dot"),
  ).toHaveCount(0);

  const requirements = page.getByRole("region", { name: "requirements" });
  await expect(requirements.getByText("Needs a specification")).toBeVisible();
  await expect(requirements.locator(".lane-heading")).toContainText("Requirements");
  await expect(
    requirements.getByRole("button").filter({ hasText: "Needs a specification" }),
  ).not.toContainText("Requirements");

  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("complementary", { name: "Agent panel" });
  await expect(panel.getByRole("button", { name: /^(Investigate|Plan|Build)$/ })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDirectory}/investigate.png` });
  await panel.getByRole("button", { name: "Minimize Agent panel" }).click();

  await page.getByRole("button", { name: /Completed/ }).click();
  const history = page.getByRole("region", { name: "history" });
  await expect(
    history.getByRole("button").filter({ hasText: "Cancelled implementation" }),
  ).toContainText("Cancelled");
  const deliveredCard = history.getByRole("button").filter({ hasText: "Delivered implementation" });
  await expect(deliveredCard).toContainText("Delivered");
  await page.screenshot({ path: `${evidenceDirectory}/history.png` });
  await deliveredCard.click();

  await expect(page.getByText("This approved revision was delivered.")).toBeVisible();
  const metadata = page.locator(".ticket-metadata");
  await expect(metadata.locator(".state-heading")).toHaveText("Delivered");
  await expect(metadata.getByText("Base commit", { exact: true })).toBeHidden();
  await expect(metadata.getByText("Branch", { exact: true })).toBeHidden();
  await metadata.locator("summary").filter({ hasText: "Change details" }).click();
  await expect(metadata.getByText("Base commit", { exact: true })).toBeVisible();
  await expect(metadata.getByText("Branch", { exact: true })).toBeVisible();
  await expect(page.locator(".ticket-status-context")).toContainText("Delivered");
  await expect(metadata.getByText("Runtime", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(panel.locator(".runtime-presence")).toHaveText("Delivered");
  await expect(panel.getByRole("button", { name: "Start implementation" })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDirectory}/delivered.png` });
  // A single personal IDE target bypasses the chooser. Reject the ensure request to avoid compute.
  await page.route("**/personal-workspace/ensure", (route) =>
    route.fulfill({ status: 409, json: { error: "Fixture does not start compute" } }),
  );
  await dock.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(
    page
      .getByRole("tablist", { name: "Open workspace views" })
      .getByRole("tab", { name: "IDE · My workspace", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menu", { name: "IDE instances" })).toHaveCount(0);
  await expect(page.getByText("The Workspace is not running. Open IDE to retry.")).toBeVisible();
});

for (const existingConversation of [true, false]) {
  test(`recovers a saved message after response failure with ${existingConversation ? "an existing" : "a first"} conversation`, async ({
    page,
  }) => {
    let conversationID = existingConversation ? await insertConversation() : undefined;
    const message = "Explain the delivery process";
    await page.route(`**/api/projects/${projectID}/conversation/message`, async (route) => {
      conversationID ??= await insertConversation();
      await insertUserMessage(conversationID, message, route.request().postDataJSON().commandId);
      await route.fulfill({ status: 502, json: { error: "Model response failed" } });
    });

    const panel = await openConversation(page);
    const composer = panel.getByLabel("Message conversation");
    await composer.fill(message);
    await panel.getByRole("button", { name: "Send message" }).click();
    await expect(panel.locator(".agent-message.user p")).toHaveText(message);
    await expect(composer).toHaveValue("");
    await expect(page.getByRole("alert")).toContainText(
      "Your message was saved, but the Project Agent could not finish its response.",
    );
    if (!existingConversation) {
      await page.screenshot({ path: `${evidenceDirectory}/saved-message-recovery.png` });
    }
  });
}

test("preserves a rejected draft when an older message has identical text", async ({ page }) => {
  const conversationID = await insertConversation();
  const message = "Explain the delivery process";
  await insertUserMessage(conversationID, message);
  await page.route(`**/api/projects/${projectID}/conversation/message`, (route) =>
    route.fulfill({ status: 409, json: { error: "Request was not accepted" } }),
  );

  const panel = await openConversation(page);
  await expect(panel.locator(".agent-message.user p")).toHaveText(message);
  const composer = panel.getByLabel("Message conversation");
  await composer.fill(message);
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(message);
  await expect(panel.locator(".agent-message.user")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("Request was not accepted");
});

test("preserves a new draft typed while saved-message recovery is loading", async ({ page }) => {
  const conversationID = await insertConversation();
  await insertUserMessage(conversationID, "Earlier context");
  let recovering = false;
  let releaseHistory = () => {};
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let recoveryRequested = () => {};
  const recoveryStarted = new Promise<void>((resolve) => {
    recoveryRequested = resolve;
  });
  await page.route(`**/api/projects/${projectID}/conversation`, async (route) => {
    const response = await route.fetch();
    if (recovering) {
      recoveryRequested();
      await historyGate;
    }
    await route.fulfill({ response });
  });
  await page.route(`**/api/projects/${projectID}/conversation/message`, async (route) => {
    await insertUserMessage(
      conversationID,
      "Accepted question",
      route.request().postDataJSON().commandId,
    );
    recovering = true;
    await route.fulfill({ status: 502, json: { error: "Model response failed" } });
  });

  const panel = await openConversation(page);
  await expect(panel.locator(".agent-message.user p")).toHaveText("Earlier context");
  const composer = panel.getByLabel("Message conversation");
  await composer.fill("Accepted question");
  await panel.getByRole("button", { name: "Send message" }).click();
  await recoveryStarted;
  await composer.fill("Next question draft");
  releaseHistory();
  await expect(panel.locator(".agent-message.user p").last()).toHaveText("Accepted question");
  await expect(composer).toHaveValue("Next question draft");
});

for (const outcome of ["success", "failure"] as const) {
  test(`does not replace the new Project conversation after a delayed ${outcome}`, async ({
    page,
  }) => {
    const oldConversationID = await insertConversation();
    const otherProject = await insertOtherProjectConversation();
    let releaseResponse = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route(`**/api/projects/${projectID}/conversation/message`, async (route) => {
      await insertUserMessage(
        oldConversationID,
        "Old Project request",
        route.request().postDataJSON().commandId,
      );
      await responseGate;
      if (outcome === "failure") {
        await route.fulfill({ status: 502, json: { error: "Old Project response failed" } });
      } else {
        const response = await page.request.get(`/api/projects/${projectID}/conversation`);
        await route.fulfill({ status: 200, json: await response.json() });
      }
    });

    const panel = await openConversation(page);
    const composer = panel.getByLabel("Message conversation");
    await composer.fill("Old Project request");
    const requestStarted = page.waitForRequest((request) =>
      request.url().endsWith(`/projects/${projectID}/conversation/message`),
    );
    await panel.getByRole("button", { name: "Send message" }).click();
    await requestStarted;
    await selectProject(page, otherProject.slug);
    await expect(panel.locator(".agent-message.user p")).toHaveText("New Project history");
    await expect(composer).toHaveValue("");
    await composer.fill("New Project draft");
    releaseResponse();
    await expect(composer).toBeEnabled();
    await expect(panel.locator(".agent-message.user p")).toHaveText("New Project history");
    await expect(composer).toHaveValue("New Project draft");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("ignores an older History read after a Project switch", async ({ page }) => {
  const oldConversationID = await insertConversation();
  await insertUserMessage(oldConversationID, "Old Project history");
  const otherProject = await insertOtherProjectConversation();
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let historyRequested = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    historyRequested = resolve;
  });
  await page.route(`**/api/projects/${projectID}/conversation`, async (route) => {
    const response = await page.request.get(`/api/projects/${projectID}/conversation`);
    historyRequested();
    await responseGate;
    await route.fulfill({ status: 200, json: await response.json() });
  });

  const panel = await openConversation(page);
  await requestStarted;
  await selectProject(page, otherProject.slug);
  await expect(panel.locator(".agent-message.user p")).toHaveText("New Project history");
  const oldResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/projects/${projectID}/conversation`),
  );
  releaseResponse();
  await oldResponse;
  await expect(panel.locator(".agent-message.user p")).toHaveText("New Project history");
});

test("does not apply a delayed mode change to another Project", async ({ page }) => {
  await insertConversation();
  const otherProject = await insertOtherProjectConversation();
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(`**/api/projects/${projectID}/conversation/mode`, async (route) => {
    const response = await route.fetch();
    await responseGate;
    await route.fulfill({ response });
  });

  const panel = await openConversation(page);
  const modeRequested = page.waitForRequest((request) =>
    request.url().endsWith(`/projects/${projectID}/conversation/mode`),
  );
  await panel.getByLabel("Message conversation").fill("Clarify this Project's requirements");
  await panel.getByRole("button", { name: "Send message", exact: true }).click();
  await modeRequested;
  await selectProject(page, otherProject.slug);
  await expect(panel.locator(".agent-message.user p")).toHaveText("New Project history");
  releaseResponse();
  await expect(panel.getByRole("button", { name: /^(Investigate|Plan|Build)$/ })).toHaveCount(0);
  await expect(panel.locator(".agent-message.user p")).toHaveText("New Project history");
});

test("keeps Ticket research checkout-free until its implementation IDE is opened", async ({
  page,
}) => {
  if (!database) throw new Error("Database is not ready");
  await database.client`
    UPDATE factory.project
    SET repository_url = 'http://127.0.0.1:33030/factory-mutation/runtime-fixture.git'
    WHERE id = ${projectID}
  `;
  const ticketID = await insertChangedTicket("Approved implementation", "active");
  await insertConversation(projectID, ticketID, "plan");
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await selectProject(page);
  await page
    .getByRole("region", { name: "implementation" })
    .getByRole("button")
    .filter({ hasText: "Approved implementation" })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("complementary", { name: "Agent panel" });
  await expect(panel.getByRole("button", { name: /^(Investigate|Plan|Build)$/ })).toHaveCount(0);
  await expect(panel.getByLabel("Message conversation")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start implementation" })).toHaveCount(0);
  const compute = await database.client<Array<{ attempts: number }>>`
    SELECT count(*)::integer AS attempts FROM factory.runtime_attempt WHERE project_id = ${projectID}
  `;
  expect(compute[0]?.attempts).toBe(0);
  await page.screenshot({ path: `${evidenceDirectory}/build-ready.png` });
});
