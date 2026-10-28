import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const directory = ".factory/test-results/inbox";
const cache = resolve(".factory/test-results/vite", `inbox-${crypto.randomUUID()}`);
let server: ViteDevServer, origin: string;
test.use({ contextOptions: { reducedMotion: "reduce" } });
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["inbox.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = fixtureValue(
    fixtureValue(server.resolvedUrls, "server.resolvedUrls").local[0],
    "server.resolvedUrls!.local[0]",
  ).replace(/\/$/, "");
  await mkdir(directory, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

async function clickInboxAction(page: Page, name: string) {
  const action = page.getByRole("button", { name, exact: true });
  await page.locator(".inbox-item").filter({ has: action }).hover();
  await action.click();
}

test("the compact Inbox keeps help and refresh discoverable without permanent instruction rows", async ({
  page,
}) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/inbox.html`);
    const inbox = page.getByRole("region", { name: "Personal Inbox" });
    const bounds = await inbox.boundingBox();
    const row = await inbox.getByRole("listitem").first().boundingBox();
    if (!bounds || !row) throw new Error("Inbox list is missing");
    expect(row.y - bounds.y).toBeLessThan(125);
    if (width === 1440) expect(row.height).toBeLessThan(105);
    await expect(inbox.getByRole("button", { name: "Refresh Inbox", exact: true })).toBeHidden();
    await inbox.getByLabel("Inbox options and shortcuts", { exact: true }).click();
    await expect(inbox.getByText("Reading does not complete it.", { exact: false })).toBeVisible();
    await expect(inbox.getByText("Next / previous item", { exact: true })).toBeVisible();
    await expect(inbox.getByRole("button", { name: "Refresh Inbox", exact: true })).toBeFocused();
    await page.screenshot({ path: `${directory}/options-${width}.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await expect(inbox.getByLabel("Inbox options and shortcuts", { exact: true })).toBeFocused();
    await expect(inbox.getByRole("button", { name: "Refresh Inbox", exact: true })).toBeHidden();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  }
});

test("Inbox keyboard processing stays inside the list and cannot dismiss requests", async ({
  page,
}) => {
  await page.goto(`${origin}/inbox.html?queue-flow&interview=free-text`);
  const requests = page.locator(".inbox-open");
  await requests.first().focus();
  await page.keyboard.press("e");
  await page.keyboard.press("u");
  await expect(requests).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
  ).toBeVisible();
  await page.keyboard.press("j");
  await expect(requests.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(requests.first()).toBeFocused();
  await page.keyboard.press("Enter");
  const source = page.getByRole("region", { name: "Exact Ticket source" });
  await expect(source).toBeFocused();
  const answer = source.getByLabel("Custom answer");
  await answer.fill("j k e u are ordinary text");
  await expect(answer).toHaveValue("j k e u are ordinary text");
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: "Back to Inbox", exact: true }).click();
  await expect(requests.first()).toBeFocused();
  await page.getByRole("button", { name: "Activity 3 unread", exact: true }).click();
  const rows = page.locator(".inbox-item");
  await rows.first().locator(".inbox-open").focus();
  await page.keyboard.press("u");
  await expect(rows.first()).toHaveAttribute("data-unread", "false");
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("u");
  await expect(rows.first()).toHaveAttribute("data-unread", "true");
  await page.keyboard.press("e");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".inbox-open")).toBeFocused();
});

