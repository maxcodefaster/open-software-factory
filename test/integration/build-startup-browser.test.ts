import { changesResponseSchema, agentViewSchema } from "../../apps/factory/src/api-contracts";
import { mockAgentView } from "../fixtures/server-functions";
import { browserFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect as visible } from "@playwright/test";
import type { AgentView } from "../../apps/factory/src/api-contracts";
import { turnObservationInput } from "../../packages/conversation-domain/src/turn-observation";
import { factoryProcess } from "../fixtures/factory-process";
import { openProjectMenu } from "../fixtures/project-menu";
import { mockBootstrap } from "../fixtures/server-functions";

test("Build preparation distinguishes lost history and retains correction routing after compute stops", async () => {
  const fixture = await factoryProcess(undefined, { FACTORY_HOST: "0.0.0.0" });
  const database = fixture.connect();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : {}),
  });
  const projectID = crypto.randomUUID(),
    ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID(),
    approvalID = crypto.randomUUID(),
    changeID = crypto.randomUUID();
  const slug = `build-startup-${projectID.slice(0, 8)}`;
  let sessionAvailable = false;
  let mutations = 0;
  let state: AgentView["state"] = "starting";
  let runtimeState = "starting";
  let turn: AgentView["turn"];
  const prompts: Array<{ text: string; commandId: string }> = [];
  let researchRequests = 0;
  const view = () => ({
    state,
    runtimeState,
    messagesAvailable: false,
    sessionAvailable,
    runtimeConnected: false,
    stopPending: false,
    stopId: null,
    messages: [],
    ...(turn ? { turn } : {}),
  });
  let page: import("@playwright/test").Page | undefined;
  try {
    await fixture.startPlanningCache();
    await fixture.start();
    const cookie = await fixture.signIn();
    const [user] = await database.client<Array<{ id: string }>>`SELECT id FROM auth."user"
      WHERE email=${`owned-${fixture.id}@factory.local`}`;
    if (!user) throw Error("Owned startup actor missing");
    const content = JSON.stringify({
      summary: "Owned startup fixture",
      acceptanceCriteria: ["Show accurate startup."],
      nonGoals: [],
    });
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Build startup fixture','https://example.invalid/owned','main','.devcontainer/devcontainer.json',${user.id})`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${ticketID},${projectID},'Initial Build startup','in-progress',${user.id})`;
    await database.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
      VALUES(${revisionID},${ticketID},1,${content},${createHash("sha256").update(content).digest("hex")},${user.id})`;
    await database.client`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
      VALUES(${approvalID},${ticketID},${revisionID},${user.id})`;
    await database.client`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
      VALUES(${changeID},${projectID},${ticketID},${approvalID},${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`},${"a".repeat(40)},'active',${user.id})`;
    await database.client`INSERT INTO factory.branch_create_operation(
      id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
      VALUES(${crypto.randomUUID()},${changeID},'owned-process-fixture','startup',
        ${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`},${"a".repeat(40)},
        ${`startup:${changeID}`},'succeeded',${"a".repeat(40)},now())`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(
      cookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: fixture.base,
      })),
    );
    page = await context.newPage();
    await mockBootstrap(page, (value) => ({ ...value, modelRelayConfigured: true }));
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes(`/changes/${changeID}/agent`))
        mutations++;
    });
    await mockFactoryFunctions(page, {
      workspaces: {
        ensurePersonalSource: async () => {
          throw new CommandError("unavailable", "No source in controlled fixture");
        },
      },
    });
    await mockFactoryFunctions(page, {
      workspaces: {
        ensureEditor: async () => {
          throw new CommandError("unavailable", "No IDE in controlled fixture");
        },
      },
    });
    await mockAgentView(page, changeID, async () => view(), { activity: false });
    const lifecyclePage = page;
    await mockFactoryFunctions(lifecyclePage, {
      runtime: {
        changes: async (_actor, factoryTargetID) => {
          const response = await serverCall(
            browserFunction(lifecyclePage, "getChanges", [factoryTargetID]),
          );
          const body = await response;
          return changesResponseSchema.parse({
            ...body,
            changes: body.changes.map((change: { id: string }) =>
              change.id === changeID
                ? { ...change, implementationState: state, buildTurnState: turn?.state }
                : change,
            ),
          });
        },
      },
    });
    const deliveryPage = page;
    await mockFactoryFunctions(deliveryPage, {
      delivery: {
        async get(_actor, id) {
          if (id !== changeID)
            return serverCall(browserFunction(deliveryPage, "getDelivery", [id]));
          return deliveryViewSchema.parse({
            verificationState: "succeeded",
            verificationCommitSha: "b".repeat(40),
            verificationSummary: "The earlier submitted commit passed its exact checks.",
          });
        },
      },
    });
    await mockFactoryFunctions(page, {
      conversations: {
        message: async (_actor, factoryTargetID, factoryCommand) => {
          researchRequests++;
          return (() => {
            throw new CommandError("conflict", String("Build must not become research"));
          })();
        },
      },
    });
    await mockFactoryFunctions(page, {
      agent: {
        prompt: async (_actor, factoryTargetID, factoryCommand) => {
          prompts.push(factoryCommand);
          state = "starting";
          turn = { ...turn!, state: "pending" };
          return agentViewSchema.parse(view());
        },
      },
    });
    await page.goto(fixture.base);
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .filter({ hasText: "Initial Build startup" })
      .click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Agent panel" });
    if (!(await panel.isVisible()))
      await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await visible(panel.locator(".agent-state")).toHaveText("Starting");
    await visible(panel).not.toContainText("Live activity temporarily unavailable.");
    await visible(panel).toContainText("Preparing implementation.");
    await mkdir(".factory/test-results/build-startup-browser", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/build-startup-browser/initial-preparation.png",
    });
    sessionAvailable = true;
    await visible(panel).toContainText("Live activity temporarily unavailable.");
    await page.screenshot({
      path: ".factory/test-results/build-startup-browser/existing-session-unavailable.png",
    });
    if (mutations) throw Error("Status observation must not restart Build");
    state = "failed";
    runtimeState = "stopped";
    turn = turnObservationInput.parse({
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      state: "failed",
      engine: "opencode",
      mode: "build",
      modelId: "controlled-model",
      skills: [],
    });
    await visible(panel.locator(".agent-state")).toHaveText("Failed");
    await page.getByRole("button", { name: "Ticket", exact: true }).click();
    const checks = page.locator(".ticket-checks");
    await visible(checks.locator("summary")).toContainText("Corrections not submitted");
    await visible(checks.locator(".check-indicator")).not.toHaveClass(/passed/);
    await checks.locator("summary").click();
    await visible(checks).toContainText(
      "Earlier checks do not verify the retained corrections. Finish and submit them before review.",
    );
    await visible(page.getByRole("button", { name: "Approve delivery", exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: ".factory/test-results/build-startup-browser/unsubmitted-corrections-prior-checks.png",
    });
    state = "committed";
    turn = { ...turn, state: "completed" };
    await visible(checks.locator("summary")).toContainText("Checks passed");
    await visible(checks.locator(".check-indicator")).toHaveClass(/passed/);
    state = "failed";
    turn = { ...turn, state: "failed" };
    await visible(checks.locator("summary")).toContainText("Corrections not submitted");
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    await visible(panel.locator(".agent-state")).toHaveText("Failed");
    await visible(
      panel.getByRole("button", { name: "Retry implementation", exact: true }),
    ).toHaveCount(0);
    const correction = "Fix the retained code without restarting the original specification.";
    await panel.getByLabel("Message conversation").fill(correction);
    await page.setViewportSize({ width: 390, height: 844 });
    const narrowPanel = page.getByRole("dialog", { name: "Agent panel", exact: true });
    await visible(narrowPanel).toBeVisible();
    await page.screenshot({
      path: ".factory/test-results/build-startup-browser/retained-correction-narrow.png",
    });
    await narrowPanel.getByRole("button", { name: "Send message", exact: true }).click();
    await visible.poll(() => prompts.length).toBe(1);
    await visible(
      narrowPanel.getByRole("button", { name: "Send message", exact: true }),
    ).toBeDisabled();
    if (prompts[0]?.text !== correction || researchRequests || mutations !== 1)
      throw Error("Correction must make exactly one scoped Build request, never research or Start");
    await page.screenshot({
      path: ".factory/test-results/build-startup-browser/retained-correction-sent.png",
    });
  } catch (cause) {
    if (page) {
      await mkdir(".factory/test-results/build-startup-browser", { recursive: true });
      await page.screenshot({
        path: ".factory/test-results/build-startup-browser/failure.png",
      });
      await Bun.write(
        ".factory/test-results/build-startup-browser/failure-ui.txt",
        await page.locator("body").innerText(),
      );
    }
    throw cause;
  } finally {
    await browser.close();
    await database.client.end();
    await fixture.dispose();
  }
}, 180_000);
