import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import {
  type ConversationStreamEvent,
  type ConversationView,
  changesResponseSchema,
  conversationViewSchema,
  sourceWorkspaceViewSchema,
} from "../../apps/factory/src/api-contracts";
import { CommandError } from "../../apps/factory/src/command-error";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import {
  type InterviewQuestion,
  interviewAnswerCommandInput,
} from "../../packages/conversation-domain/src/conversation";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  browserFunction,
  factoryFunctionMatches,
  mockAgentView,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

const userID = "01994a7d-0000-7000-8000-000000000001";
const evidenceDirectory = ".factory/test-results/interview-coherence";
const ticketTitle = "Clarify the release summary";
const options = [
  { id: "developer", label: "Developer", description: "Writes and ships the change" },
  { id: "manager", label: "Project manager", description: "Reviews the intended outcome" },
];
let database: ReturnType<typeof createDatabase> | undefined;
let projectID = "";
let projectSlug = "";
let ticketID = "";
let questionID = "";

test.use({ viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(40_000);
test.beforeEach(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  projectSlug = `interview-${projectID.slice(0, 8)}`;
  ticketID = crypto.randomUUID();
  questionID = crypto.randomUUID();
  await database.client`
    INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
    VALUES (${projectID}, ${projectSlug}, 'Interview coherence', 'https://example.invalid/interview.git',
      'main', '.devcontainer/devcontainer.json', ${userID})
  `;
  await database.client`
    INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
    VALUES (${ticketID}, ${projectID}, ${ticketTitle}, '', 'ready', ${userID})
  `;
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  if (projectID) await deleteFactoryProject(projectID);
  await database?.client.end();
  database = undefined;
  projectID = "";
});

async function openProject(page: Page) {
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
}

test("loads exact Sansita display typography while keeping interface text in Inter", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const display = await page.locator(".signin-brand h1").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      family: style.fontFamily,
      weight: style.fontWeight,
      style: style.fontStyle,
      loaded: document.fonts.check('italic 400 32px "Sansita"'),
    };
  });
  expect(display).toMatchObject({
    family: expect.stringContaining("Sansita"),
    weight: "400",
    style: "italic",
    loaded: true,
  });
  expect(
    await page.getByLabel("Email").evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("Inter");
  await page.screenshot({ path: `${evidenceDirectory}/sansita-display.png` });
});

async function openTicketAgent(page: Page) {
  await openProject(page);
  await page.getByRole("button", { name: new RegExp(ticketTitle) }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
    ticketTitle,
  );
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("complementary", { name: "Agent panel" });
  await expect
    .poll(async () => {
      const windowBounds = await page.locator(".workspace-window").boundingBox();
      const panelBounds = await panel.boundingBox();
      return windowBounds && panelBounds
        ? windowBounds.x - panelBounds.x - panelBounds.width
        : Number.NEGATIVE_INFINITY;
    })
    .toBeGreaterThanOrEqual(0);
  return panel;
}

test("proposal introductions render safe Markdown instead of literal formatting", async ({
  page,
}) => {
  if (!database) throw new Error("Fixture database unavailable");
  const conversationID = crypto.randomUUID();
  await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by,mode)
    VALUES(${conversationID},${projectID},${ticketID},${userID},'plan')`;
  await database.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
    VALUES(${crypto.randomUUID()},${conversationID},1,'requirement','project-agent','plan',
    ${'Review **the proposal**.\n\n- Keep the tracker\n\n<img src="invalid" onerror="alert(1)">'},
    '{}'::jsonb)`;
  const panel = await openTicketAgent(page);
  const proposal = panel.locator(".conversation-requirement");
  await expect(proposal.locator("strong")).toHaveText("the proposal", { timeout: 2000 });
  await expect(proposal.locator("li")).toHaveText("Keep the tracker");
  await expect(proposal.locator("img")).toHaveCount(0);
  await expect(proposal).toContainText('<img src="invalid"');
  await page.screenshot({ path: `${evidenceDirectory}/proposal-markdown.png` });
});

