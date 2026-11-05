import { expect } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { test } from "../fixtures/browser-test";
import { browserBootstrap } from "../fixtures/server-functions";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test.setTimeout(120_000);

let database: ReturnType<typeof createDatabase>;
let projectID = "";

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const userID = (await browserBootstrap(page)).session.user.id;
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
    VALUES(${projectID},${`cross-${projectID.slice(0, 8)}`},'Cross cutting','https://example.invalid/cross.git','main','.devcontainer/devcontainer.json',${userID},'river-landscape')`;
  await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
    VALUES(${crypto.randomUUID()},${projectID},'Cross cutting ticket','ready',${userID})`;
});

test.afterEach(async () => {
  await deleteFactoryProject(projectID, database);
  await database?.client.end();
});

test("the tab title, icon and project selector name follow the open workspace", async ({
  page,
}) => {
  await page.goto(`/projects/${projectID}`);
  await expect(page).toHaveTitle("Cross cutting · Open Software Factory");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  expect((await page.request.get("/favicon.svg")).ok()).toBe(true);
  await page.goto(`/projects/${projectID}/settings`);
  await expect(page).toHaveTitle("Settings · Cross cutting · Open Software Factory");
  const selector = page.getByRole("button", { name: /open project menu$/i });
  await expect(selector).toHaveAccessibleName("Cross cutting, open project menu");
  await expect(page.getByRole("button", { name: /choose settings page$/i })).toHaveCount(0);
});

test("choosing a settings page with the keyboard keeps focus on that page", async ({ page }) => {
  await page.goto(`/projects/${projectID}/settings`);
  await page.waitForSelector(".settings-layout");
  const nav = page.locator(".settings-navigation-groups");
  const releases = nav.getByRole("button", { name: "Releases", exact: true });
  await releases.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Releases", level: 2 })).toBeVisible();
  await expect(releases).toBeFocused();
});

test("the Settings menu starts on its first action", async ({ page }) => {
  await page.goto(`/projects/${projectID}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open settings", exact: true })).toBeFocused();
});

test("loading and sync notices do not shift the layout", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
      }[])
        if (!entry.hadRecentInput) w.__cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(`/projects/${projectID}/wiki`);
  await expect(page.locator(".workspace-window")).toBeVisible();
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(
    0.1,
  );
});

test("forced colors keep a visible focus outline", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto(`/projects/${projectID}`);
  const card = page.locator(".ticket-card-body").first();
  await card.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const outline = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
});

test("window tab actions are at least 24 px", async ({ page }) => {
  await page.goto(`/projects/${projectID}/settings`);
  const close = page.locator(".workspace-tab-close");
  await expect(close).toBeVisible();
  const size = () =>
    close.evaluate((element) => ({
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
    }));
  expect((await size()).width).toBeGreaterThanOrEqual(24);
  expect((await size()).height).toBeGreaterThanOrEqual(24);
});

test("a failed start explains itself in plain words", async ({ page }) => {
  await page.route("**/*", (route) =>
    ["fetch", "xhr"].includes(route.request().resourceType())
      ? route.abort("failed")
      : route.continue(),
  );
  await page.goto(`/projects/${projectID}`);
  await expect(page.getByRole("alert")).toContainText("could not reach the server");
  await expect(page.getByText(/failed to fetch/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry opening Factory" })).toBeVisible();
});
