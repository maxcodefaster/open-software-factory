import { mkdir } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserBootstrap, mockFactoryFunctions } from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

const evidence = ".factory/test-results/board-efficiency";
test.setTimeout(120_000);
let database: ReturnType<typeof createDatabase>;
let projectID = "";
let editorStarts = 0;

test.beforeEach(async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  editorStarts = 0;
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Owned efficiency proof has no runtime");
      },
      ensureEditor: async () => {
        editorStarts++;
        throw new CommandError("unavailable", "Owned efficiency proof has no runtime");
      },
    },
  });
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${`efficiency-${projectID}`},'Efficient board',
      'https://example.invalid/efficiency.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
  await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
    VALUES(${crypto.randomUUID()},${projectID},'Explore the onboarding flow','A first Idea.','inbox',${session.user.id}),
      (${crypto.randomUUID()},${projectID},'Make navigation easier to scan','Fewer, clearer stops.','ready',${session.user.id}),
      (${crypto.randomUUID()},${projectID},'Retain my requirements','A settled checklist.','ready',${session.user.id})`;
});

test.afterEach(async () => {
  if (projectID) await deleteFactoryProject(projectID, database);
  await database?.client.end();
  projectID = "";
});

async function openBoard(page: Page) {
  await openProjectMenu(page);
  await page
    .getByRole("button")
    .filter({ hasText: `efficiency-${projectID}` })
    .click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await expect(page.locator(".ticket-card-body")).toHaveCount(3);
}

// A deep link opens the board with no pointer or keyboard input, so the first Tab stop and
// the editor warm-up timing are the ones a person gets on arrival.
async function arriveAtBoard(page: Page) {
  await page.goto(`/projects/${projectID}`);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await expect(page.locator(".ticket-card-body")).toHaveCount(3);
}

test("opening a Ticket asks the server for each identical read once while it is in flight", async ({
  page,
}) => {
  await openBoard(page);
  await page.waitForTimeout(1000);
  const calls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/_server/"))
      calls.push(`${url.pathname.split("/").at(-1)?.slice(0, 8)} ${request.postData() ?? ""}`);
  });
  await page.locator(".ticket-card-body").filter({ hasText: "Retain my requirements" }).click();
  await expect(page.getByRole("textbox", { name: "Ticket title" })).toBeVisible();
  await page.waitForTimeout(4000);
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call, (counts.get(call) ?? 0) + 1);
  const report = [...counts].sort((a, b) => b[1] - a[1]).map(([call, count]) => `${count} ${call}`);
  console.info(`Ticket open made ${calls.length} server calls\n${report.join("\n")}`);
  expect(calls.length).toBeLessThanOrEqual(12);
  expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(2);
});

test("Tab starts at Skip to board and then visits every Ticket card", async ({ page }) => {
  await arriveAtBoard(page);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("button", { name: "Skip to board", exact: true });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  const cards = page.locator(".ticket-card-body");
  await expect(cards.first()).toBeFocused();
  const visited = [await cards.first().innerText()];
  for (let index = 0; index < 8 && visited.length < 3; index++) {
    await page.keyboard.press("Tab");
    const focused = page.locator(".ticket-card-body:focus");
    if (await focused.count()) visited.push(await focused.innerText());
  }
  expect(visited).toHaveLength(3);
  expect(new Set(visited).size).toBe(3);
});

test("Skip to board stays out of sight until focused and leaves the layout alone", async ({
  page,
}) => {
  await arriveAtBoard(page);
  const skip = page.getByRole("button", { name: "Skip to board", exact: true });
  const hidden = await skip.boundingBox();
  expect(hidden && hidden.y + hidden.height <= 0).toBe(true);
  const topbar = await page.locator(".factory-topbar").boundingBox();
  await page.keyboard.press("Tab");
  await expect(skip).toBeInViewport();
  expect(await page.locator(".factory-topbar").boundingBox()).toEqual(topbar);
  await page.screenshot({ path: `${evidence}/skip-to-board.png` });
});

test("the Trash entry has its own icon rather than the Inbox icon", async ({ page }) => {
  await openBoard(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const trash = page.getByRole("button", { name: "Trash", exact: true });
  await expect(trash).toBeVisible();
  const paths = (locator: ReturnType<Page["locator"]>) =>
    locator.locator("svg path").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));
  const trashPaths = await paths(trash);
  const inbox = page
    .getByRole("navigation", { name: "Workspace dock" })
    .getByRole("button", { name: /^Inbox/ });
  expect(trashPaths.length).toBeGreaterThan(0);
  expect(trashPaths).not.toEqual(await paths(inbox));
  expect(trashPaths[0]).toContain("M4 6h16");
});

test.describe("editor warm-up on a wide pointer window", () => {
  test("waits for the first interaction after idle, not for page load", async ({ page }) => {
    await arriveAtBoard(page);
    await page.waitForTimeout(1000);
    expect(editorStarts).toBe(0);
    await page.keyboard.press("Shift");
    await expect.poll(() => editorStarts, { timeout: 3000 }).toBeGreaterThan(0);
  });

  test("starts on its own after four idle seconds", async ({ page }) => {
    await arriveAtBoard(page);
    await page.waitForTimeout(1000);
    expect(editorStarts).toBe(0);
    await expect.poll(() => editorStarts, { timeout: 12_000 }).toBeGreaterThan(0);
  });
});

test.describe("editor warm-up on a touch window", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("never starts until the IDE is opened", async ({ page }) => {
    await arriveAtBoard(page);
    await page.touchscreen.tap(200, 500);
    await page.waitForTimeout(7000);
    expect(editorStarts).toBe(0);
    await page
      .getByRole("navigation", { name: "Workspace dock" })
      .getByRole("button", { name: "IDE", exact: true })
      .tap();
    await expect.poll(() => editorStarts, { timeout: 8000 }).toBeGreaterThan(0);
    // The IDE chunk loads on demand here and must not blank the window while it arrives.
    await expect(page.getByRole("region", { name: "ide workspace" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Workspace dock" })).toBeVisible();
  });
});