for (const outcome of ["complete", "error"] as const) {
  test(`streams Markdown in the selected context and cleans up on ${outcome}`, async ({ page }) => {
    test.setTimeout(90_000);
    const turnId = crypto.randomUUID();
    let view: ConversationView = {
      id: crypto.randomUUID(),
      projectId: projectID,
      ticketId: ticketID,
      mode: "plan",
      version: 1,
      contextId: null,
      activeCodingContextId: null,
      isActiveCoding: false,
      contexts: [],
      codingHistory: null,
      entries: [],
    };
    let holdRead = false;
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const readDelivered = Promise.withResolvers<void>();
    await mockFactoryFunctions(page, {
      conversations: {
        get: async () => {
          const captured = view;
          if (holdRead) {
            holdRead = false;
            readStarted.resolve();
            await releaseRead.promise;
            readDelivered.resolve();
          }
          return captured;
        },
      },
    });
    let streamRequests = 0;
    let emitProjectAnswer: (event: ConversationStreamEvent, close?: boolean) => void = () => {
      throw new Error("Native answer stream has not opened");
    };
    await mockFactoryFunctions(page, {
      conversations: {
        message: async () => {
          streamRequests++;
          return new ReadableStream<ConversationStreamEvent>({
            start(controller) {
              emitProjectAnswer = (event, close = false) => {
                controller.enqueue(event);
                if (close) controller.close();
              };
              emitProjectAnswer({ type: "admitted", turnId });
              emitProjectAnswer({
                type: "answer",
                turnId,
                text: "**Live answer**\n\n- First point",
              });
            },
          });
        },
      },
    });
    const panel = await openTicketAgent(page);
    const message = panel.getByLabel("Message conversation");
    await message.fill("Give me a quick overview");
    await message.press("Enter");
    await expect.poll(() => streamRequests).toBe(1);
    const live = panel.getByLabel("Assistant streaming response");
    await expect(live.locator("strong")).toHaveText("Live answer");
    await expect(live.locator("li")).toHaveText("First point");
    await expect(panel.getByLabel("Assistant responding")).toBeHidden();
    await expect(message).toHaveValue("");
    await page.getByRole("button", { name: "Minimize Agent panel" }).click();
    await expect(panel).toBeHidden();
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
    await expect(live).toBeVisible();
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await expect(panel.getByLabel("Assistant streaming response")).toHaveCount(0);
    await page.getByRole("tab", { name: ticketTitle, exact: true }).click();
    await expect(live).toBeVisible();
    await mkdir(".factory/test-results/streaming", { recursive: true });
    await page.screenshot({ path: `.factory/test-results/streaming/${outcome}-live.png` });
    if (outcome === "complete") {
      const longText = `**Live answer**\n\n${Array.from({ length: 24 }, (_, index) => `Paragraph ${index + 1}. Read earlier messages without being pulled down.`).join("\n\n")}`;
      emitProjectAnswer({ type: "answer", turnId, text: longText });
      const history = panel.locator(".conversation-history");
      await expect
        .poll(() => history.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      await history.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      emitProjectAnswer({
        type: "answer",
        turnId,
        text: `${longText}\n\nNext question after a layout change.`,
      });
      await expect
        .poll(() =>
          history.evaluate(
            (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(24);
      await history.hover();
      await page.mouse.wheel(0, -4000);
      await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0);
      emitProjectAnswer({ type: "answer", turnId, text: `${longText}\n\nMore streamed text.` });
      await expect(live).toContainText("More streamed text.");
      await page.waitForTimeout(80);
      expect(await history.evaluate((element) => element.scrollTop)).toBe(0);
      try {
        holdRead = true;
        await readStarted.promise;
        view = {
          ...view,
          version: 2,
          entries: [
            {
              id: crypto.randomUUID(),
              ordinal: 1,
              kind: "agent-message",
              actor: "project-agent",
              mode: "plan",
              body: "**Live answer**\n\n- First point\n- Finished",
              payload: {},
              citations: [],
              createdAt: new Date().toISOString(),
            },
          ],
        };
        emitProjectAnswer({ type: "complete", conversation: view }, true);
        await expect(panel.locator(".agent-message.assistant")).toHaveCount(1);
        await expect(panel.locator(".agent-message.assistant")).toContainText("Finished");
        releaseRead.resolve();
        await readDelivered.promise;
        // A stale native read must never remove the completed answer, even briefly.
        await expect(panel.locator(".agent-message.assistant")).toContainText("Finished", {
          timeout: 300,
        });
      } finally {
        holdRead = false;
        releaseRead.resolve();
      }
    } else {
      emitProjectAnswer({ type: "error", error: "Owned response failed" }, true);
      await expect(panel).not.toContainText("Live answer");
      await expect(page.getByRole("alert")).toContainText("Owned response failed");
    }
    await expect(live).toHaveCount(0);
    expect(streamRequests).toBe(1);
  });
}

async function insertQuestion(question: InterviewQuestion) {
  if (!database) throw new Error("Missing fixture database");
  const conversationID = crypto.randomUUID();
  await database.client`
    INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
    VALUES (${conversationID}, ${projectID}, ${ticketID}, 'plan', ${userID})
  `;
  await database.client`
    INSERT INTO factory.conversation_entry(id, conversation_id, ordinal, kind, actor, mode, body, payload)
    VALUES (${questionID}, ${conversationID}, 1, 'question', 'project-agent', 'plan', ${question.prompt},
      ${JSON.stringify({ question, message: "Choose what matches the intended change." })}::jsonb)
  `;
}

// Check the rendered answer UX without dispatching paid model work or starting compute.
async function captureAnswer(page: Page) {
  let submitted: unknown;
  await mockFactoryFunctions(page, {
    conversations: {
      answer: async (_actor, _factoryTargetID, factoryCommand) => {
        const parsed = interviewAnswerCommandInput.parse(factoryCommand);
        submitted = {
          ticketId: parsed.ticketId,
          questionEntryId: parsed.questionEntryId,
          answer: parsed.answer,
        };
        return (() => {
          throw new CommandError("unavailable", String("Fixture answer delivery interrupted"));
        })();
      },
    },
  });
  return () => submitted;
}

for (const buildState of ["stopped", "failed"] as const)
  test(`IDE tabs retain their own Ticket conversation after switching and minimizing from ${buildState}`, async ({
    page,
  }) => {
    if (!database) throw new Error("Fixture database unavailable");
    const revisionID = crypto.randomUUID(),
      approvalID = crypto.randomUUID(),
      changeID = crypto.randomUUID();
    const canonical = JSON.stringify({
      summary: "Release summary",
      acceptanceCriteria: ["Readable summary"],
      nonGoals: [],
    });
    await database.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${revisionID},${ticketID},1,${canonical},${createHash("sha256").update(canonical).digest("hex")},${userID})`;
    await database.client`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${approvalID},${ticketID},${revisionID},${userID})`;
    await database.client`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${changeID},${projectID},${ticketID},${approvalID},${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`},${"a".repeat(40)},'active',${userID})`;
    await database.client`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at) VALUES(${crypto.randomUUID()},${changeID},'owned','interview',${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`},${"a".repeat(40)},${`owned:${changeID}`},'succeeded',${"a".repeat(40)},now())`;
    const buildView = {
      state: buildState,
      ...(buildState === "failed"
        ? {
            turn: {
              id: crypto.randomUUID(),
              commandId: crypto.randomUUID(),
              state: "failed",
              engine: "opencode",
              mode: "build",
              modelId: "owned-model",
              skills: [],
              summary: "The previous implementation needs correction.",
            },
          }
        : {}),
      sessionAvailable: true,
      runtimeConnected: true,
      runtimeState: "ready",
      messages: [],
      messagesAvailable: true,
      stopPending: false,
      stopId: null,
    };
    await mockFactoryFunctions(page, {
      runtime: {
        changes: async (_actor, factoryTargetID) => {
          const response = await serverCall(browserFunction(page, "getChanges", [factoryTargetID]));
          const body = (await response) as { changes: Array<Record<string, unknown>> };
          return changesResponseSchema.parse({
            changes: body.changes.map((change) => ({ ...change, runtimeState: "ready" })),
          });
        },
      },
    });
    await mockAgentView(page, changeID, async () => buildView, { activity: true });
    let buildPrompt: unknown;
    await mockFactoryFunctions(page, {
      agent: {
        prompt: async (_actor, _factoryTargetID, factoryCommand) => {
          buildPrompt = factoryCommand;
          return (() => {
            throw new CommandError("unavailable", String("Owned Build dispatch interrupted"));
          })();
        },
      },
    });
    await mockFactoryFunctions(page, {
      workspaces: {
        ensurePersonalSource: async () => {
          throw new CommandError("unavailable", "Owned source test does not start compute");
        },
      },
    });
    await mockFactoryFunctions(page, {
      workspaces: {
        ensureEditor: async () => {
          throw new CommandError("unavailable", "Owned IDE test does not start compute");
        },
      },
    });
    await mockFactoryFunctions(page, {
      workspaces: {
        getSource: async () => ({
          label: "Owned source",
          ...sourceWorkspaceViewSchema.parse({
            workspaceID: crypto.randomUUID(),
            serviceID: "owned-source",
            epoch: 1,
            state: "preparing",
            failure: null,
          }),
        }),
      },
    });
    const conversationID = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by,mode) VALUES(${conversationID},${projectID},${ticketID},${userID},'investigate')`;
    await database.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload) VALUES(${crypto.randomUUID()},${conversationID},1,'agent-message','project-agent','investigate','Retained Ticket research','{}'::jsonb)`;
    await mockFactoryFunctions(page, {
      workspaces: {
        ensureChangeSource: async () => ({
          label: "Owned source",
          ...sourceWorkspaceViewSchema.parse({
            workspaceID: crypto.randomUUID(),
            serviceID: "owned-source",
            epoch: 1,
            state: "preparing",
            failure: null,
          }),
        }),
      },
    });
    const panel = await openTicketAgent(page);
    await expect(panel).toContainText("Retained Ticket research");
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    const ide = page.getByRole("tab", { name: `IDE · ${ticketTitle}`, exact: true });
    await expect(ide).toBeVisible();
    await expect(panel).toContainText("Retained Ticket research");
    const message = panel.getByLabel("Message conversation");
    await expect(message).toHaveAttribute(
      "placeholder",
      buildState === "failed"
        ? "Describe what to fix in the retained code…"
        : "Ask a question or describe the next change…",
    );
    await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await message.fill("Continue this exact Change");
    await message.press("Enter");
    await expect
      .poll(() => buildPrompt)
      .toMatchObject({ text: "Continue this exact Change", commandId: expect.any(String) });
    await expect(message).toHaveValue("Continue this exact Change");
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await expect(panel).not.toContainText("Retained Ticket research");
    await ide.click();
    await expect(panel).toContainText("Retained Ticket research");
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await expect(panel).toContainText("Retained Ticket research");
    await page.getByRole("button", { name: "Choose IDE instance", exact: true }).click();
    await page.getByRole("menuitem", { name: /My workspace/ }).click();
    await expect(panel).not.toContainText("Retained Ticket research");
    await expect(panel.getByLabel("Message conversation")).toHaveAttribute(
      "placeholder",
      "Describe the change you want to plan…",
    );
  });

test("keeps truthful pending Interview feedback in the transcript and retains a failed answer", async ({
  page,
}) => {
  await insertQuestion({
    type: "single-select",
    prompt: "Who needs the release summary?",
    options,
    allowCustom: true,
  });
  const panel = await openTicketAgent(page);
  const question = panel.locator(".conversation-question");
  await question.getByRole("radio", { name: /Developer/ }).check();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let showProgress = false;
  const disposeRead = await mockFactoryFunctions(page, {
    conversations: {
      get: async (_actor, id, input) => {
        const body = await serverCall(browserFunction(page, "getConversation", [id, input]));
        if (!showProgress || !body) return body;
        return conversationViewSchema.parse({
          ...body,
          turn: {
            id: crypto.randomUUID(),
            commandId: crypto.randomUUID(),
            state: "running",
            engine: "mastra",
            mode: "plan",
            modelId: "owned-ui-model",
            skills: [],
            progress: { phase: "reading", completedLookups: 2 },
          },
        });
      },
    },
  });
  await mockFactoryFunctions(page, {
    conversations: {
      answer: async (_actor, _factoryTargetID, _factoryCommand) => {
        showProgress = true;
        await waiting;
        return (() => {
          throw new CommandError("unavailable", String("Owned delayed answer interrupted"));
        })();
      },
    },
  });
  try {
    await question.getByRole("button", { name: "Continue" }).click();
    const pending = page.getByRole("status", { name: "Assistant responding" });
    await expect(pending).toBeVisible();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending).toContainText("Reading Project sources… · 2 research steps completed");
    await expect(page.locator(".assistant-skeleton span")).toHaveCount(3);
    expect(
      await page
        .locator(".assistant-skeleton span")
        .first()
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    await expect(page.locator(".agent-input-shell")).not.toContainText(/Preparing|Thinking/);
    await page.screenshot({ path: `${evidenceDirectory}/interview-pending-desktop.png` });
    await page.setViewportSize({ width: 430, height: 900 });
    await expect(pending).toBeVisible();
    await page.screenshot({ path: `${evidenceDirectory}/interview-pending-narrow.png` });
    release();
    await disposeRead();
    await expect(
      page.getByRole("alert").filter({ hasText: "Owned delayed answer interrupted" }),
    ).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(
      page.locator(".conversation-question").getByRole("radio", { name: /Developer/ }),
    ).toBeChecked();
  } finally {
    release();
  }
});

test("makes empty Agent guidance and the composer match the selected Ticket context", async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("complementary", { name: "Agent panel" });
  await expect(panel.locator(".agent-empty")).toContainText("Ask about the Project");
  await expect(panel.locator("header strong")).toHaveCount(0);
  await page.getByRole("region", { name: "requirements" }).locator(".ticket-card-body").click();
  await expect(panel.locator(".agent-empty")).toContainText("Ask about this Ticket");
  await expect(panel.locator(".assistant-context-chip")).toHaveCount(0);
  await expect(panel.getByLabel("Message conversation")).toHaveAttribute(
    "placeholder",
    "Clarify this Ticket's requirements…",
  );
  await page.screenshot({ path: `${evidenceDirectory}/agent-ticket-empty.png` });
});

test("offers one single-select answer path and reveals custom input only when selected", async ({
  page,
}) => {
  await insertQuestion({
    type: "single-select",
    prompt: "Who needs the release summary?",
    options: [...options, { id: "other", label: "Something else", description: "" }],
    allowCustom: true,
  });
  const panel = await openTicketAgent(page);
  const question = panel.locator(".conversation-question");
  await expect(question.getByRole("radio", { name: "Something else", exact: true })).toHaveCount(1);
  const next = question.getByRole("button", { name: "Continue" });
  await expect(next).toBeDisabled();
  await expect(question.getByLabel("Custom answer")).toBeHidden();
  await expect(panel.getByLabel("Message conversation")).toBeHidden();
  await expect(panel.getByRole("button", { name: "Send message" })).toBeHidden();
  await expect(panel.locator(".agent-input-shell")).toBeHidden({ timeout: 1500 });
  await question.getByRole("radio", { name: /Developer/ }).check();
  await expect(next).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Continue clarification", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".clarification-status")).toHaveText("Continue clarification");
  await page.screenshot({ path: `${evidenceDirectory}/interview-single.png` });
  await question.getByRole("radio", { name: "Something else", exact: true }).check();
  await expect(question.getByRole("radio", { name: /Developer/ })).not.toBeChecked();
  await expect(next).toBeDisabled();
  await question.getByLabel("Custom answer").fill("Support engineers");
  await expect(next).toBeEnabled();
  const element = await question.elementHandle();
  await page.waitForResponse(
    async (response) => await factoryFunctionMatches(response.url(), "getChanges"),
  );
  await expect(question.getByLabel("Custom answer")).toHaveValue("Support engineers");
  expect(await element?.evaluate((node) => node.isConnected)).toBe(true);
  await page.screenshot({ path: `${evidenceDirectory}/interview-custom.png` });
  await page.setViewportSize({ width: 900, height: 900 });
  const overlay = page.getByRole("dialog", { name: "Agent panel" });
  await expect(overlay.getByLabel("Custom answer")).toHaveValue("Support engineers");
  const geometry = await overlay.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const questionBounds = element.querySelector(".conversation-question")?.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(element).paddingBottom);
    return (
      !!questionBounds &&
      questionBounds.left >= bounds.left &&
      questionBounds.right <= bounds.right &&
      questionBounds.bottom <= bounds.bottom - padding
    );
  });
  expect(geometry).toBe(true);
  await page.screenshot({ path: `${evidenceDirectory}/interview-narrow.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  const submitted = await captureAnswer(page);
  await next.click();
  await expect.poll(submitted).toEqual({
    ticketId: ticketID,
    questionEntryId: questionID,
    answer: { selectedOptionIds: [], customText: "Support engineers" },
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Fixture answer delivery interrupted" }),
  ).toBeVisible();
  await expect(question.getByLabel("Custom answer")).toHaveValue("Support engineers");
  await question.getByRole("radio", { name: /Project manager/ }).check();
  await expect(question.getByLabel("Custom answer")).toBeHidden();
  await next.click();
  await expect.poll(submitted).toEqual({
    ticketId: ticketID,
    questionEntryId: questionID,
    answer: { selectedOptionIds: ["manager"], customText: "" },
  });
});

