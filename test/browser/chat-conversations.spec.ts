import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { conversationViewSchema } from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { chooseConversation, startNewConversation } from "../fixtures/conversation-navigation";
import { openProjectMenu } from "../fixtures/project-menu";
import { serveChatAssets } from "../support/chat-assets";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });
test("planning Skill selection survives an unchanged conversation refresh without sending", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await serveChatAssets(page);
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await (await page.request.get("/api/session")).json();
  const projectID = crypto.randomUUID();
  const slug = `skill-refresh-${projectID}`;
  const database = createDatabase(1);
  const skillsReady = Promise.withResolvers<void>();
  let conversationReads = 0;
  let commissioned = 0;
  const conversation = conversationViewSchema.parse({
    id: crypto.randomUUID(),
    projectId: projectID,
    mode: "plan",
    version: 1,
    entries: [],
    isActiveCoding: false,
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:conversation\/message|agent\/(?:start|prompt)|runtime-attempts\/[^/]+\/start)$/.test(
        new URL(request.url()).pathname,
      )
    )
      commissioned++;
  });
  for (const source of ["source-workspace", "developer-ide"])
    await page.route(`**/api/projects/${projectID}/${source}/ensure`, (route) =>
      route.fulfill({ status: 503, json: { error: "Owned Skill proof starts no runtime" } }),
    );
  await page.route(`**/api/projects/${projectID}/conversation{,?*}`, (route) => {
    conversationReads++;
    return route.fulfill({ json: conversation });
  });
  await page.route(
    `**/api/projects/${projectID}/skills/invocations?role=planning`,
    async (route) => {
      await skillsReady.promise;
      await route.fulfill({
        json: {
          skills: [
            {
              id: crypto.randomUUID(),
              key: "review-reference",
              name: "Review the reference",
              description: "Inspect the supplied reference.",
            },
          ],
          conflicts: [],
        },
      });
    },
  );
  try {
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Skill refresh proof','https://example.invalid/owned-skill-refresh.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "Message conversation", exact: true });
    const suggestions = page.getByRole("listbox", { name: "Available Skills", exact: true });
    await expect(draft).toBeEnabled();
    await draft.fill("/rev");
    await expect(suggestions).toBeVisible();
    await expect(suggestions).toContainText("Loading available Skills…");
    const reads = conversationReads;
    await expect.poll(() => conversationReads).toBeGreaterThanOrEqual(reads + 2);
    await expect(draft).toBeFocused({ timeout: 2_000 });
    await expect(suggestions).toBeVisible({ timeout: 2_000 });
    skillsReady.resolve();
    await expect(suggestions.getByRole("option", { name: /Review the reference/ })).toBeVisible();
    await mkdir(".factory/test-results/skill-refresh", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/skill-refresh/planning-options-wide.png",
    });
    await draft.press("Enter");
    await expect(draft).toHaveValue("/review-reference ");
    await expect(suggestions).not.toBeVisible();
    expect(commissioned).toBe(0);
    await page.screenshot({ path: ".factory/test-results/skill-refresh/planning-wide.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await draft.fill("/rev");
    await expect(suggestions.getByRole("option", { name: /Review the reference/ })).toBeVisible();
    await page.screenshot({ path: ".factory/test-results/skill-refresh/planning-narrow.png" });
    await draft.press("Escape");
    await expect(draft).toHaveValue("/rev");
    expect(commissioned).toBe(0);
  } finally {
    skillsReady.resolve();
    await deleteFactoryProject(projectID, database);
    await database.client.end();
  }
});

