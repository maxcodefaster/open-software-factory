import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { chooseConversation, startNewConversation } from "../fixtures/conversation-navigation";

const evidence = ".factory/test-results/chat-collaboration";
const cacheDirectory = resolve(
  ".factory/test-results/vite",
  `chat-collaboration-${crypto.randomUUID()}`,
);
let server: ViteDevServer;
let origin: string;
test.setTimeout(45_000);
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cacheDirectory,
    publicDir: resolve("apps/factory/public"),
    plugins: [solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cacheDirectory, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.route("**/writer/status", (route) =>
    route.fulfill({
      json: {
        state: "agent",
        epoch: 1,
        canWrite: false,
        yours: false,
        commandID: null,
        actor: {
          kind: "agent",
          user: { id: "10000000-0000-4000-8000-000000000004", name: "Anna" },
          delegated: false,
          workState: "running",
        },
        requester: null,
      },
    }),
  );
});

test("chat creation lives in history; the compact header and long menu stay keyboard-accessible", async ({
  browser,
}) => {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: touch,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await page.route("**/writer/status", (route) =>
        route.fulfill({
          json: {
            state: "human",
            epoch: 1,
            canWrite: true,
            yours: true,
            actor: null,
            requester: null,
          },
        }),
      );
      await page.goto(`${origin}/chat-collaboration.html?long`);
      const header = page.getByRole("region", { name: "Ticket conversations", exact: true });
      const title = header.getByRole("button", { name: "Conversation", exact: true });
      const menu = page.getByRole("menu", { name: "Conversation history", exact: true });
      const create = menu.getByRole("menuitem", { name: "New chat", exact: true });
      const minimize = header.getByRole("button", { name: "Minimize Agent panel" });
      for (const width of [1440, 760, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        await expect(header).toBeVisible();
        await expect(create).toBeHidden();
        await expect(header.locator(".conversation-switcher-row button")).toHaveCount(2);
        const bounds = await title.boundingBox();
        const close = await minimize.boundingBox();
        if (!bounds || !close) throw new Error("Chat header controls are missing");
        expect(Math.abs(bounds.y - close.y)).toBeLessThanOrEqual(6);
        expect(close.x + close.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(
          0,
        );
        if (touch) {
          expect(bounds.height).toBeGreaterThanOrEqual(44);
          for (const control of await page
            .locator(
              ".agent-activity-heading:visible, .activity-group-toggle:visible, .agent-message-actions .copy-feedback:visible",
            )
            .all())
            await expect(control).toHaveCSS("min-height", "44px");
          await title.tap();
        } else {
          await title.focus();
          await title.press("ArrowDown");
        }
        await expect(create).toBeVisible();
        await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
        await page.keyboard.press("Home");
        await expect(create).toBeFocused();
        await expect(create).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("ArrowDown");
        await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
        await expect
          .poll(() => menu.evaluate((node) => node.getBoundingClientRect().right))
          .toBeLessThanOrEqual(width);
        const menuBounds = await menu.boundingBox();
        if (!menuBounds) throw new Error("Conversation history is missing");
        expect(menuBounds.x).toBeGreaterThanOrEqual(0);
        expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width);
        expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(844);
        expect(Math.abs(menuBounds.y - bounds.y - bounds.height - 8)).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: `${evidence}/history-${width}-${touch ? "touch" : "pointer"}.png`,
        });
        await page.keyboard.press("End");
        await expect(menu.getByRole("menuitem", { name: "Ask about this Project" })).toBeFocused();
        await page.keyboard.press("ArrowUp");
        const last = menu.getByRole("menuitemradio").last();
        await expect(last).toBeFocused();
        await expect(last).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("Escape");
        await expect(title).toBeFocused();
        await expect(menu).toBeHidden();
        await expect(page.getByText("Opened activity: none · Fresh contexts: 0")).toBeAttached();
        await page.screenshot({
          path: `${evidence}/header-${width}-${touch ? "touch" : "pointer"}.png`,
        });
      }
    } finally {
      await context.close();
    }
  }
});

