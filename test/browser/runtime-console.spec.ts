import { serverCall } from "../../apps/factory/src/server-functions/result";
import { requestFunction } from "../fixtures/server-functions";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  canonicalRequirementContent,
  requirementDigest,
} from "../../packages/requirement-domain/src/requirement";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn, teardownFactoryProject } from "../support/factory-fixture";

const repositoryURL = "http://127.0.0.1:33030/factory-mutation/runtime-fixture.git";
const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const userID = "01994a7d-0000-7000-8000-000000000001";
async function writeEvidenceJSON(name: string, value: unknown) {
  await writeFile(
    `.factory/test-results/runtime-console/${name}.json`,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
let projectID = "";
let changeID = "";
let branchName = "";
let forgeToken = "";

test.beforeAll(async () => {
  forgeToken = (await readFile(".factory/forgejo-token", "utf8")).trim();
});

test.afterEach(async ({ context }) => {
  if (changeID) {
    await serverCall(requestFunction(context.request, "cancelChange", [changeID]));
  }
  await teardownFactoryProject(context.request, projectID);
  if (branchName) {
    const forge = createForgejoClient({
      apiURL: "http://127.0.0.1:33030/api/v1/",
      token: forgeToken,
    });
    await forge.deleteBranch(repository, branchName).catch(() => undefined);
  }
  projectID = "";
  changeID = "";
  branchName = "";
});

async function createRuntimeConsoleFixture() {
  const forge = createForgejoClient({
    apiURL: "http://127.0.0.1:33030/api/v1/",
    token: forgeToken,
  });
  const base = await forge.getDefaultBranch(repository);
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const identity = changeIdentity(ticketID, approvalID);
  projectID = crypto.randomUUID();
  changeID = identity.changeID;
  branchName = identity.branchName;
  const slug = `runtime-console-${projectID.slice(0, 8)}`;
  const requirement = canonicalRequirementContent({
    summary: "Inspect the live Ticket Workspace.",
    acceptanceCriteria: ["Processes are visible", "Terminal reconnects"],
    nonGoals: [],
  });
  await forge.ensureBranch(repository, identity.branchName, base.headSha);
  const database = createDatabase(1);
  try {
    await database.client.begin(async (transaction) => {
      await transaction`
        INSERT INTO factory.project(
          id, slug, name, repository_url, default_branch, devcontainer_path, created_by
        ) VALUES (
          ${projectID}, ${slug}, 'Runtime console fixture', ${repositoryURL}, 'main',
          '.devcontainer/devcontainer.json', ${userID}
        )
      `;
      await transaction`
        INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
        VALUES (
          ${ticketID}, ${projectID}, 'Inspect runtime console',
          'Use the process switcher and interactive terminal.', 'in-progress', ${userID}
        )
      `;
      await transaction`
        INSERT INTO factory.requirement_revision(
          id, ticket_id, ordinal, canonical_content, content_digest, created_by
        ) VALUES (
          ${revisionID}, ${ticketID}, 1, ${requirement}, ${requirementDigest(requirement)}, ${userID}
        )
      `;
      await transaction`
        INSERT INTO factory.requirement_approval(
          id, ticket_id, requirement_revision_id, approved_by
        ) VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID})
      `;
      await transaction`
        INSERT INTO factory.change(
          id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
          state, created_by
        ) VALUES (
          ${identity.changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${identity.branchName},
          ${base.headSha}, 'active', ${userID}
        )
      `;
      await transaction`
        INSERT INTO factory.branch_create_operation(
          id, change_id, repository_owner, repository_name, branch_name, start_sha,
          idempotency_key, state, observed_head_sha, completed_at
        ) VALUES (
          ${identity.branchOperationID}, ${identity.changeID}, ${repository.owner}, ${repository.name},
          ${identity.branchName}, ${base.headSha}, ${`runtime-console:${identity.changeID}`},
          'succeeded', ${base.headSha}, now()
        )
      `;
    });
  } finally {
    await database.client.end();
  }
  return { slug };
}

test("keeps the actual Monaco palette on cold load and iframe refresh", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(360_000);
  await mkdir(".factory/test-results/runtime-console", { recursive: true });
  const { slug } = await createRuntimeConsoleFixture();
  await signIn(page);
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await page.getByRole("menuitem", { name: /Inspect runtime console/ }).click();
  const frame = page.locator('iframe[title="Factory IDE"]');
  const ide = frame.contentFrame();
  const observations = [];
  for (let load = 0; load < 5; load++) {
    await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 300_000 });
    // The shell attaches before layout restoration and keyboard handlers are ready.
    await expect(ide.locator(".theia-preload")).toHaveCount(0, { timeout: 120_000 });
    const search = ide.locator("#search-input-field");
    // BODY cannot take keyboard focus. Use the native sidebar after layout restoration,
    // without toggling Search closed when the restored layout already shows it.
    if (!(await search.isVisible())) await ide.locator("#shell-tab-search-view-container").click();
    await expect(search).toBeVisible();
    await search.fill("Worker monitor ready on 4310");
    await search.press("Enter");
    await ide
      .locator("#search-view-container span.match")
      .filter({
        hasText: "Worker monitor ready on 4310",
      })
      .first()
      .click();
    const editor = ide.locator(".monaco-editor:visible");
    await expect(editor).toBeVisible();
    const observation = await editor.evaluate((element) => ({
      editorBackground: getComputedStyle(element).backgroundColor,
      bodyClasses: document.body.className,
      cachedThemeID: localStorage.getItem("theme"),
      editorVariable: getComputedStyle(document.documentElement).getPropertyValue(
        "--theia-editor-background",
      ),
    }));
    observations.push({ load, ...observation });
    await writeEvidenceJSON("runtime-theme-initialization", observations);
    await expect
      .soft(editor, `Monaco palette at iframe load ${load}`)
      .toHaveCSS("background-color", "rgb(245, 246, 242)", { timeout: 5_000 });
    if (load < 4) {
      const navigation = page.waitForEvent(
        "framenavigated",
        (candidate) => candidate.parentFrame() !== null && candidate.url().includes("/ide/"),
      );
      await ide.locator("body").evaluate(() => location.reload());
      await navigation;
    }
  }
});