test("personal conversation history keeps drafts scoped through selection and reload without starting work", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await mkdir(".factory/test-results/chat-collaboration", { recursive: true });
  await serveChatAssets(page);
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await (await page.request.get("/api/session")).json();
  const projectID = crypto.randomUUID();
  const slug = `chat-conversations-${projectID}`;
  const database = createDatabase(1);
  let commissioned = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:conversation\/message|agent\/(?:start|prompt)|runtime-attempts\/[^/]+\/start)$/.test(
        new URL(request.url()).pathname,
      )
    )
      commissioned++;
  });
  await page.route(`**/api/projects/${projectID}/source-workspace/ensure`, (route) =>
    route.fulfill({ status: 503, json: { error: "Owned chat proof has no source runtime" } }),
  );
  await page.route(`**/api/projects/${projectID}/developer-ide/ensure`, (route) =>
    route.fulfill({ status: 503, json: { error: "Owned chat proof has no editor runtime" } }),
  );
  try {
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${slug},'Conversation draft proof','https://example.invalid/owned-chat.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    const select = async () => {
      await openProjectMenu(page);
      await page.getByRole("button").filter({ hasText: slug }).click();
    };
    await select();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const selector = page.getByLabel("Conversation", { exact: true });
    const draft = page.getByRole("textbox", { name: "Message conversation", exact: true });
    await draft.fill("Unsent original conversation draft");
    await selector.click();
    await expect(page.getByRole("menuitem", { name: "New chat", exact: true })).toBeVisible();
    await expect(page.getByRole("menu", { name: "Conversation history" })).toHaveCSS(
      "width",
      "352px",
    );
    await page.screenshot({
      path: ".factory/test-results/chat-collaboration/project-chat-history-desktop.png",
    });
    await page.getByRole("menuitem", { name: "New chat", exact: true }).click();
    await expect(selector).not.toHaveAttribute("data-context-id", "original");
    const fresh = await selector.getAttribute("data-context-id");
    if (!fresh) throw new Error("Fresh conversation identity is missing");
    await expect(draft).toHaveValue("");
    await draft.fill("Unsent fresh conversation draft");
    await chooseConversation(page, "original");
    await expect(draft).toHaveValue("Unsent original conversation draft");
    await chooseConversation(page, fresh);
    await expect(draft).toHaveValue("Unsent fresh conversation draft");
    await page.reload();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await select();
    if (!(await selector.isVisible()))
      await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    await expect(selector).toHaveAttribute("data-context-id", fresh);
    await expect(draft).toHaveValue("Unsent fresh conversation draft");
    await page.screenshot({
      path: ".factory/test-results/chat-collaboration/conversations-desktop.png",
    });
    await page.setViewportSize({ width: 1024, height: 844 });
    const headingOverflow = await page
      .locator(".lane-heading")
      .evaluateAll((headings) =>
        Math.max(...headings.map((heading) => heading.scrollWidth - heading.clientWidth)),
      );
    expect(headingOverflow).toBeLessThanOrEqual(0);
    const headingGap = await page.locator(".lane-heading").evaluateAll((headings) =>
      Math.min(
        ...headings.map((heading) => {
          const label = heading.querySelector("span");
          const actions = heading.querySelector(".lane-heading-actions");
          if (!label || !actions) throw new Error("Board heading is incomplete");
          return actions.getBoundingClientRect().left - label.getBoundingClientRect().right;
        }),
      ),
    );
    expect(headingGap).toBeGreaterThanOrEqual(7.5);
    await page.screenshot({
      path: ".factory/test-results/chat-collaboration/board-with-chat-1024.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(selector).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({
      path: ".factory/test-results/chat-collaboration/conversations-narrow.png",
    });
    await selector.click();
    await expect(page.getByRole("menuitem", { name: "New chat", exact: true })).toBeVisible();
    await page.screenshot({
      path: ".factory/test-results/chat-collaboration/project-chat-history-narrow.png",
    });
    await page.keyboard.press("Escape");
    expect(commissioned).toBe(0);
  } finally {
    await deleteFactoryProject(projectID, database);
    await database.client.end();
  }
});

