import { test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect as visible } from "@playwright/test";
import { factoryProcess } from "../fixtures/factory-process";

test("initial Build preparation is not a history outage, but a lost existing session still is", async () => {
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
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes(`/changes/${changeID}/agent`))
        mutations++;
    });
    await page.route(`**/api/projects/${projectID}/source-workspace/ensure`, (route) =>
      route.fulfill({ status: 503, json: { error: "No source in controlled fixture" } }),
    );
    await page.route(`**/api/projects/${projectID}/developer-ide/ensure`, (route) =>
      route.fulfill({ status: 503, json: { error: "No IDE in controlled fixture" } }),
    );
    await page.route(`**/api/changes/${changeID}/agent{,?*}`, (route) =>
      route.fulfill({
        json: {
          state: "starting",
          runtimeState: "starting",
          messagesAvailable: false,
          sessionAvailable,
          runtimeConnected: false,
          stopPending: false,
          stopId: null,
          messages: [],
        },
      }),
    );
    await page.goto(fixture.base);
    await page.getByRole("button", { name: "Open project menu", exact: true }).click();
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .filter({ hasText: "Initial Build startup" })
      .click();
    await page.getByRole("button", { name: "Open IDE", exact: true }).click();
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
