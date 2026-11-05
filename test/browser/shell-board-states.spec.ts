import { expect } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserBootstrap } from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test.setTimeout(120_000);

let database: ReturnType<typeof createDatabase>;
let userID = "";
const projects: string[] = [];

async function addProject(name: string, slug: string) {
  const id = crypto.randomUUID();
  projects.push(id);
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
    VALUES(${id},${`${slug}-${id.slice(0, 8)}`},${name},'https://example.invalid/shell.git','main','.devcontainer/devcontainer.json',${userID},'the-harvesters')`;
  return id;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  userID = (await browserBootstrap(page)).session.user.id;
  database = createDatabase(1);
});

test.afterEach(async () => {
  for (const id of projects.splice(0)) await deleteFactoryProject(id, database);
  await database?.client.end();
});

test("workspace tabs keep their actions outside the tablist and unavailable links leave no blank window", async ({
  page,
}) => {
  const id = await addProject("Tabs project", "shell-tabs");
  await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
    VALUES(${crypto.randomUUID()},${id},'First shell ticket','ready',${userID})`;
  await page.goto(`/projects/${id}`);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Open workspace views" });
  await expect(tabs.getByRole("tab", { name: "Knowledge", exact: true })).toBeVisible();
  await expect(tabs.locator("button:not([role='tab']), a")).toHaveCount(0);
  const close = page.getByRole("button", { name: "Close Knowledge", exact: true });
  const tab = tabs.getByRole("tab", { name: "Knowledge", exact: true });
  await expect
    .poll(async () => {
      const [tabBox, closeBox] = [await tab.boundingBox(), await close.boundingBox()];
      return (
        (closeBox?.x ?? 0) >= (tabBox?.x ?? 0) + (tabBox?.width ?? 0) - 1 &&
        Math.abs((closeBox?.y ?? 0) - (tabBox?.y ?? 0)) < 12
      );
    })
    .toBe(true);
  await close.click();
  await expect(page.locator(".workspace-window")).toBeHidden();

  await page.goto(`/projects/${id}/tickets/${crypto.randomUUID()}`);
  await expect(
    page.getByText("This link is unavailable. You may not have access, or the item was removed.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator(".workspace-window")).toBeHidden();
});

test("Project search keeps arrow keys on results and explains an empty search", async ({
  page,
}) => {
  const ids: string[] = [];
  for (let index = 0; index < 7; index++)
    ids.push(await addProject(`Shell Project ${index + 1}`, `shell-search-${index}`));
  await page.goto(`/projects/${ids[0]}`);
  await openProjectMenu(page);
  const search = page.getByRole("searchbox", { name: "Search projects" });
  await expect(search).toBeFocused();
  await search.fill("Project 3");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: /Shell Project 3/ })).toBeFocused();
  await search.fill("zzz-nothing");
  await expect(
    page.getByRole("status").filter({ hasText: 'No Project matches "zzz-nothing".' }),
  ).toBeVisible();
});

test("an empty Project explains how to add the first Ticket and the Inbox badge is singular", async ({
  page,
}) => {
  const id = await addProject("Empty board project", "shell-empty");
  const ticketID = crypto.randomUUID();
  const conversationID = crypto.randomUUID();
  await page.goto(`/projects/${id}`);
  await expect(
    page.getByText("No Tickets yet. Choose New ticket to write the first one."),
  ).toBeVisible();
  await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
    VALUES(${ticketID},${id},'Question ticket','ready',${userID})`;
  await expect(page.getByText("No Tickets yet.")).toHaveCount(0);
  await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
    VALUES(${conversationID},${id},${ticketID},'plan',${userID})`;
  await database.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
    VALUES(${crypto.randomUUID()},${conversationID},1,'question','project-agent','plan','Which flow?',
      '{"question":{"type":"free-text","prompt":"Which flow?","placeholder":"Answer"}}'::jsonb)`;
  await expect(
    page.getByRole("button", { name: "Inbox, 1 item needs your attention", exact: true }),
  ).toBeVisible();
});

test("the sign-in failure stays inside a short phone viewport", async ({ page }) => {
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 520 });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("nobody@factory.local");
  await page.getByLabel("Password", { exact: true }).fill("not-the-right-password-1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toBeInViewport();
});

test("a lasting notice moves the window below it instead of covering the tab bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await addProject("Notice project", "shell-notice");
  await page.goto(`/projects/${id}/wiki/${crypto.randomUUID()}`);
  const notice = page.getByRole("alert").filter({ hasText: "This link is unavailable." });
  await expect(notice).toBeVisible();
  const window = page.locator(".workspace-window");
  await expect(window).toBeVisible();
  const [noticeBox, windowBox] = [await notice.boundingBox(), await window.boundingBox()];
  expect((windowBox?.y ?? 0) + 1).toBeGreaterThanOrEqual(
    (noticeBox?.y ?? 0) + (noticeBox?.height ?? 0),
  );
});

test("the active tab keeps its close action visible when tabs overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await addProject("Overflow project", "shell-overflow");
  for (let index = 0; index < 4; index++)
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${crypto.randomUUID()},${id},${`Overflowing tab title number ${index}`},'ready',${userID})`;
  await page.goto(`/projects/${id}`);
  for (let index = 0; index < 4; index++) {
    await page.locator(".ticket-card-body").nth(index).click();
    await page.getByRole("button", { name: "Minimize workspace" }).click();
  }
  await page.getByRole("button", { name: /^Ticket/ }).click();
  const active = page.locator(".workspace-tab-actions.active .workspace-tab-close");
  await expect(active).toBeInViewport({ ratio: 1 });
  const scroller = await page.locator(".workspace-tabs").boundingBox();
  const close = await active.boundingBox();
  expect((close?.x ?? 0) + (close?.width ?? 0)).toBeLessThanOrEqual(
    (scroller?.x ?? 0) + (scroller?.width ?? 0) + 1,
  );
});