test("shared Coding keeps an old unsent draft readable and respects another developer's editing", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await serveChatAssets(page);
  await signIn(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write", "local-network-access"], {
    origin: new URL(page.url()).origin,
  });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await (await page.request.get("/api/session")).json();
  const projectID = crypto.randomUUID(),
    ticketID = crypto.randomUUID(),
    revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID(),
    changeID = crypto.randomUUID(),
    workspaceID = crypto.randomUUID();
  const attemptID = crypto.randomUUID(),
    ben = crypto.randomUUID();
  const suffix = projectID.replaceAll("-", "").slice(0, 12),
    slug = `shared-chat-${suffix}`;
  const database = createDatabase(1);
  let commissioned = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/agent\/(?:start|prompt|resume)$/.test(new URL(request.url()).pathname)
    )
      commissioned++;
  });
  for (const path of ["source-workspace", "developer-ide"])
    await page.route(`**/api/projects/${projectID}/${path}/ensure`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Owned conversation proof has no source or editor compute" },
      }),
    );
  try {
    const canonical = canonicalRequirementContent({
      summary: "Retain conversations",
      acceptanceCriteria: ["Drafts never move silently"],
      nonGoals: [],
    });
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${slug},'Shared conversation proof','https://example.invalid/owned-chat.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
      await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${ben},'Ben',${`${ben}@factory.local`},true)`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${ben},'developer',${session.user.id})`;
      await sql`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${ticketID},${projectID},'Retained shared Coding','in-progress',${session.user.id})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        VALUES(${revisionID},${ticketID},1,${canonical},${createHash("sha256").update(canonical).digest("hex")},${session.user.id})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
        VALUES(${approvalID},${ticketID},${revisionID},${session.user.id})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
        VALUES(${changeID},${projectID},${ticketID},${approvalID},${`factory/change-${suffix}`},${"a".repeat(40)},'active',${session.user.id})`;
      await sql`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,
        idempotency_key,state,observed_head_sha,completed_at)
        VALUES(${crypto.randomUUID()},${changeID},'owned-process-fixture',${slug},${`factory/change-${suffix}`},
          ${"a".repeat(40)},${changeID},'succeeded',${"a".repeat(40)},now())`;
      await sql`INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,source_branch,source_revision,kubernetes_namespace,volume_name,created_by)
        VALUES(${workspaceID},${projectID},'ticket',${ticketID},${changeID},${`factory/change-${suffix}`},${"a".repeat(40)},${`factory-workspace-${suffix}`},'never-created',${session.user.id})`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,kubernetes_namespace,kubernetes_pod_name,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,stop_intended_at,stopped_at,created_by)
        VALUES(${attemptID},${projectID},${changeID},${workspaceID},1,${"a".repeat(40)},'stopped',${`owned-chat-${suffix}`},'never-created',
          ${"b".repeat(64)},${"c".repeat(64)},now(),now(),now(),${session.user.id})`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${attemptID} WHERE id=${changeID}`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,native_session_confirmed_at,created_by)
        VALUES(${changeID},${attemptID},${`ses_owned_${suffix}`},'committed',now(),${session.user.id})`;
      await sql`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
        VALUES(${crypto.randomUUID()},${projectID},${ticketID},'build',${session.user.id})`;
    });
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "Message conversation", exact: true });
    await draft.fill("Keep this **unsent original** draft.");
    await startNewConversation(page);
    await page.getByRole("button", { name: "Start fresh conversation", exact: true }).click();
    const selector = page.getByLabel("Conversation", { exact: true });
    await expect(selector).not.toHaveAttribute("data-context-id", "original");
    const active = await selector.getAttribute("data-context-id");
    if (!active) throw new Error("Active Coding identity is missing");
    await expect(draft).toHaveValue("");
    await chooseConversation(page, "original");
    await page.getByText("Unsent draft", { exact: true }).click();
    await expect(
      page.getByText("Keep this **unsent original** draft.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Copy retained draft", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "Keep this **unsent original** draft.",
    );
    await expect(draft).toHaveCount(0);
    await page.getByRole("button", { name: "Return to active Coding", exact: true }).click();
    await expect(selector).toHaveAttribute("data-context-id", active);
    await draft.fill("Prepared instructions while Ben is editing");
    await database.client`UPDATE factory.change_writer SET state='human',user_id=${ben},turn_id=NULL,epoch=epoch+1 WHERE change_id=${changeID}`;
    await expect(page.getByText("Ben is editing", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect(draft).toHaveValue("Prepared instructions while Ben is editing");
    expect(commissioned).toBe(0);
    await page.screenshot({
      path: ".factory/test-results/chat-collaboration/shared-draft-desktop.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".factory-desktop")).toHaveClass(/agent-is-overlay/);
    await expect(draft).toBeVisible();
    await draft.click();
    await expect(draft).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({
      path: ".factory/test-results/chat-collaboration/shared-draft-narrow.png",
    });
  } finally {
    await deleteFactoryProject(projectID, database);
    await database.client.end();
  }
});