test("Skill selection is keyboard accessible and edits a draft without sending or enabling guidance", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/skills/invocations?role=build", (route) => {
    reads++;
    return route.fulfill({
      json: {
        skills: [
          {
            id: "10000000-0000-4000-8000-000000000002",
            key: "review-ui",
            name: "Review the interface",
            description: "Inspect the current interface and its accessibility.",
          },
        ],
        conflicts: [],
      },
    });
  });
  await page.goto(`${origin}/chat-collaboration.html`);
  await expect(page.getByText("Agent working · requested by Anna", { exact: true })).toBeVisible();
  const draft = page.getByRole("textbox", { name: "Message draft", exact: true });
  await draft.fill("Keep this draft /");
  await draft.press("End");
  await expect(page.getByRole("button", { name: "Choose a Skill for this message" })).toHaveCount(
    0,
  );
  const option = page.getByRole("option", { name: /Review the interface/ });
  await expect(option).toBeVisible();
  await expect(draft).toBeFocused();
  await draft.press("ArrowDown");
  await draft.press("Enter");
  await expect(draft).toHaveValue("Keep this draft /review-ui ");
  await expect(draft).toBeFocused();
  await expect(page.getByText("Messages sent: 0", { exact: true })).toBeAttached();
  expect(reads).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await draft.press("/");
  await expect(option).toBeVisible();
  const box = await option.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${evidence}/skills-narrow.png`, fullPage: true });
  await page.keyboard.press("Escape");
  await expect(option).not.toBeVisible();
  await expect(draft).toBeFocused();
});

test("slash suggestions filter at the caret and an unknown command does not send", async ({
  page,
}) => {
  await page.route("**/skills/invocations?role=build", (route) =>
    route.fulfill({
      json: {
        skills: [
          {
            id: "10000000-0000-4000-8000-000000000002",
            key: "review-ui",
            name: "Review the interface",
            description: "Inspect the interface.",
          },
          {
            id: "10000000-0000-4000-8000-000000000005",
            key: "write-tests",
            name: "Write regression tests",
            description: "Cover the current behavior.",
          },
        ],
        conflicts: [],
      },
    }),
  );
  await page.goto(`${origin}/chat-collaboration.html`);
  const draft = page.getByRole("textbox", { name: "Message draft", exact: true });
  const suggestions = page.getByRole("listbox", { name: "Available Skills" });
  await draft.fill("/");
  const options = suggestions.getByRole("option");
  await expect(options).toHaveCount(2);
  await options.first().hover();
  await draft.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(options.first()).not.toHaveCSS(
    "background-color",
    await options.nth(1).evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await page.screenshot({ path: `${evidence}/slash-keyboard-selection.png`, fullPage: true });
  await draft.fill("Please /write");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(suggestions.getByRole("option")).toContainText("Write regression tests");
  await draft.press("Enter");
  await expect(draft).toHaveValue("Please /write-tests ");
  await draft.fill("Use /rev after this.");
  await draft.evaluate((element) => {
    (element as HTMLTextAreaElement).setSelectionRange(8, 8);
    element.dispatchEvent(new Event("select"));
  });
  await suggestions.getByRole("option", { name: /Review the interface/ }).click();
  await expect(draft).toHaveValue("Use /review-ui  after this.");
  await expect(draft).toBeFocused();
  await draft.fill("/unknown");
  await expect(page.getByText("No matching Skills.", { exact: true })).toBeVisible();
  await draft.press("Enter");
  await expect(page.getByText("Messages sent: 0", { exact: true })).toBeAttached();
  await draft.press("Tab");
  await expect(suggestions).not.toBeVisible();
});

test("human and Assistant messages copy their Markdown; tool calls have no copy action", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${origin}/chat-collaboration.html`);
  const human = page.getByRole("button", { name: "Copy user message", exact: true });
  await human.focus();
  await human.press("Enter");
  await expect(human).toHaveAttribute("data-feedback", "success");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Keep the **current layout**.",
  );
  const assistant = page.getByRole("button", { name: "Copy Assistant message", exact: true });
  await assistant.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "I will keep the layout and inspect the affected files.",
  );
  await expect(page.locator(".agent-activity .copy-feedback")).toHaveCount(0);
  await expect(page.locator(".copy-feedback")).toHaveCount(2);
});