test("source navigation restores section, Project, focus and scroll after the Inbox remounts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/inbox.html?queue-flow&many`);
  const inbox = page.getByRole("region", { name: "Personal Inbox" });
  await inbox.getByRole("button", { name: "Activity 39 unread", exact: true }).click();
  const projectID = "10000000-0000-4000-8000-000000000010";
  await inbox.getByLabel("Filter Inbox by Project").selectOption(projectID);
  const rows = inbox.locator(".inbox-item");
  await expect(rows).toHaveCount(26);
  const chosen = rows.nth(12);
  const chosenID = await chosen.getAttribute("data-inbox-id");
  const nextID = await rows.nth(13).getAttribute("data-inbox-id");
  await chosen.locator(".inbox-open").focus();
  const top = await inbox.locator(".inbox-items").evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await chosen.locator(".inbox-open").press("Enter");
  await expect(inbox).toHaveCount(0);
  const source = page.getByRole("region", { name: "Exact Ticket source" });
  await expect(source).toBeFocused();
  await source.getByRole("button", { name: "Back to Inbox", exact: true }).click();
  await expect(inbox.getByLabel("Filter Inbox by Project")).toHaveValue(projectID);
  await expect(inbox.locator(".inbox-sections .is-current")).toHaveText("Activity 25 unread");
  await expect(inbox.locator(`[data-inbox-id="${chosenID}"] .inbox-open`)).toBeFocused();
  expect(await inbox.locator(".inbox-items").evaluate((element) => element.scrollTop)).toBeCloseTo(
    top,
    0,
  );
  await inbox.locator(`[data-inbox-id="${chosenID}"] .inbox-open`).press("Enter");
  await source.getByRole("button", { name: "Next item", exact: true }).click();
  await source.getByRole("button", { name: "Back to Inbox", exact: true }).click();
  await expect(inbox.locator(`[data-inbox-id="${nextID}"] .inbox-open`)).toBeFocused();
  await expect(rows).toHaveCount(26);
  await page.screenshot({ path: `${directory}/queue-return-390.png`, fullPage: true });
});

