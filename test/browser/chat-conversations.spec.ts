import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { conversationViewSchema } from "../../apps/factory/src/api-contracts";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { test } from "../fixtures/browser-test";
import { chooseConversation, startNewConversation } from "../fixtures/conversation-navigation";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserBootstrap, mockFactoryFunctions } from "../fixtures/server-functions";
import { serveChatAssets } from "../support/chat-assets";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });
test("saved chat stays tidy across screen sizes, long Markdown and a growing draft", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const evidence = ".factory/test-results/chat-refinement";
  await mkdir(evidence, { recursive: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await serveChatAssets(page);
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  const projectID = crypto.randomUUID();
  const conversationID = crypto.randomUUID();
  const slug = `chat-layout-${projectID}`;
  const database = createDatabase(1);
  const messages = [
    {
      actor: "user",
      body: "Can we simplify the chat layout?",
    },
    {
      actor: "project-agent",
      body: "Yes. I’ll check message spacing, tool activity and the composer.\n\nNavigation and saved drafts will stay unchanged.",
    },
    {
      actor: "user",
      body: "Keep file attachments and keyboard access working on mobile too.",
    },
    {
      actor: "project-agent",
      body: "## What I’ll check\n\n- Readable messages without oversized bubbles\n- One clear Copy action per message\n- Enough room to write, attach a file and send\n\nI’ll test narrow screens as well as desktop.",
    },
  ];
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
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Owned chat layout has no runtime");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Owned chat layout has no runtime");
      },
    },
  });
  try {
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${slug},'Factory workspace','https://example.invalid/chat-layout.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
      await sql`INSERT INTO factory.ticket_conversation(id,project_id,mode,created_by)
        VALUES(${conversationID},${projectID},'plan',${session.user.id})`;
      for (const [index, message] of messages.entries())
        await sql`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,citations,created_by)
          VALUES(${crypto.randomUUID()},${conversationID},${index + 1},
            ${message.actor === "user" ? "user-message" : "agent-message"},${message.actor},'plan',${message.body},'{}'::jsonb,'[]'::jsonb,${session.user.id})`;
    });
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
    const panel = page.locator(".agent-panel");
    const history = panel.locator(".agent-messages");
    const draft = panel.getByRole("textbox", { name: "Message conversation", exact: true });
    const shell = panel.locator(".agent-input-shell");
    await expect(history.locator(".agent-message")).toHaveCount(4);
    await expect(draft).toBeEnabled();
    await expect(page.getByText(/scripted test data/)).toHaveCount(0);
    await draft.fill("Keep the current navigation.");
    for (const width of [1440, 1024, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(draft).toHaveValue("Keep the current navigation.");
      await expect(panel.locator(".conversation-title")).toBeVisible();
      await expect(shell).toBeInViewport();
      await expect(history).toHaveCSS("row-gap", "12px");
      await expect(shell).toHaveCSS("padding", "0px");
      await expect(shell).toHaveCSS("border-radius", "6px");
      await expect(panel.locator(".agent-composer")).toHaveCSS("padding", "8px");
      await expect(history.locator(".agent-message.user > .markdown-body").first()).toHaveCSS(
        "border-radius",
        "6px",
      );
      await expect(history.locator("h2")).toHaveCSS("font-size", "14px");
      await expect(history.locator("h2")).toHaveCSS("font-style", "normal");
      await expect(history.locator(".copy-feedback .feedback-mark").first()).toBeHidden();
      await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      if (width <= 760) {
        await expect(draft).toHaveCSS("font-size", "16px");
        await expect(history.locator(".copy-feedback").first()).toHaveCSS("min-height", "44px");
        const bounds = await shell.boundingBox();
        if (!bounds) throw new Error("Chat composer is missing");
        expect(bounds.height).toBeLessThanOrEqual(108);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await history.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: `${evidence}/chat-${width}.png` });
    }
    const copy = history
      .getByRole("button", { name: "Copy Assistant message", exact: true })
      .last();
    await history.locator(".agent-message").last().hover();
    await copy.click();
    await expect(copy).toHaveAttribute("data-feedback", "success");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(messages[3]?.body);
    await draft.fill("First line");
    await draft.press("End");
    await draft.press("Shift+Enter");
    await expect(draft).toHaveValue("First line\n");
    await draft.fill(
      Array.from({ length: 16 }, (_, index) => `Draft line ${index + 1}`).join("\n"),
    );
    await expect(draft).toBeFocused();
    await expect
      .poll(() => draft.evaluate((element) => element.getBoundingClientRect().height))
      .toBeLessThanOrEqual(160);
    await expect(shell).toBeInViewport();
    await expect(
      panel.getByRole("button", { name: "Add image or file", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 568 });
    await expect(shell).toBeInViewport();
    await expect(history).toBeVisible();
    expect(await history.evaluate((element) => element.clientHeight)).toBeGreaterThan(72);
    await page.screenshot({ path: `${evidence}/growing-draft-390.png` });
    expect(commissioned).toBe(0);

    const longToken = `workspace_${"long_identifier_".repeat(32)}`;
    const edgeBody = `## Long content\n\nhttps://example.invalid/${longToken}\n\n\`\`\`ts\nconst path = "${longToken}";\n\`\`\`\n\n| Field | Value |\n| --- | --- |\n| Path | \`${longToken}\` |\n\nSecond paragraph remains separate.`;
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,citations,created_by)
        VALUES(${crypto.randomUUID()},${conversationID},5,'agent-message','project-agent','plan',
          ${edgeBody},'{}'::jsonb,'[]'::jsonb,${session.user.id})`;
      await sql`UPDATE factory.ticket_conversation SET version=version+1 WHERE id=${conversationID}`;
    });
    await expect(history).toContainText("Second paragraph remains separate.");
    await draft.fill("Keep the current navigation.");
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const last = history.locator(".agent-message").last();
      await last.scrollIntoViewIfNeeded();
      const overflow = await history.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await expect(last.locator("pre")).toHaveCSS("overflow-x", "auto");
      await expect(last.locator("table")).toHaveCSS("overflow-x", "auto");
      await expect(last.locator("th").first()).toHaveCSS("white-space", "nowrap");
      expect(
        await last
          .locator("th")
          .first()
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(44);
      expect(
        await last
          .locator("table")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
      await expect(draft).toHaveValue("Keep the current navigation.");
      await page.screenshot({ path: `${evidence}/long-content-${width}.png` });
    }
    const attachmentHelp = panel.getByLabel("Attachment formats and limits", { exact: true });
    await attachmentHelp.click();
    await expect(
      panel.getByText("Only you can access these files, including after sending."),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(attachmentHelp).toBeFocused();
    expect(commissioned).toBe(0);
  } finally {
    await deleteFactoryProject(projectID, database);
    await database.client.end();
  }
});

test("planning Skill selection survives an unchanged conversation refresh without sending", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await serveChatAssets(page);
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
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
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Owned Skill proof starts no runtime");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Owned Skill proof starts no runtime");
      },
    },
  });
  await mockFactoryFunctions(page, {
    conversations: {
      get: async (_actor, _factoryTargetID, _factoryCommand) => {
        conversationReads++;
        return conversationViewSchema.nullable().parse(conversation);
      },
    },
  });
  await mockFactoryFunctions(page, {
    skills: {
      async invocations() {
        await skillsReady.promise;
        return {
          skills: [
            {
              id: crypto.randomUUID(),
              key: "review-reference",
              name: "Review the reference",
              description: "Inspect the supplied reference.",
            },
          ],
          conflicts: [],
        };
      },
    },
  });
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
    // Reads are change-driven, not polled. Explicit wake events exercise two
    // unchanged refreshes while the pending Skill choice keeps its focus.
    for (let refresh = 0; refresh < 2; refresh++) {
      const reads = conversationReads;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => conversationReads).toBeGreaterThan(reads);
      await expect(draft).toBeFocused({ timeout: 2_000 });
      await expect(suggestions).toBeVisible({ timeout: 2_000 });
    }
    skillsReady.resolve();
    await expect(suggestions.getByRole("option", { name: /Review the reference/ })).toBeVisible();
    await expect(suggestions.locator(":scope > p:not([role]), :scope > small")).toHaveCount(0);
    await expect(suggestions.locator("strong")).toHaveText("Review the reference");
    expect(
      await suggestions
        .getByRole("option")
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(48);
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
    await expect(draft).toBeFocused();
    await expect(suggestions.getByRole("option", { name: /Review the reference/ })).toBeVisible();
    await expect(draft).toBeFocused();
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
  const { session } = await browserBootstrap(page);
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
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Owned chat proof has no source runtime");
      },
    },
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Owned chat proof has no editor runtime");
      },
    },
  });
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
    // The width belongs to the popover, not its padded inner menu.
    await expect(page.getByRole("dialog", { name: "Conversation history" })).toHaveCSS(
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
    // Reload restores this resource before another deliberate selection. Opening
    // the picker during that restoration races its legitimate navigation close
    // and would hide a failure to retain the selected Project.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectID}(?:[/?#]|$)`));
    await expect(
      page.getByRole("button", { name: "Open project menu", exact: true }),
    ).toContainText("Conversation draft proof");
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
    await expect(page.locator(".lane-heading button, .lane-heading-actions")).toHaveCount(0);
    await expect(page.locator(".lane-heading h2")).toHaveText([
      "Ideas",
      "Requirements",
      "Implementation",
      "Review",
    ]);
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
  const { session } = await browserBootstrap(page);
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
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError(
          "unavailable",
          "Owned conversation proof has no source or editor compute",
        );
      },
      ensureEditor: async () => {
        throw new CommandError(
          "unavailable",
          "Owned conversation proof has no source or editor compute",
        );
      },
    },
  });
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
      await sql`INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,source_branch,source_revision,created_by)
        VALUES(${workspaceID},${projectID},'ticket',${ticketID},${changeID},${`factory/change-${suffix}`},${"a".repeat(40)},${session.user.id})`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,stop_intended_at,stopped_at,created_by)
        VALUES(${attemptID},${projectID},${changeID},${workspaceID},1,${"a".repeat(40)},'stopped',
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