test("opens real Staging Preview without a development workspace", async ({ page }, testInfo) => {
  testInfo.setTimeout(420_000);
  await mkdir(".factory/test-results/runtime-console", { recursive: true });
  const { slug } = await createRuntimeConsoleFixture();
  await signIn(page);
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Factory Preview"]');
  await expect(preview.getByRole("heading", { name: "Runtime fixture ready" })).toBeVisible({
    timeout: 300_000,
  });
  await expect(page.getByRole("tab", { name: "Preview · Staging", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('iframe[title="Factory IDE"]')).toHaveCount(0);
  for (const width of [1440, 1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `.factory/test-results/runtime-console/staging-preview-${width}.png`,
      fullPage: true,
    });
  }
  const db = createDatabase(1);
  try {
    const attempts = await db.client<{ kind: string; state: string }[]>`
      SELECT CASE WHEN workspace_id IS NULL THEN 'staging' ELSE 'development' END AS kind, state
      FROM factory.runtime_attempt WHERE project_id = ${projectID}
    `;
    expect(attempts.map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: "staging", state: "ready" },
    ]);
  } finally {
    await db.client.end();
  }
});

test("retains complete native stdin when closing another terminal", async ({ page }, testInfo) => {
  testInfo.setTimeout(360_000);
  const { slug } = await createRuntimeConsoleFixture();
  await signIn(page);
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await page.getByRole("menuitem", { name: /Inspect runtime console/ }).click();
  const ide = page.locator('iframe[title="Factory IDE"]').contentFrame();
  await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 300_000 });
  await expect(ide.locator(".theia-preload")).toHaveCount(0);
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  const terminals = ide.locator(".factory-terminal-widget");
  const activeHost = terminals.locator(".factory-terminal-host:not([hidden])");
  await expect(activeHost).toHaveAttribute("data-connection-state", "connected");
  await activeHost.locator(".xterm").click();
  await page.keyboard.type("export FACTORY_TERMINAL_SENTINEL=session-alive");
  await page.keyboard.press("Enter");
  await terminals.getByRole("button", { name: "New terminal" }).click();
  await expect(activeHost).toHaveAttribute("data-connection-state", "connected");
  const navigation = page.waitForEvent(
    "framenavigated",
    (frame) => frame.parentFrame() !== null && frame.url().includes("/ide/"),
  );
  await ide.locator("body").evaluate(() => location.reload());
  await navigation;
  await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 120_000 });
  await expect(ide.locator(".theia-preload")).toHaveCount(0);
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  for (let round = 0; round < 8; round++) {
    if (round > 0) {
      await terminals.getByRole("button", { name: "New terminal" }).click();
      await expect(activeHost).toHaveAttribute("data-connection-state", "connected");
    }
    await expect(terminals.locator(".factory-terminal-tab")).toHaveCount(2);
    await terminals
      .locator(".factory-terminal-tab")
      .filter({ hasText: "Terminal 1" })
      .getByRole("tab")
      .first()
      .click();
    await expect(activeHost).toHaveAttribute("data-connection-state", "connected");
    const closePattern = "**/__factory/terminals/*";
    await page
      .context()
      .route(closePattern, (route) => route.fulfill({ status: 503, body: "Close unavailable" }));
    await terminals.getByRole("button", { name: "Close Terminal 2" }).click();
    await terminals
      .locator(".factory-terminal-tab")
      .filter({ hasText: "Terminal 2" })
      .getByRole("tab")
      .first()
      .click();
    await expect(activeHost.locator(".xterm-rows")).toContainText("Terminal close failed");
    await expect(terminals.locator(".factory-terminal-tab")).toHaveCount(2);
    await terminals
      .locator(".factory-terminal-tab")
      .filter({ hasText: "Terminal 1" })
      .getByRole("tab")
      .first()
      .click();
    await page.context().unroute(closePattern);
    await terminals.getByRole("button", { name: "Close Terminal 2" }).click();
    await expect(terminals.locator(".factory-terminal-tab")).toHaveCount(1);
    await activeHost.locator(".xterm").click();
    await page.keyboard.type(`printf 'close-round-${round}=%s\\n' "$FACTORY_TERMINAL_SENTINEL"`);
    await page.keyboard.press("Enter");
    await expect(activeHost.locator(".xterm-rows")).toContainText(
      `close-round-${round}=session-alive`,
      { timeout: 5_000 },
    );
  }
});