test("structured Assistant questions and proposals also copy without answering or starting work", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${origin}/chat-collaboration.html`);
  await page.getByRole("button", { name: "Show structured messages", exact: true }).click();
  await page
    .locator(".conversation-question")
    .getByRole("button", { name: "Copy Assistant message", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "A clarification\n\nWhich scope should change?",
  );
  await page
    .locator(".conversation-requirement")
    .getByRole("button", { name: "Copy Assistant message", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Review the **requirements**.",
  );
  await expect(page.getByText("Messages sent: 0")).toBeAttached();
});

test("grouping keeps active work and failures visible and preserves disclosure on reconnect", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/chat-collaboration.html`);
  const group = page.getByRole("region", { name: "Grouped tool activity" });
  const toggle = group.getByRole("button", { name: /1 file read · 2 commands/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByTitle("Read src/view.tsx", { exact: true })).not.toBeVisible();
  const command = group.locator("details").filter({ hasText: "Running view checks." });
  await command.locator("summary").click();
  await expect(command).toHaveAttribute("open", "");
  await expect(
    group.getByText("This is a shortened activity preview", { exact: false }),
  ).toBeVisible();
  await expect(group.locator("details.error")).toBeVisible();
  await page.getByRole("button", { name: "Complete command", exact: true }).click();
  await expect(command).toHaveAttribute("open", "");
  await expect(command).toBeVisible();
  await page.getByRole("button", { name: "Reconnect snapshot", exact: true }).click();
  await expect(command).toHaveAttribute("open", "");
  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(group.getByTitle("Read src/view.tsx", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/activities-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidence}/activities-narrow.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test("conversation selection is observational and a fresh Coding context needs a settled-work confirmation", async ({
  page,
}) => {
  await page.goto(`${origin}/chat-collaboration.html`);
  await chooseConversation(page, "10000000-0000-4000-8000-000000000008");
  await expect(page.getByText("Opened activity: none · Fresh contexts: 0")).toBeVisible();
  await page.getByRole("button", { name: "Toggle busy Coding", exact: true }).click();
  await startNewConversation(page);
  await expect(page.getByRole("button", { name: "Conversation", exact: true })).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Start fresh conversation", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Finish the current work or use Stop and wait for confirmation first."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Conversation", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Toggle busy Coding", exact: true }).click();
  await startNewConversation(page);
  await page.getByRole("button", { name: "Start fresh conversation", exact: true }).click();
  await expect(page.getByText("Opened activity: none · Fresh contexts: 1")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${evidence}/conversation-controls-narrow.png` });
});

test("recorded file and diff navigation happens only on a deliberate action", async ({ page }) => {
  await page.goto(`${origin}/chat-collaboration.html`);
  await expect(page.getByText("Opened activity: none · Fresh contexts: 0")).toBeVisible();
  await page.locator(".activity-group-toggle").click();
  await page.locator("details.agent-activity").first().locator("summary").click();
  await page.getByRole("button", { name: "Open file in IDE", exact: true }).click();
  await expect(
    page.getByText("Opened activity: file src/view.tsx · Fresh contexts: 0"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open recorded diff", exact: true }).click();
  await expect(
    page.getByText("Opened activity: diff src/view.tsx · Fresh contexts: 0"),
  ).toBeVisible();
});

test("a human editing request is explicit and releasing editing warns about unsaved buffers", async ({
  page,
}) => {
  let yours = false;
  let requests = 0;
  const current = () => ({
    state: "human",
    epoch: 3,
    canWrite: yours,
    yours,
    commandID: null,
    actor: {
      kind: "human",
      user: { id: "10000000-0000-4000-8000-000000000004", name: "Anna" },
      delegated: false,
      workState: null,
    },
    requester: null,
    presence: { idle: false, secondsSinceEdit: 4, connected: true },
    requests:
      requests && !yours
        ? [
            {
              id: "10000000-0000-4000-8000-000000000005",
              requester: { id: "10000000-0000-4000-8000-000000000006", name: "You" },
              epoch: 3,
            },
          ]
        : [],
  });
  await page.route("**/writer/status", (route) => route.fulfill({ json: current() }));
  await page.route("**/writer/request", async (route) => {
    expect(route.request().postDataJSON().epoch).toBe(3);
    requests++;
    await route.fulfill({ json: current() });
  });
  await page.route("**/writer/release", async (route) => {
    expect(route.request().postDataJSON().epoch).toBe(3);
    await route.fulfill({
      json: { ...current(), state: "unassigned", canWrite: false, yours: false, actor: null },
    });
  });
  await page.goto(`${origin}/chat-collaboration.html`);
  const writerActions = page.locator(".agent-writer-actions");
  await expect(writerActions).toHaveCSS("row-gap", "4px");
  await expect(writerActions).toHaveCSS("column-gap", "10px");
  await page.getByRole("button", { name: "Request editing", exact: true }).click();
  await expect(page.getByText("Editing requested", { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  yours = true;
  await expect(page.getByRole("button", { name: "Release editing", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Release editing", exact: true }).click();
  await expect(page.getByText("Save your files first.", { exact: false })).toBeVisible();
  const confirmation = page.locator(".agent-editing-confirmation");
  await expect(confirmation).toHaveCSS("margin-top", "8px");
  await expect(confirmation.locator("p")).toHaveCSS("margin-bottom", "8px");
  await page.screenshot({ path: `${evidence}/editing-release-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidence}/editing-release-narrow.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Editing is available", { exact: true })).toBeVisible();
});