test("keeps multi-select choices with an optional custom addition and one Continue action", async ({
  page,
}) => {
  await insertQuestion({
    type: "multi-select",
    prompt: "Who should be able to read it?",
    options,
    allowCustom: true,
  });
  const panel = await openTicketAgent(page);
  const question = panel.locator(".conversation-question");
  await expect(question.getByLabel("Custom answer")).toBeHidden();
  await question.getByRole("checkbox", { name: /Developer/ }).check();
  await question.getByRole("checkbox", { name: /Project manager/ }).check();
  await question.getByRole("checkbox", { name: "Add another answer", exact: true }).check();
  await question.getByLabel("Custom answer").fill("Support engineers");
  await expect(question.getByRole("button", { name: "Continue" })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Send message" })).toBeHidden();
  await page.screenshot({ path: `${evidenceDirectory}/interview-multi.png` });
  const submitted = await captureAnswer(page);
  await question.getByRole("button", { name: "Continue" }).click();
  await expect.poll(submitted).toEqual({
    ticketId: ticketID,
    questionEntryId: questionID,
    answer: { selectedOptionIds: ["developer", "manager"], customText: "Support engineers" },
  });
});

test("uses one visible text answer and requires content for a free-text question", async ({
  page,
}) => {
  await insertQuestion({
    type: "free-text",
    prompt: "What should remain out of scope?",
    placeholder: "Describe the boundary",
  });
  const panel = await openTicketAgent(page);
  const question = panel.locator(".conversation-question");
  const next = question.getByRole("button", { name: "Continue" });
  await expect(question.getByLabel("Custom answer")).toBeVisible();
  await expect(next).toBeDisabled();
  await question.getByLabel("Custom answer").fill("   ");
  await expect(next).toBeDisabled();
  await question.getByLabel("Custom answer").fill("No deployment changes.");
  await expect(next).toBeEnabled();
  await expect(question.getByRole("radio")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Send message" })).toBeHidden();
  await page.screenshot({ path: `${evidenceDirectory}/interview-free-text.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = page.locator(".agent-panel .conversation-question");
  await expect(phone.getByLabel("Custom answer")).toHaveValue("No deployment changes.");
  await expect(phone.getByLabel("Custom answer")).toHaveCSS("border-radius", "6px");
  await expect(phone.getByLabel("Custom answer")).toHaveCSS("font-size", "16px");
  const actions = phone.locator(".interview-answer-actions");
  const positions = await actions.locator("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { middle: bounds.y + bounds.height / 2, height: bounds.height };
    }),
  );
  expect(positions).toHaveLength(2);
  expect(positions.every((position) => position.height >= 44)).toBe(true);
  const [pause, proceed] = positions;
  if (!pause || !proceed) throw new Error("Interview actions are missing");
  expect(Math.abs(pause.middle - proceed.middle)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: `${evidenceDirectory}/interview-free-text-phone.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  const submitted = await captureAnswer(page);
  await next.click();
  await expect.poll(submitted).toEqual({
    ticketId: ticketID,
    questionEntryId: questionID,
    answer: { selectedOptionIds: [], customText: "No deployment changes." },
  });
});

test("minimize and pause preserve the exact answer; Wiki chat never retargets the Ticket", async ({
  page,
}) => {
  await insertQuestion({
    type: "free-text",
    prompt: "What outcome matters?",
    placeholder: "Describe the outcome",
  });
  const panel = await openTicketAgent(page);
  const answer = panel.getByLabel("Custom answer");
  await answer.fill("Keep this unfinished answer");
  await page.getByRole("button", { name: "Minimize Agent panel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue clarification", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue clarification", exact: true }).click();
  await expect(answer).toHaveValue("Keep this unfinished answer");
  await panel.getByRole("button", { name: "Pause clarification", exact: true }).click();
  await expect(panel.getByLabel("Message conversation")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue clarification", exact: true }),
  ).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await page.getByRole("region", { name: "requirements" }).locator(".ticket-card-body").click();
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(panel.getByLabel("Message conversation")).toBeVisible();
  await panel.getByRole("button", { name: "Continue clarification", exact: true }).click();
  await expect(answer).toHaveValue("Keep this unfinished answer");
  const submitted = await captureAnswer(page);
  await answer.press("Shift+Enter");
  await expect(answer).toHaveValue("Keep this unfinished answer\n");
  expect(submitted()).toBeUndefined();
  await answer.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    ),
  );
  expect(submitted()).toBeUndefined();
  await answer.press("Enter");
  await expect.poll(submitted).toMatchObject({ ticketId: ticketID, questionEntryId: questionID });
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(panel.locator(".conversation-question")).toHaveCount(0);
  await expect(panel.getByLabel("Message conversation")).toHaveAttribute(
    "placeholder",
    "Describe the change you want to plan…",
  );
  await page.getByRole("tab", { name: ticketTitle, exact: true }).click();
  await expect(answer).toHaveValue("Keep this unfinished answer");
});