test("controls declared Apps and restores workspace terminal sessions", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(480_000);
  await mkdir(".factory/test-results/runtime-console", { recursive: true });
  let ideDocumentLoads = 0;
  let ideHTTPRequests = 0;
  let observedTerminalID = "";
  let observingInput = false;
  const inputObservation = { frames: 0, bytes: 0, socketCloses: 0 };
  page.on("websocket", (socket) => {
    const path = new URL(socket.url()).pathname;
    if (!path.includes("/__factory/terminal/")) return;
    const terminalID = path.split("/").at(-1);
    socket.on("framesent", ({ payload }) => {
      if (!observingInput || terminalID !== observedTerminalID || typeof payload === "string") {
        return;
      }
      inputObservation.frames++;
      inputObservation.bytes += payload.length;
    });
    socket.on("close", () => {
      if (observingInput && terminalID === observedTerminalID) inputObservation.socketCloses++;
    });
  });
  page.on("request", (request) => {
    if (/^\/runtime\/[^/]+\/ide\//.test(new URL(request.url()).pathname)) ideHTTPRequests++;
  });
  page.on("framenavigated", (frame) => {
    if (frame.parentFrame() && frame.url().includes("/ide/")) ideDocumentLoads++;
  });
  const { slug } = await createRuntimeConsoleFixture();

  await signIn(page);
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await expect(page.getByText("Inspect runtime console", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await page.getByRole("menuitem", { name: /Inspect runtime console/ }).click();
  const ide = page.frameLocator('iframe[title="Factory IDE"]');
  await expect(ide.locator("#theia-app-shell")).toBeVisible({
    timeout: 300_000,
  });
  await expect(ide.locator("#explorer-view-container")).toBeVisible();

  const layouts: Array<{ stage: string; top: number; bottom: number; right: number }> = [];
  const assertLayout = async (stage: string) => {
    const readLayout = () =>
      ide.locator("body").evaluate((body) => {
        const shell = body.querySelector("#theia-app-shell")?.getBoundingClientRect();
        const content = body
          .querySelector("#theia-left-right-split-panel")
          ?.getBoundingClientRect();
        const main = body.querySelector("#theia-bottom-split-panel")?.getBoundingClientRect();
        if (!shell || !content || !main) return undefined;
        return {
          top: content.top - shell.top,
          bottom: shell.bottom - content.bottom,
          right: shell.right - main.right,
        };
      });
    await expect
      .poll(() =>
        page
          .locator(".workspace-window")
          .evaluate(
            (element) =>
              !element.getAnimations().some((animation) => animation.playState === "running"),
          ),
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const body = await page.locator(".workspace-view-body").boundingBox();
        const frame = await page.locator('iframe[title="Factory IDE"]').boundingBox();
        return (
          body !== null &&
          frame !== null &&
          (["x", "y", "width", "height"] as const).every(
            (key) => Math.abs(body[key] - frame[key]) <= 1,
          )
        );
      })
      .toBe(true);
    let gaps: Awaited<ReturnType<typeof readLayout>>;
    try {
      await expect
        .poll(async () => {
          gaps = await readLayout();
          return (
            gaps &&
            Object.fromEntries(
              Object.entries(gaps).map(([key, value]) => [key, Math.abs(value) <= 1 ? 0 : value]),
            )
          );
        })
        .toEqual({ top: 0, bottom: 0, right: 0 });
    } finally {
      await writeEvidenceJSON("runtime-layout-latest", { stage, measured: gaps ?? null });
    }
    if (!gaps) throw new Error(`Theia layout disappeared before recording ${stage}`);
    layouts.push({ stage, ...gaps });
  };
  await assertLayout("initial");
  await page.setViewportSize({ width: 1440, height: 900 });
  await assertLayout("1440");
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertLayout("1280");

  await ide.locator("#shell-tab-search-view-container").click();
  const search = ide.locator("#search-input-field");
  await search.fill("Worker monitor ready on 4310");
  await search.press("Enter");
  await expect(ide.getByText("worker.mjs", { exact: true })).toBeVisible();
  await ide
    .locator("span.match")
    .filter({ hasText: "Worker monitor ready on 4310" })
    .first()
    .click();
  const editor = ide.locator(".monaco-editor:visible");
  await expect(editor).toBeVisible();
  const editorBackground = await editor.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  if (editorBackground !== "rgb(245, 246, 242)") {
    await writeEvidenceJSON("runtime-theme-before", {
      editorBackground,
      expected: "rgb(245, 246, 242)",
      runtimeImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
    });
  }
  await expect.soft(editor).toHaveCSS("background-color", "rgb(245, 246, 242)");

  const runtimeTab = ide.locator(".lm-TabBar-tab").filter({ hasText: "Run" });
  await runtimeTab.click();
  await expect(ide.locator(".factory-runtime-widget")).toBeVisible();
  const worker = ide.locator(".factory-runtime-process").filter({ hasText: "Worker monitor" });
  await expect(worker).toContainText("Running");
  await worker.click();
  await expect(ide.locator(".factory-runtime-output")).toContainText(
    "Worker monitor ready on 4310",
  );
  const run = ide.locator(".factory-runtime-widget");
  await expect(run.locator(".factory-runtime-primary")).toHaveText("Stop");
  await expect(run.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
  const outputOptions = run.locator(".factory-runtime-output-options");
  await expect(run.getByRole("button", { name: "Clear", exact: true })).toBeHidden();
  await outputOptions.locator("summary").click();
  await expect(outputOptions).toHaveAttribute("open", "");
  await run.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(ide.locator(".factory-runtime-output")).not.toContainText(
    "Worker monitor ready on 4310",
  );
  await run.getByRole("button", { name: "Following", exact: true }).click();
  await expect(run.getByRole("button", { name: "Follow", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await run.getByRole("button", { name: "Wrap on", exact: true }).click();
  await expect(run.getByRole("button", { name: "Wrap off", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await run.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(run.getByRole("button", { name: "Following", exact: true })).toBeFocused();
  await run.getByRole("button", { name: "Wrap off", exact: true }).click();
  // The one-second refresh must preserve open options and keyboard focus.
  const optionsRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/__factory/processes"),
  );
  await run.getByRole("button", { name: "Following", exact: true }).focus();
  await optionsRefresh;
  await expect(outputOptions).toHaveAttribute("open", "");
  await expect(run.getByRole("button", { name: "Following", exact: true })).toBeFocused();
  await run.getByRole("button", { name: "Following", exact: true }).press("Escape");
  await expect(outputOptions.locator("summary")).toBeFocused();
  await expect(run.getByRole("button", { name: "Clear", exact: true })).toBeHidden();
  const stopPattern = "**/__factory/processes/*/stop";
  await page
    .context()
    .route(stopPattern, (route) =>
      route.fulfill({ status: 503, json: { error: "Process control unavailable" } }),
    );
  await run.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(run.getByRole("alert")).toHaveText("Process control unavailable");
  await expect(worker).toContainText("Running");
  // A real refresh must not erase an action failure.
  await expect.poll(async () => worker.textContent()).not.toBe(await worker.textContent());
  await expect(run.getByRole("alert")).toHaveText("Process control unavailable");
  await page.context().unroute(stopPattern);
  await run.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(worker).toContainText("Stopped · exit");
  await run.getByRole("button", { name: "Start", exact: true }).click();
  await expect(worker).toContainText("Running");
  await run.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(worker).toContainText("Running");
  await page.screenshot({
    path: ".factory/test-results/runtime-console/run-panel.png",
    fullPage: true,
  });

  const terminalTab = ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" });
  await terminalTab.click();
  const terminal = ide.locator(".factory-terminal-widget");
  await expect(terminal.locator(".xterm")).toBeAttached();
  const terminalHost = terminal.locator(".factory-terminal-host:not([hidden])");
  await expect(terminalHost).toHaveAttribute("data-connection-state", "connected");
  const focusObservations: Array<{
    stage: string;
    scrollY: number;
    shellTop: number;
    activeElement: string | undefined;
  }> = [];
  const assertTerminalFocus = async (stage: string) => {
    const observation = await ide.locator("body").evaluate((body) => {
      const shell = body.querySelector("#theia-app-shell");
      if (!shell) throw new Error("Theia shell is absent");
      return {
        scrollY: window.scrollY,
        shellTop: shell.getBoundingClientRect().top,
        activeElement: document.activeElement?.tagName,
      };
    });
    focusObservations.push({ stage, ...observation });
    await writeEvidenceJSON("runtime-terminal-focus", focusObservations);
    expect(observation.scrollY).toBe(0);
    expect(observation.shellTop).toBe(0);
    expect(observation.activeElement).toBe("TEXTAREA");
  };
  const assertTerminalTheme = async (stage: string) => {
    const viewport = terminal.locator(".xterm-viewport:visible");
    const colors = await terminal.evaluate((element) => {
      const styles = getComputedStyle(element);
      const viewport = element.querySelector(
        ".factory-terminal-host:not([hidden]) .xterm-viewport",
      );
      if (!viewport) throw new Error("Active terminal viewport is absent");
      return {
        background: styles.getPropertyValue("--theia-terminal-background").trim(),
        foreground: styles.getPropertyValue("--theia-terminal-foreground").trim(),
        viewportBackground: getComputedStyle(viewport).backgroundColor,
      };
    });
    if (colors.viewportBackground !== "rgb(245, 246, 242)") {
      await writeEvidenceJSON("runtime-terminal-theme-before", { stage, colors });
    }
    await expect.soft(viewport).toHaveCSS("background-color", "rgb(245, 246, 242)", {
      timeout: 3_000,
    });
  };
  await assertTerminalTheme("initial");
  await assertTerminalFocus("tab-activation");
  await terminal.locator(".xterm:visible").click({ force: true });
  await assertTerminalFocus("initial");
  await page.keyboard.type("export FACTORY_TERMINAL_SENTINEL=session-alive");
  await page.keyboard.press("Enter");
  await page.keyboard.type("printf 'terminal-one=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows:visible")).toContainText("terminal-one=session-alive");
  expect(await page.locator(".factory-desktop").evaluate((desktop) => desktop.scrollTop)).toBe(0);
  await page.setViewportSize({ width: 900, height: 900 });
  await terminal.locator(".xterm:visible").click({ force: true });
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const narrowAgent = page.getByRole("dialog", { name: "Agent panel" });
  await expect(narrowAgent).toBeVisible();
  await expect(page.locator(".workspace-window")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(narrowAgent).toHaveCount(0);
  await expect(page.locator('iframe[title="Factory IDE"]')).toBeFocused();
  await assertTerminalFocus("narrow-Agent-return");
  await page.keyboard.type("printf 'overlay-return=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows:visible")).toContainText(
    "overlay-return=session-alive",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertLayout("narrow-Agent-return");
  const iframeRefresh = page.waitForEvent(
    "framenavigated",
    (candidate) => candidate.parentFrame() !== null && candidate.url().includes("/ide/"),
  );
  await ide.locator("body").evaluate(() => location.reload());
  await iframeRefresh;
  await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 120_000 });
  await expect(ide.locator(".theia-preload")).toHaveCount(0, { timeout: 120_000 });
  await assertLayout("refresh");
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  await expect(terminal.locator(".factory-terminal-tab")).toHaveCount(1);
  await expect(terminalHost).toHaveAttribute("data-connection-state", "connected");
  await assertTerminalTheme("refresh");
  await terminal.locator(".xterm:visible").click({ force: true });
  await assertTerminalFocus("refresh");
  await page.keyboard.type("printf 'default-refresh=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows:visible")).toContainText(
    "default-refresh=session-alive",
  );
  await terminal.getByRole("button", { name: "New terminal" }).click();
  await expect(terminal.locator(".factory-terminal-tab")).toHaveCount(2);
  await expect(terminal.locator(".factory-terminal-host:not([hidden])")).toHaveAttribute(
    "data-connection-state",
    "connected",
  );
  await assertTerminalTheme("new-terminal");
  await terminal.locator(".xterm:visible").click({ force: true });
  await page.keyboard.type("printf 'terminal-two=independent\\n'");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows:visible")).toContainText("terminal-two=independent");
  await terminal
    .locator(".factory-terminal-tab")
    .filter({ hasText: "Terminal 1" })
    .getByRole("tab")
    .first()
    .click();
  await terminal.locator(".xterm:visible").click({ force: true });
  await page.keyboard.type("printf 'durable=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows:visible")).toContainText("durable=session-alive");
  await page.keyboard.type("stty size");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows:visible")).toContainText(/\d+ \d+/);
  await page.screenshot({
    path: ".factory/test-results/runtime-console/terminal-tabs.png",
    fullPage: true,
  });

  await page.keyboard.type("printf 'factoryUnsavedBuffer\\n' > src/unsaved-fixture.md");
  await page.keyboard.press("Enter");
  if (!(await search.isVisible())) await ide.locator("#shell-tab-search-view-container").click();
  await search.fill("factoryUnsavedBuffer");
  await search.press("Enter");
  await ide.locator("span.match").filter({ hasText: "factoryUnsavedBuffer" }).click();
  const editorURIAtSearchClick = await ide
    .locator(".monaco-editor:visible")
    .getAttribute("data-uri");
  await expect(ide.locator(".monaco-editor:visible")).toHaveAttribute(
    "data-uri",
    /\/src\/unsaved-fixture\.md$/,
  );
  await expect(ide.locator(".monaco-editor:visible .view-lines")).toContainText(
    "factoryUnsavedBuffer",
  );
  await writeEvidenceJSON("runtime-editor-open", {
    editorURIAtSearchClick,
    editorURIBeforeInput: await ide.locator(".monaco-editor:visible").getAttribute("data-uri"),
  });
  const editorInput = ide.locator(
    ".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])",
  );
  await expect(editorInput).toBeAttached({ timeout: 10_000 });
  await editorInput.press("ControlOrMeta+End");
  await editorInput.press("Enter");
  await editorInput.pressSequentially("unsaved-state-marker");
  await editorInput.press("Home");
  await editorInput.press("Shift+End");
  const readSelection = (
    input: HTMLElement & {
      editContext?: { text: string; selectionStart: number; selectionEnd: number };
    },
  ) => {
    const context = input.editContext;
    if (!context) throw new Error("Expected the pinned Monaco native EditContext");
    return { text: context.text, start: context.selectionStart, end: context.selectionEnd };
  };
  const selection = await editorInput.evaluate(readSelection);
  if (selection.text.slice(selection.start, selection.end) !== "unsaved-state-marker") {
    await writeEvidenceJSON("runtime-editor-selection-before", {
      editorURIAtSearchClick,
      editorURIAtSelection: await ide.locator(".monaco-editor:visible").getAttribute("data-uri"),
      selection,
    });
  }
  expect(selection.text.slice(selection.start, selection.end)).toBe("unsaved-state-marker");
  await expect(ide.locator(".monaco-editor:visible .view-lines")).toContainText(
    "unsaved-state-marker",
  );
  await ide.locator("#shell-tab-explorer-view-container").click();
  const explorer = ide.locator("#explorer-view-container");
  const sourceFolder = explorer
    .locator(".theia-TreeNode")
    .filter({ has: ide.getByText("src", { exact: true }) });
  const sourceExpansion = sourceFolder.locator(".theia-ExpansionToggle");
  await expect(sourceFolder).toBeVisible();
  if (
    await sourceExpansion.evaluate((element) => element.classList.contains("theia-mod-collapsed"))
  ) {
    await sourceExpansion.click();
  }
  const fixtureNode = explorer
    .locator(".theia-TreeNode")
    .filter({ has: ide.getByText("unsaved-fixture.md", { exact: true }) });
  await fixtureNode.click();
  await expect(fixtureNode).toHaveClass(/theia-mod-selected/);
  await expect(sourceExpansion).not.toHaveClass(/theia-mod-collapsed/);
  await editorInput.focus();
  expect(await editorInput.evaluate(readSelection)).toEqual(selection);
  await page.screenshot({
    path: ".factory/test-results/runtime-console/ide-explorer-state.png",
    fullPage: true,
  });
  const documentLoads = ideDocumentLoads;
  const timeOrigin = await ide.locator("body").evaluate(() => performance.timeOrigin);
  const resourceSamples: Array<{
    stage: string;
    rendererHeap: { usedSize: number; totalSize: number };
    rendererDOM: { documents: number; nodes: number; jsEventListeners: number };
    ideHidden: boolean;
    ideDocumentLoads: number;
    ideHTTPRequests: number;
  }> = [];
  const measureRetainedResources = async (stage: string) => {
    // This Chromium run places the IDE in the parent renderer, not an independent CDP target.
    const session = await page.context().newCDPSession(page);
    try {
      const rendererHeap = await session.send("Runtime.getHeapUsage");
      const rendererDOM = await session.send("Memory.getDOMCounters");
      expect(rendererHeap.usedSize).toBeGreaterThan(0);
      resourceSamples.push({
        stage,
        rendererHeap: { usedSize: rendererHeap.usedSize, totalSize: rendererHeap.totalSize },
        rendererDOM,
        ideHidden: await page.locator('iframe[title="Factory IDE"]').isHidden(),
        ideDocumentLoads,
        ideHTTPRequests,
      });
      await writeEvidenceJSON("runtime-retained-resources", {
        runtimeImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
        samples: resourceSamples,
        conditions:
          "Chromium CDP Runtime.getHeapUsage and Memory.getDOMCounters, real Ticket Workspace, single shared-renderer samples without forced GC. The IDE has no separate CDP target in this run. V8 heap and renderer-wide DOM counters, not total RSS, CPU or Sandbox memory, not isolated IDE cost or a before/after savings claim. IDE HTTP counts are cumulative routed requests including normal Run polling; document-load counts identify boot/navigation, not background traffic.",
      });
    } finally {
      await session.detach();
    }
  };
  await measureRetainedResources("before-preview");
  await runtimeTab.click();
  await worker.click();
  await run.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Factory Preview"]');
  await expect(preview.locator("body")).toContainText('"process":"worker"');
  await expect(
    page.getByRole("tab", { name: "Development · Worker monitor", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Open Development · Worker monitor in new tab", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open Development · Worker monitor in new tab", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".factory/test-results/runtime-console/development-preview.png",
    fullPage: true,
  });
  await measureRetainedResources("ide-inactive");
  await page.getByRole("tab", { name: /^IDE ·/ }).click();
  await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 120_000 });
  expect(ideDocumentLoads).toBe(documentLoads);
  expect(await ide.locator("body").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  await expect(ide.locator(".monaco-editor:visible .view-lines")).toContainText(
    "unsaved-state-marker",
  );
  await editorInput.focus();
  expect(await editorInput.evaluate(readSelection)).toEqual(selection);
  await expect(explorer).toBeVisible();
  await expect(fixtureNode).toHaveClass(/theia-mod-selected/);
  await expect(sourceExpansion).not.toHaveClass(/theia-mod-collapsed/);
  await expect(search).toHaveValue("factoryUnsavedBuffer");
  await expect(worker).toHaveAttribute("aria-pressed", "true");
  await assertLayout("preview-return");
  await measureRetainedResources("ide-restored");
  const previewSwitchDocumentLoads = ideDocumentLoads - documentLoads;
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  await ide
    .locator(".factory-terminal-tab")
    .filter({ hasText: "Terminal 1" })
    .getByRole("tab")
    .first()
    .click();
  await ide.locator(".factory-terminal-host:not([hidden]) .xterm").click({ force: true });
  await page.keyboard.type("printf 'restored=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"");
  await page.keyboard.press("Enter");
  await expect(ide.locator(".factory-terminal-host:not([hidden]) .xterm-rows")).toContainText(
    "restored=session-alive",
  );

  await page.keyboard.type("printf 'const factoryDiagnostic = ;\\n' > src/diagnostic-fixture.mjs");
  await page.keyboard.press("Enter");
  if (!(await search.isVisible())) {
    await ide.locator("#shell-tab-search-view-container").click();
  }
  await expect(search).toBeVisible();
  await search.fill("factoryDiagnostic");
  await search.press("Enter");
  const searchResults = ide.locator("#search-view-container");
  const diagnosticFile = searchResults.getByText("diagnostic-fixture.mjs", { exact: true });
  await expect(diagnosticFile).toBeVisible({ timeout: 10_000 });
  await searchResults.getByText("const factoryDiagnostic = ;", { exact: true }).click();
  await expect(ide.locator(".squiggly-error")).toBeAttached();
  await ide.locator(".theia-app-bottom .lm-TabBar-tab").filter({ hasText: "Problems" }).click();
  await expect(ide.locator('.markerNode[title^="Expression expected."]')).toBeVisible();
  await page.screenshot({
    path: ".factory/test-results/runtime-console/editor-diagnostics.png",
    fullPage: true,
  });

  await ide.locator("body").evaluate(() => location.reload());
  await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 120_000 });
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  const reconnected = ide.locator(".factory-terminal-widget");
  await expect(reconnected.locator(".factory-terminal-tab")).toHaveCount(2);
  await reconnected
    .locator(".factory-terminal-tab")
    .filter({ hasText: "Terminal 1" })
    .getByRole("tab")
    .first()
    .click();
  await reconnected.locator(".factory-terminal-host:not([hidden]) .xterm").click({ force: true });
  await page.keyboard.type("printf 'reload=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"");
  await page.keyboard.press("Enter");
  await expect(
    reconnected.locator(".factory-terminal-host:not([hidden]) .xterm-rows"),
  ).toContainText("reload=session-alive");
  const closePattern = "**/__factory/terminals/*";
  await page
    .context()
    .route(closePattern, (route) => route.fulfill({ status: 503, body: "Close unavailable" }));
  await reconnected.getByRole("button", { name: "Close Terminal 2" }).click();
  await expect(reconnected.locator(".factory-terminal-tab")).toHaveCount(2);
  await page.context().unroute(closePattern);
  await reconnected.getByRole("button", { name: "Close Terminal 2" }).click();
  await expect(reconnected.locator(".factory-terminal-tab")).toHaveCount(1);
  await reconnected.locator(".factory-terminal-host:not([hidden]) .xterm").click({ force: true });
  const beforeInput = await ide.locator("body").evaluate(() => {
    const attemptID = location.pathname.split("/")[2];
    const stored = JSON.parse(localStorage.getItem(`factory:terminals:${attemptID}`) ?? "[]");
    return {
      terminalID: String(stored[0]?.id ?? ""),
      activeElement: document.activeElement?.tagName,
      connectionState: document
        .querySelector(".factory-terminal-host:not([hidden])")
        ?.getAttribute("data-connection-state"),
    };
  });
  observedTerminalID = beforeInput.terminalID;
  observingInput = true;
  const afterCloseCommand = "printf 'after-close=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"";
  await page.keyboard.type(afterCloseCommand);
  await page.keyboard.press("Enter");
  try {
    await expect(
      reconnected.locator(".factory-terminal-host:not([hidden]) .xterm-rows"),
    ).toContainText("after-close=session-alive");
  } finally {
    observingInput = false;
    await writeEvidenceJSON("runtime-terminal-after-close-observation", {
      beforeInput,
      afterInput: await ide.locator("body").evaluate(() => ({
        activeElement: document.activeElement?.tagName,
        connectionState: document
          .querySelector(".factory-terminal-host:not([hidden])")
          ?.getAttribute("data-connection-state"),
      })),
      expectedBytes: Buffer.byteLength(afterCloseCommand) + 1,
      ...inputObservation,
      conditions:
        "Native keyboard input after Terminal 2 close; binary stdin bytes only, no resize messages, credentials or terminal output retained.",
    });
  }
  await page.screenshot({
    path: ".factory/test-results/runtime-console/terminal-recovery.png",
    fullPage: true,
  });

  const minimizeLoads = ideDocumentLoads;
  const minimizeOrigin = await ide.locator("body").evaluate(() => performance.timeOrigin);
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  await expect(page.locator('iframe[title="Factory IDE"]')).toBeHidden();
  await measureRetainedResources("workspace-minimized");
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await page.getByRole("menuitem", { name: /Inspect runtime console/ }).click();
  await expect(ide.locator("#theia-app-shell")).toBeVisible();
  expect(ideDocumentLoads).toBe(minimizeLoads);
  expect(await ide.locator("body").evaluate(() => performance.timeOrigin)).toBe(minimizeOrigin);
  await assertLayout("minimize-return");
  await measureRetainedResources("workspace-restored");
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  await ide.locator(".factory-terminal-host:not([hidden]) .xterm").click({ force: true });
  await page.keyboard.type("printf 'minimize=%s\\n' \"$FACTORY_TERMINAL_SENTINEL\"");
  await page.keyboard.press("Enter");
  await expect(ide.locator(".factory-terminal-host:not([hidden]) .xterm-rows")).toContainText(
    "minimize=session-alive",
  );
  expect(await page.locator(".factory-desktop").evaluate((desktop) => desktop.scrollTop)).toBe(0);
  await writeEvidenceJSON("runtime-layout", {
    runtimeImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
    layouts,
    previewSwitchDocumentLoads,
    minimizeDocumentLoads: ideDocumentLoads - minimizeLoads,
    conditions:
      "Chromium, real Ticket Workspace; top/bottom/right gaps in CSS pixels; no iframe reload on Preview return or minimize",
  });

  const verificationDatabase = createDatabase(1);
  try {
    const attempts = await verificationDatabase.client<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM factory.runtime_attempt
      WHERE project_id = ${projectID}
    `;
    expect(attempts[0]?.count).toBe(1);
  } finally {
    await verificationDatabase.client.end();
  }
});