test("returning after source resolution focuses a surviving neighbour without resolving another request", async ({
  page,
}) => {
  await page.goto(`${origin}/inbox.html?queue-flow`);
  const rows = page.locator(".inbox-item");
  await rows.first().locator(".inbox-open").click();
  const source = page.getByRole("region", { name: "Exact Ticket source" });
  await expect(source.getByRole("button", { name: "Next item", exact: true })).toBeEnabled();
  await source.getByRole("button", { name: "Resolve source request", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".inbox-open")).toBeFocused();
  await rows.first().locator(".inbox-open").press("Enter");
  await expect(source.getByRole("button", { name: "Next item", exact: true })).toBeDisabled();
  await source.getByRole("button", { name: "Back to Inbox", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.goto(`${origin}/inbox.html?queue-flow&requests-only`);
  const filter = page.getByLabel("Filter Inbox by Project");
  await filter.selectOption("10000000-0000-4000-8000-000000000020");
  await rows.first().locator(".inbox-open").click();
  await source.getByRole("button", { name: "Resolve source request", exact: true }).click();
  await expect(filter).toHaveValue("10000000-0000-4000-8000-000000000020");
  await expect(
    page.getByRole("heading", { name: "No matching items in this Project." }),
  ).toBeVisible();
  await expect(page.locator(".inbox-sections .is-current")).toBeFocused();
  await page.getByRole("button", { name: "Show all Projects", exact: true }).click();
  await expect(rows).toHaveCount(1);
});

for (const width of [1440, 768, 390]) {
  test(`personal Inbox separates obligations and activity at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 960 });
    await page.goto(`${origin}/inbox.html`);
    const dock = page.getByRole("button", { name: "Inbox, 5 items need your attention" });
    await expect(dock).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Requests needing you" }).getByRole("listitem"),
    ).toHaveCount(2);
    await page.screenshot({ path: `${directory}/needs-you-${width}.png`, fullPage: true });
    await expect(
      page.getByRole("button", { name: /Mark (?:un)?read: Answer the Agent/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).click();
    await expect(page.getByRole("region", { name: "Exact Ticket source" })).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
    ).toBeVisible();
    await dock.click();
    await expect(page.locator('[data-inbox-id="synthetic:0"] .inbox-open')).toBeFocused();
    await expect(
      page.getByRole("list", { name: "Requests needing you" }).getByRole("listitem"),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Archive: Answer the Agent’s question" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Activity 3 unread", exact: true }).click();
    await expect(page.locator('.inbox-sections [aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.inbox-sections [aria-current="page"]')).toHaveText(
      "Activity 3 unread",
    );
    await expect(page.getByRole("button", { name: "Activity 3 unread", exact: true })).toHaveCSS(
      "font-weight",
      "600",
    );
    await expect(page.getByRole("button", { name: "Needs you 2", exact: true })).toHaveCSS(
      "font-weight",
      "400",
    );
    await page.mouse.move(5, 5);
    await expect(page.getByRole("button", { name: "Needs you 2", exact: true })).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(
      page.getByRole("list", { name: "Inbox activity" }).getByRole("listitem"),
    ).toHaveCount(3);
    await expect(page.getByText("4 updates")).toBeVisible();
    await page.screenshot({ path: `${directory}/activity-${width}.png`, fullPage: true });
    await page
      .getByLabel("Filter Inbox by Project")
      .selectOption("10000000-0000-4000-8000-000000000020");
    await expect(
      page.getByRole("button", { name: "Activity 1 unread", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Inbox activity" }).getByRole("listitem"),
    ).toHaveCount(1);
    // Filtering the list never changes the global dock total.
    await expect(
      page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
    ).toBeVisible();
    await clickInboxAction(page, "Archive: You were mentioned in review");
    await expect(
      page.getByRole("button", { name: "Inbox, 4 items need your attention" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Archived", exact: true }).click();
    await expect(page.locator('.inbox-sections [aria-current="page"]')).toHaveText("Archived");
    await expect(
      page.getByRole("list", { name: "Inbox activity" }).getByRole("listitem"),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Move to Activity: You were mentioned in review" }),
    ).toBeVisible();
    await clickInboxAction(page, "Move to Activity: You were mentioned in review");
    await expect(
      page.getByText("No matching items in this Project.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Activity 0 unread", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "Inbox activity" }).getByRole("listitem"),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Mark unread: You were mentioned in review" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

test("activity actions stay quiet until hover or keyboard focus and never open the source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${origin}/inbox.html`);
  await page.getByRole("button", { name: "Activity 3 unread", exact: true }).click();
  const row = page.locator(".inbox-item").first();
  const actions = row.getByRole("group");
  const read = row.getByRole("button", { name: "Mark read: You were mentioned in review" });
  await page.mouse.move(1300, 50);
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(read).toHaveText("");
  await expect(read.locator("svg")).toHaveCount(1);
  await row.locator(".inbox-open").focus();
  await page.keyboard.press("Tab");
  await expect(read).toBeFocused();
  await expect
    .poll(() => read.evaluate((button) => getComputedStyle(button, "::after").opacity))
    .toBe("1");
  await page.screenshot({ path: `${directory}/activity-actions-focus-1440.png`, fullPage: true });
  await read.press("Enter");
  await expect(row).toHaveAttribute("data-unread", "false");
  await expect(page.getByRole("button", { name: "Activity 2 unread", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inbox, 4 items need your attention" }),
  ).toBeVisible();
  const unread = row.getByRole("button", { name: "Mark unread: You were mentioned in review" });
  await expect(unread).toBeFocused();
  await unread.press("Enter");
  await expect(row).toHaveAttribute("data-unread", "true");
  await expect(
    page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Exact Ticket source" })).toHaveCount(0);
});

test("archiving preserves keyboard position, including the final item, and can be reversed", async ({
  page,
}) => {
  await page.goto(`${origin}/inbox.html`);
  const activity = page.getByRole("button", { name: "Activity 3 unread", exact: true });
  await activity.click();
  const rows = page.getByRole("list", { name: "Inbox activity" }).getByRole("listitem");
  await rows.first().locator(".inbox-open").focus();
  await page.keyboard.press("Tab");
  await expect(rows.first().getByRole("button", { name: /Mark read:/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(rows.first().getByRole("button", { name: /Archive:/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".inbox-open")).toBeFocused();
  await expect(page.getByRole("status")).toHaveText("Activity archived.");
  for (const remaining of [1, 0]) {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(remaining);
    if (remaining) await expect(rows.first().locator(".inbox-open")).toBeFocused();
  }
  await expect(page.getByRole("button", { name: "Activity 0 unread", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "No activity yet.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await page.screenshot({ path: `${directory}/archived-1440.png`, fullPage: true });
  const restore = rows.first().getByRole("button", { name: /Move to Activity:/ });
  await restore.focus();
  await restore.press("Enter");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".inbox-open")).toBeFocused();
  await page.getByRole("button", { name: "Activity 0 unread", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-unread", "false");
  await expect(
    page.getByRole("button", { name: "Inbox, 2 items need your attention" }),
  ).toBeVisible();
});

test("a pending receipt keeps the item visible and prevents duplicate actions until confirmed", async ({
  page,
}) => {
  await page.goto(`${origin}/inbox.html?write-delay`);
  await page.getByRole("button", { name: "Activity 3 unread", exact: true }).click();
  const row = page.locator(".inbox-item").first();
  await row.hover();
  const archive = row.getByRole("button", { name: /Archive:/ });
  await archive.click();
  await expect(row).toHaveAttribute("aria-busy", "true");
  await expect(row.getByRole("status")).toHaveText("Saving…");
  await expect(
    page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
  ).toBeVisible();
  await expect(archive).toBeDisabled();
  await expect(
    page
      .locator(".inbox-item")
      .last()
      .getByRole("button", { name: /Archive:/ }),
  ).toBeDisabled();
  await expect(page.locator(".inbox-item")).toHaveCount(3);
  await page.screenshot({ path: `${directory}/saving-receipt-1440.png`, fullPage: true });
  await expect(page.locator(".inbox-item")).toHaveCount(2);
  await expect(page.getByRole("status")).toHaveText("Activity archived.");
  await expect(page.locator(".inbox-item").first().locator(".inbox-open")).toBeFocused();
});

test("a rejected receipt keeps unread activity and returns focus without a false success", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/inbox.html?write-throw`);
  await page.getByRole("button", { name: "Activity 3 unread", exact: true }).click();
  const read = page.getByRole("button", { name: "Mark read: You were mentioned in review" });
  await read.focus();
  await read.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Your change was not saved");
  await expect(read).toBeEnabled();
  await expect(read).toBeFocused();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
  ).toBeVisible();
  await page.getByRole("alert").getByRole("button", { name: "Refresh Inbox", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("touch actions are always discoverable, sized for touch, and separate from opening an update", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/inbox.html`);
    await page.getByRole("button", { name: "Activity 3 unread", exact: true }).tap();
    const row = page.locator(".inbox-item").first();
    await expect(row.getByRole("group")).toHaveCSS("opacity", "1");
    const read = row.getByRole("button", { name: /Mark read:/ });
    const bounds = await read.boundingBox();
    if (!bounds) throw new Error("Read action is not visible");
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `${directory}/activity-touch-390.png`, fullPage: true });
    await read.tap();
    await expect(
      page.getByRole("button", { name: "Inbox, 4 items need your attention" }),
    ).toBeVisible();
    await row.getByRole("button", { name: /Archive:/ }).tap();
    await expect(page.locator(".inbox-item")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Exact Ticket source" })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test("empty Project filters have a direct way back and stale refreshes retain the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${origin}/inbox.html?long-inbox`);
  await page
    .getByLabel("Filter Inbox by Project")
    .selectOption("10000000-0000-4000-8000-000000000020");
  await page.getByRole("button", { name: "Activity 1 unread", exact: true }).click();
  await clickInboxAction(page, "Archive: You were mentioned in review");
  await expect(
    page.getByRole("heading", { name: "No matching items in this Project." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show all Projects", exact: true }).click();
  await expect(page.getByLabel("Filter Inbox by Project")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Activity 2 unread", exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/long-activity-320.png`, fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.goto(`${origin}/inbox.html?refreshing`);
  await expect(
    page.getByRole("list", { name: "Requests needing you" }).getByRole("listitem"),
  ).toHaveCount(2);
  await page.getByLabel("Inbox options and shortcuts", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh Inbox", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Inbox options and shortcuts", { exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Refresh Inbox", exact: true })).toBeHidden();
  await expect(page.getByText("Loading your Inbox…", { exact: true })).toHaveCount(0);
});

test("responsibility is optional and mentions work in the real feedback composer with keyboard selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${origin}/inbox.html`);
  await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).click();
  const source = page.getByRole("region", { name: "Exact Ticket source" });
  await expect(source).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
  ).toBeVisible();
  await source.getByRole("button", { name: "Add person", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Assign responsibility" });
  const search = picker.getByRole("searchbox", { name: "Search Project members" });
  await expect(search).toBeFocused();
  await search.fill("  development Tom  ");
  await expect(picker.getByRole("button")).toHaveCount(1);
  await page.screenshot({ path: `${directory}/person-picker-1440.png`, fullPage: true });
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  const responsibility = source.getByRole("button", { name: "Responsible: Tom Development" });
  await expect(responsibility).toBeFocused();
  await expect(picker).toHaveCount(0);
  await source.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(source.getByRole("button", { name: "Following", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await source.getByRole("button", { name: "Add feedback", exact: true }).click();
  const comment = source.getByLabel("Review comment");
  await comment.fill("Keep this draft @");
  await expect(page.getByRole("listbox", { name: "Mention a Project member" })).toBeVisible();
  await comment.press("Shift+Tab");
  await expect(page.getByRole("listbox", { name: "Mention a Project member" })).toHaveCount(0);
  await expect(comment).toHaveValue("Keep this draft @");
  await expect(comment).not.toBeFocused();
  await comment.focus();
  await comment.fill("Please check @");
  const members = page.getByRole("listbox", { name: "Mention a Project member" });
  await expect(members.getByRole("option")).toHaveCount(2);
  await page.screenshot({ path: `${directory}/mention-picker-1440.png`, fullPage: true });
  await comment.press("ArrowDown");
  await comment.press("Enter");
  await expect(comment).toHaveValue(/Please check \[@Tom Development\]\(factory-person:/);
  await expect(members).toHaveCount(0);
  await source.getByRole("button", { name: "Save feedback", exact: true }).click();
  await expect(source.getByLabel("Saved feedback").locator(".factory-mention")).toHaveText(
    "@Tom Development",
  );
  await page.screenshot({ path: `${directory}/responsibility-and-mention.png`, fullPage: true });
});

test("the people picker supports changing, clearing, empty search and dismissal without assigning", async ({
  page,
}) => {
  await page.goto(`${origin}/inbox.html`);
  await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).click();
  const source = page.getByRole("region", { name: "Exact Ticket source" });
  const add = source.getByRole("button", { name: "Add person", exact: true });
  const picker = page.getByRole("dialog", { name: "Assign responsibility" });
  await add.click();
  await picker.getByRole("searchbox").fill("Nobody matches");
  await expect(picker.getByRole("status")).toHaveText("No matching Project members");
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await add.click();
  await expect(picker.getByRole("searchbox")).toHaveValue("");
  await picker.getByRole("button", { name: "Lisa Product", exact: true }).click();
  const assigned = source.getByRole("button", { name: "Responsible: Lisa Product" });
  await assigned.click();
  await expect(picker.getByRole("button", { name: "Lisa Product", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await picker.getByRole("button", { name: "Tom Development", exact: true }).click();
  await source.getByRole("button", { name: "Responsible: Tom Development" }).click();
  await picker.getByRole("button", { name: "Not assigned", exact: true }).click();
  await expect(add).toBeFocused();
  await add.click();
  await source.getByRole("heading").click();
  await expect(picker).toHaveCount(0);
  await add.click();
  await picker.getByRole("searchbox").press("Shift+Tab");
  await expect(picker).toHaveCount(0);
  expect(
    await page.evaluate(() => !!document.activeElement?.closest(".ticket-person-picker")),
  ).toBe(false);
});

for (const state of [
  "no-people",
  "long-person",
  "unavailable-person",
  "people-busy",
  "people-error",
]) {
  test(`the people picker handles ${state} without losing the saved assignment`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/inbox.html?${state}`);
    await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).click();
    const source = page.getByRole("region", { name: "Exact Ticket source" });
    const trigger = source.locator(".ticket-person-trigger");
    const picker = page.getByRole("dialog", { name: "Assign responsibility" });
    if (state === "people-busy") {
      await expect(trigger).toHaveAttribute("aria-disabled", "true");
      await trigger.focus();
      await trigger.press("Enter");
      await expect(picker).toHaveCount(0);
      await expect(source.getByRole("button", { name: "Follow", exact: true })).toBeDisabled();
    } else {
      await trigger.click();
      if (state === "no-people")
        await expect(picker.getByRole("status")).toHaveText("No Project members available");
      if (state === "long-person") {
        await expect(trigger).toHaveAccessibleName(/Responsible: Dr. Alexandra-Maria/);
        await expect(picker.getByRole("button", { name: /Dr. Alexandra-Maria/ })).toBeVisible();
        const controls = await source.locator(".ticket-people > button").evaluateAll((buttons) =>
          buttons.map((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.y + bounds.height / 2;
          }),
        );
        const [person, follow] = controls;
        if (person === undefined || follow === undefined)
          throw new Error("Ticket people controls are missing");
        expect(Math.abs(person - follow)).toBeLessThanOrEqual(1);
      }
      if (state === "unavailable-person") {
        await expect(trigger).toHaveAccessibleName("Responsible: Unavailable member");
        await picker.getByRole("button", { name: "Not assigned", exact: true }).click();
        await expect(trigger).toHaveAccessibleName("Add person");
      }
      if (state === "people-error") {
        await picker.getByRole("button", { name: "Lisa Product", exact: true }).click();
        await expect(source.getByRole("alert")).toContainText("Your change was not saved");
        await expect(trigger).toHaveAccessibleName("Add person");
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(
          picker.getByRole("button", { name: "Not assigned", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
      }
    }
    await page.screenshot({ path: `${directory}/${state}-390.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  });
}

test("assignment works by touch with a typed name and a viewport-contained picker", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/inbox.html`);
    await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).tap();
    const source = page.getByRole("region", { name: "Exact Ticket source" });
    await source.getByRole("button", { name: "Add person", exact: true }).tap();
    const picker = page.getByRole("dialog", { name: "Assign responsibility" });
    await picker.getByRole("searchbox").fill("Tom");
    const person = picker.getByRole("button", { name: "Tom Development", exact: true });
    await expect(picker).toHaveCSS("animation-name", "none");
    const bounds = await person.boundingBox();
    if (!bounds) throw new Error("Project member option is not visible");
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(picker.getByRole("searchbox")).toHaveCSS("font-size", "16px");
    await page.screenshot({ path: `${directory}/person-picker-touch-390.png`, fullPage: true });
    await person.tap();
    await expect(
      source.getByRole("button", { name: "Responsible: Tom Development" }),
    ).toBeVisible();
    await expect(picker).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const type of ["single-select", "multi-select", "free-text"]) {
  for (const width of [1440, 390]) {
    test(`the existing ${type} Interview retains a custom answer at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${origin}/inbox.html?interview=${type}`);
      await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).click();
      const question = page.locator(".conversation-question");
      const next = question.getByRole("button", { name: "Continue", exact: true });
      await expect(next).toBeDisabled();
      const kind = type === "multi-select" ? "checkbox" : "radio";
      if (type !== "free-text") {
        await expect(question.getByLabel("Custom answer")).toHaveCount(0);
        await question.getByRole(kind, { name: /Product/ }).check();
        await expect(next).toBeEnabled();
        if (type === "multi-select")
          await question.getByRole(kind, { name: /Development/ }).check();
        await question
          .getByRole(kind, {
            name: type === "single-select" ? "Something else" : "Add another answer",
            exact: true,
          })
          .check();
        if (type === "single-select") {
          await expect(question.getByRole("radio", { name: /Product/ })).not.toBeChecked();
          await expect(next).toBeDisabled();
        }
      } else {
        await expect(question.getByRole("radio")).toHaveCount(0);
        await expect(question.getByRole("checkbox")).toHaveCount(0);
      }
      await question.getByLabel("Custom answer").fill("Customer support");
      await page.reload();
      await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).click();
      await expect(question.getByLabel("Custom answer")).toHaveValue("Customer support");
      await expect(next).toBeEnabled();
      await page.screenshot({
        path: `${directory}/interview-${type}-${width}.png`,
        fullPage: true,
      });
      await next.click();
      await expect(page.getByLabel("Submitted Interview answer")).toContainText(
        '"customText":"Customer support"',
      );
      await expect(page.getByLabel("Submitted Interview answer")).toContainText(
        type === "multi-select"
          ? '"selectedOptionIds":["product","development"]'
          : '"selectedOptionIds":[]',
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
    });
  }
}

for (const state of ["empty", "loading", "error", "write-error", "overflow", "mention-error"]) {
  test(`Inbox handles ${state} without hiding requests or losing input`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/inbox.html?${state}`);
    if (state === "empty")
      await expect(page.getByText("No decisions need your attention.")).toBeVisible();
    if (state === "loading") {
      await expect(page.getByRole("status")).toContainText("Loading your Inbox");
      await expect(page.getByRole("list", { name: "Requests needing you" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Needs you …", exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Activity … unread", exact: true }),
      ).toBeVisible();
    }
    if (state === "error") {
      await expect(page.getByRole("alert")).toContainText("could not be refreshed");
      await page.screenshot({ path: `${directory}/error-390.png`, fullPage: true });
      await page.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    if (state === "write-error") {
      await page.getByRole("button", { name: "Activity 3 unread", exact: true }).click();
      await clickInboxAction(page, "Mark read: You were mentioned in review");
      await expect(page.getByRole("alert")).toContainText("not saved");
      await expect(
        page.getByRole("button", { name: "Inbox, 5 items need your attention" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Refresh Inbox", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Mark read: You were mentioned in review" }),
      ).toBeVisible();
      await clickInboxAction(page, "Mark read: You were mentioned in review");
    }
    if (state === "overflow") {
      await expect(page.locator(".inbox-count")).toHaveText("99+");
      await expect(
        page.getByRole("button", { name: "Inbox, 112 items need your attention" }),
      ).toBeVisible();
    }
    if (state === "mention-error") {
      await page.getByRole("button", { name: /Billing.*Answer the Agent/ }).click();
      await page.getByRole("button", { name: "Add feedback", exact: true }).click();
      const comment = page.getByLabel("Review comment");
      await comment.fill("My retained draft @");
      await expect(page.getByRole("alert")).toContainText("members could not be loaded");
      await expect(comment).toHaveValue("My retained draft @");
      await page.screenshot({ path: `${directory}/mention-error-390.png`, fullPage: true });
      await comment.press("Escape");
      await expect(comment).toBeVisible();
    }
    await page.screenshot({
      path: `${directory}/${state}${state === "error" || state === "mention-error" ? "-recovered" : ""}-390.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  });
}