for (const touch of [false, true]) {
  test.describe(touch ? "touch" : "narrow", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: touch, isMobile: touch });
    test("an error toast sits above the window and never covers its tab strip", async ({
      page,
    }) => {
      const id = await addProject("Toast project", "shell-toast");
      await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by,trashed_at,trashed_by)
        VALUES(${crypto.randomUUID()},${id},'Removed shell ticket','ready',${userID},now(),${userID})`;
      await page.goto(`/projects/${id}`);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /^Trash/ }).click();
      await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
      await page.route("**/_server/**", (route) =>
        route.request().method() === "POST" ? route.abort() : route.continue(),
      );
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      const toast = page.locator(".error-toast, .desktop-notices .sync-notice").first();
      await expect(toast).toBeVisible();
      const strip = page.locator(".workspace-tabbar");
      await expect(strip).toBeVisible();
      const minimize = page.getByRole("button", { name: "Minimize workspace" });
      // The window moves once the notice has been measured, so wait for the settled layout.
      await expect
        .poll(async () => {
          const [toastBox, stripBox, minimizeBox] = [
            await toast.boundingBox(),
            await strip.boundingBox(),
            await minimize.boundingBox(),
          ];
          const bottom = (toastBox?.y ?? 0) + (toastBox?.height ?? 0);
          return bottom <= (stripBox?.y ?? 0) + 1 && bottom <= (minimizeBox?.y ?? 0);
        })
        .toBe(true);
    });
  });
}

test("Create project is the only Project entry and opens setup, not a connect dialog", async ({
  page,
}) => {
  await addProject("Entry project", "shell-entry");
  await openProjectMenu(page);
  await expect(page.getByRole("button", { name: "Add project" })).toHaveCount(0);
  await page.getByRole("button", { name: /^(Create project|Continue setup)$/ }).click();
  await expect(page.getByRole("dialog", { name: "Connect a repository" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /Project (setup|configuration)/ })).toBeVisible();
});

test.describe("touch dock", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("dock controls keep one row, 44px height, 24px minimum width and no overlap", async ({
    page,
  }) => {
    const id = await addProject("Dock project", "shell-dock");
    await page.goto(`/projects/${id}`);
    await expect(page.getByRole("button", { name: "Knowledge", exact: true })).toBeVisible();
    const boxes = await page
      .locator(".workspace-dock button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().toJSON() as DOMRect),
      );
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
    for (let index = 1; index < boxes.length; index++)
      expect(boxes[index]?.left ?? 0).toBeGreaterThanOrEqual((boxes[index - 1]?.right ?? 0) - 0.5);
  });
});

test("an empty Board is keyboard reachable because it scrolls sideways on phones", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await addProject("Empty scroll project", "shell-scroll");
  await page.goto(`/projects/${id}`);
  const board = page.getByRole("group", { name: "Ticket stages" });
  await expect(board).toHaveAttribute("tabindex", "0");
  await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
    VALUES(${crypto.randomUUID()},${id},'First scroll ticket','ready',${userID})`;
  await expect(board).toHaveCount(0);
  await expect(page.locator(".board")).not.toHaveAttribute("tabindex", /.*/);
});
