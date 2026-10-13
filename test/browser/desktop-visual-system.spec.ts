import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { deleteFactoryProject } from "../support/factory-fixture";
import { luminance } from "../support/visual-contrast";

const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
const password = process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password";
const userID = "01994a7d-0000-7000-8000-000000000001";
const evidenceDirectory = ".factory/screenshots/ui-polish/desktop-system";
const coreFlowEvidenceDirectory = evidenceDirectory;

let database: ReturnType<typeof createDatabase> | undefined;
let projectID = "";
let projectSlug = "";
type Preference = { key: string; updatedAt: string };
let originalPreference: Preference | undefined;
let fixturePreference: Preference | undefined;

async function readPreference() {
  if (!database) throw new Error("Database was not initialized");
  const [value] = await database.client<Preference[]>`
    SELECT desktop_background_key AS key, updated_at::text AS "updatedAt"
    FROM factory.user_ui_preference WHERE user_id = ${userID}
  `;
  return value;
}

async function selectBackground(page: Page, key: string, label: string) {
  if (!(await page.locator(".settings-menu").isVisible())) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/ui-preference") &&
        response.request().method() === "PUT" &&
        response.ok(),
    ),
    page.getByRole("button").filter({ hasText: label }).click(),
  ]);
  await expect(page.locator("main.factory-desktop")).toHaveAttribute("data-background", key);
  await expect.poll(async () => (await readPreference())?.key).toBe(key);
  fixturePreference = await readPreference();
  const colors = await page.locator("main.factory-desktop").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      accent: style.getPropertyValue("--color-river-deep").trim(),
      inverse: style.getPropertyValue("--color-ink-inverse").trim(),
      surface: style.getPropertyValue("--surface-rgb").trim(),
      muted: style.getPropertyValue("--color-ink-muted").trim(),
      alpha: Number(style.getPropertyValue("--material-window").match(/\/\s*([\d.]+)%/)?.[1]) / 100,
    };
  });
  const hex = (value: string) =>
    [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  expect(colors.accent).toBe(
    {
      "river-landscape": "#3f5e63",
      "the-harvesters": "#70552e",
      "mountainous-landscape": "#59596e",
    }[key],
  );
  expect(
    (luminance(hex(colors.inverse)) + 0.05) / (luminance(hex(colors.accent)) + 0.05),
  ).toBeGreaterThanOrEqual(4.5);
  // Conservatively composite the document's single frost over a completely black backdrop.
  const darkestSurface = colors.surface.split(" ").map((value) => Number(value) * colors.alpha);
  expect(
    (luminance(darkestSurface) + 0.05) / (luminance(hex(colors.muted)) + 0.05),
  ).toBeGreaterThanOrEqual(4.5);
}

async function restorePreference() {
  if (!database || !fixturePreference) return;
  await database.client.begin(async (transaction) => {
    const [current] = await transaction<Preference[]>`
      SELECT desktop_background_key AS key, updated_at::text AS "updatedAt"
      FROM factory.user_ui_preference WHERE user_id = ${userID} FOR UPDATE
    `;
    if (
      current?.key !== fixturePreference?.key ||
      current?.updatedAt !== fixturePreference?.updatedAt
    ) {
      throw new Error("UI preference changed outside the fixture; refusing to overwrite it");
    }
    if (originalPreference) {
      await transaction`
        UPDATE factory.user_ui_preference
        SET desktop_background_key = ${originalPreference.key},
          updated_at = ${originalPreference.updatedAt}::timestamptz
        WHERE user_id = ${userID}
      `;
    } else {
      await transaction`DELETE FROM factory.user_ui_preference WHERE user_id = ${userID}`;
    }
  });
  expect(await readPreference()).toEqual(originalPreference);
}

async function signIn(page: Page) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(coreFlowEvidenceDirectory, { recursive: true });
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  projectSlug = `visual-${projectID.slice(0, 8)}`;
  for (const endpoint of ["source-workspace", "developer-ide"]) {
    await page.route(`**/api/projects/${projectID}/${endpoint}/ensure`, (route) =>
      route.fulfill({ status: 503, json: { error: "Planning-only visual fixture" } }),
    );
  }
  originalPreference = await readPreference();
  fixturePreference = undefined;
  await database.client`
    INSERT INTO factory.project(
      id, slug, name, repository_url, default_branch, devcontainer_path, created_by
    ) VALUES (
      ${projectID}, ${projectSlug}, 'Renaissance workspace',
      'https://example.invalid/visual.git', 'main', '.devcontainer/devcontainer.json', ${userID}
    )
  `;
  await database.client`
    INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
    VALUES (
      ${crypto.randomUUID()}, ${projectID}, 'Refine the project atlas',
      'Keep the workspace calm while the implementation stays inspectable.', 'in-progress', ${userID}
    )
  `;
});

test.afterEach(async () => {
  try {
    await restorePreference();
  } finally {
    if (projectID) await deleteFactoryProject(projectID);
    await database?.client.end();
    database = undefined;
    projectID = "";
    projectSlug = "";
    originalPreference = undefined;
    fixturePreference = undefined;
  }
});

test("persists curated backgrounds and centers the active app around the Agent panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.locator(".signin")).toHaveAttribute("data-background", "river-landscape");
  await page.screenshot({ path: `${evidenceDirectory}/sign-in.png`, fullPage: true });

  await signIn(page);
  await selectBackground(page, "river-landscape", "River Landscape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dock = page.getByRole("navigation", { name: "Workspace dock" });
  await expect(dock.locator(".instance-count")).toHaveCount(0);
  await expect(
    dock.getByRole("button", { name: "Inbox", exact: true }).locator(".notification-dot"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Open project menu" }).click();
  await expect(page.locator(".popover-backdrop")).toBeVisible();
  const projectMenuPadding = await page
    .locator(".project-menu")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingTop));
  expect(projectMenuPadding).toBeLessThanOrEqual(10);
  const projectMenuHeight = await page
    .locator(".project-menu")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(projectMenuHeight).toBeLessThanOrEqual(545);
  const menuControlStyle = await page
    .getByRole("button", { name: "Create project", exact: true })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderWidth: Number.parseFloat(style.borderTopWidth),
        paddingInline: Number.parseFloat(style.paddingInlineStart),
      };
    });
  expect(menuControlStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(menuControlStyle.borderWidth).toBeGreaterThan(0);
  expect(menuControlStyle.paddingInline).toBeGreaterThan(0);
  await expect(page.getByRole("button").filter({ hasText: projectSlug })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Projects" })
      .getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${evidenceDirectory}/project-menu.png`, fullPage: true });
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  for (const lane of ["Ideas", "Requirements", "Implementation", "Review"]) {
    await expect(page.getByText(lane, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole("region", { name: "implementation" }).getByText("Refine the project atlas"),
  ).toBeVisible();
  await page.screenshot({
    path: `${coreFlowEvidenceDirectory}/four-stage-board.png`,
    fullPage: true,
  });
  await expect(page.locator("main.factory-desktop")).toHaveAttribute(
    "data-background",
    "river-landscape",
  );
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `${evidenceDirectory}/desktop-river-landscape.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const backdropStyle = await page.locator(".popover-backdrop").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    filter: getComputedStyle(element).backdropFilter,
  }));
  expect(backdropStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(backdropStyle.filter).toContain("blur");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${evidenceDirectory}/settings-menu.png`, fullPage: true });
  await page.locator(".popover-backdrop").click({ position: { x: 20, y: 200 } });
  await expect(page.locator(".settings-menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await selectBackground(page, "the-harvesters", "The Harvesters");
  await expect(page.locator("main.factory-desktop")).toHaveAttribute(
    "data-background",
    "the-harvesters",
  );
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `${evidenceDirectory}/desktop-the-harvesters.png`,
    fullPage: true,
  });

  await selectBackground(page, "mountainous-landscape", "A Mountainous Landscape");
  await expect(page.locator("main.factory-desktop")).toHaveAttribute(
    "data-background",
    "mountainous-landscape",
  );
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `${evidenceDirectory}/desktop-mountainous-landscape.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator("main.factory-desktop")).toHaveAttribute(
    "data-background",
    "mountainous-landscape",
  );

  if (!database) throw new Error("Database was not initialized");
  const stored = await database.client<Array<{ desktopBackgroundKey: string }>>`
    SELECT desktop_background_key AS "desktopBackgroundKey"
    FROM factory.user_ui_preference WHERE user_id = ${userID}
  `;
  expect(stored[0]?.desktopBackgroundKey).toBe("mountainous-landscape");
  const arbitraryURL = await page.context().request.put("/api/ui-preference", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: { desktopBackgroundKey: "https://example.invalid/painting.jpg" },
  });
  expect(arbitraryURL.status()).toBe(400);

  await page.getByRole("button", { name: "Inbox" }).click();
  await expect(page.locator(".inbox-workspace")).toBeVisible();
  const inboxWindow = await page.locator(".workspace-window").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      widthRatio: bounds.width / innerWidth,
      heightRatio: bounds.height / innerHeight,
    };
  });
  expect(inboxWindow.widthRatio).toBeGreaterThan(0.75);
  expect(inboxWindow.widthRatio).toBeLessThanOrEqual(0.82);
  expect(inboxWindow.heightRatio).toBeGreaterThan(0.8);
  expect(inboxWindow.heightRatio).toBeLessThan(0.95);
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${evidenceDirectory}/inbox.png`, fullPage: true });
  await page.getByRole("button", { name: "Minimize workspace" }).click();

  await page.getByRole("button", { name: "Open project menu" }).click();
  await page.locator(".popover-backdrop").click({ position: { x: 20, y: 200 } });
  await expect(page.getByRole("region", { name: "Projects" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open project menu" }).click();
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await page.getByRole("button", { name: "New Ticket" }).click();
  await expect(page.locator(".ticket-draft-workspace")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const primaryControlStyle = await page
    .locator(".ticket-draft-workspace")
    .getByRole("button", { name: "Elaborate requirements", exact: true })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderRadius: Number.parseFloat(style.borderRadius),
        paddingInline: Number.parseFloat(style.paddingInlineStart),
      };
    });
  expect(primaryControlStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(primaryControlStyle.borderRadius).toBeGreaterThan(0);
  expect(primaryControlStyle.paddingInline).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  const draftBounds = await page.locator(".ticket-draft-workspace").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: Math.round(bounds.left),
      top: Math.round(bounds.top),
      right: Math.round(bounds.right),
      bottom: Math.round(bounds.bottom),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  expect(draftBounds.left).toBeGreaterThanOrEqual(0);
  expect(draftBounds.top).toBeGreaterThan(0);
  expect(draftBounds.right).toBeLessThanOrEqual(draftBounds.viewportWidth);
  expect(draftBounds.bottom).toBeLessThanOrEqual(draftBounds.viewportHeight);
  await page.screenshot({ path: `${evidenceDirectory}/new-ticket-tab.png`, fullPage: true });
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button", { name: /Refine the project atlas/ })
    .click();
  const workspace = page.locator(".workspace-window");
  const ticketDockButton = page.getByRole("button", { name: "Ticket", exact: true });
  await expect(workspace).toBeVisible();
  const motion = await workspace.evaluate((element) => {
    const windowStyle = getComputedStyle(element);
    return {
      animationName: windowStyle.animationName,
      animationDuration: windowStyle.animationDuration,
    };
  });
  const dockTransitions = await ticketDockButton.evaluate(
    (element) => getComputedStyle(element).transitionProperty,
  );
  expect(motion.animationName).toBe("window-in");
  expect(Number.parseFloat(motion.animationDuration)).toBeGreaterThanOrEqual(0.18);
  expect(Number.parseFloat(motion.animationDuration)).toBeLessThanOrEqual(0.25);
  expect(dockTransitions).toContain("scale");
  expect(dockTransitions).toContain("translate");
  const windowAlpha = await workspace.evaluate((element) => {
    const match = getComputedStyle(element).backgroundColor.match(
      /rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([\d.]+))?\)/,
    );
    return match?.[1] ? Number.parseFloat(match[1]) : 1;
  });
  expect(windowAlpha).toBeGreaterThanOrEqual(0.65);
  expect(windowAlpha).toBeLessThanOrEqual(0.7);
  const integratedTabs = await workspace.evaluate((element) => {
    const windowBounds = element.getBoundingClientRect();
    const tabs = element.querySelector<HTMLElement>(".workspace-tabs");
    const firstTab = element.querySelector<HTMLElement>(".workspace-tab");
    const tabLabel = firstTab?.querySelector<HTMLElement>(".workspace-tab-label");
    if (!tabs || !firstTab || !tabLabel) return null;
    const tabsBounds = tabs.getBoundingClientRect();
    const tabBounds = firstTab.getBoundingClientRect();
    const style = getComputedStyle(tabs);
    return {
      topInset: tabsBounds.top - windowBounds.top,
      tabInset: tabBounds.top - tabsBounds.top,
      height: tabsBounds.height,
      gap: Number.parseFloat(style.columnGap),
      paddingTop: Number.parseFloat(style.paddingTop),
      tabRadius: getComputedStyle(firstTab).borderRadius,
      labelRadius: getComputedStyle(tabLabel).borderRadius,
    };
  });
  expect(integratedTabs).not.toBeNull();
  expect(integratedTabs?.topInset).toBeLessThanOrEqual(2);
  expect(integratedTabs?.tabInset).toBe(0);
  expect(integratedTabs?.height).toBeLessThanOrEqual(40);
  expect(integratedTabs?.gap).toBe(0);
  expect(integratedTabs?.paddingTop).toBe(0);
  expect(integratedTabs?.tabRadius).toBe("0px");
  expect(integratedTabs?.labelRadius).toBe("0px");
  await page.waitForTimeout(400);
  const closedPosition = await workspace.evaluate((element) => {
    const workspaceElement = element as HTMLElement;
    return {
      centerAnchor: workspaceElement.offsetLeft,
      desktopWidth: workspaceElement.offsetParent?.clientWidth ?? 0,
    };
  });
  expect(Math.abs(closedPosition.centerAnchor - closedPosition.desktopWidth / 2)).toBeLessThan(2);
  const closePosition = await page
    .getByRole("button", { name: "Minimize workspace" })
    .evaluate((element) => {
      const close = element.getBoundingClientRect();
      const window = element.closest(".workspace-window")?.getBoundingClientRect();
      return window ? window.right - close.right : Number.POSITIVE_INFINITY;
    });
  expect(closePosition).toBeLessThanOrEqual(16);
  await page.screenshot({ path: `${evidenceDirectory}/ticket-agent-closed.png`, fullPage: true });

  const workspaceTabs = page.getByRole("tablist", { name: "Open workspace views" });
  await page
    .getByRole("navigation", { name: "Workspace dock" })
    .getByRole("button", { name: "Inbox", exact: true })
    .click();
  await expect(workspaceTabs.getByRole("tab", { name: "Inbox", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  await expect(page.locator(".workspace-window")).toBeHidden();
  await expect(page.locator(".workspace-window")).toHaveCount(1);
  await ticketDockButton.click();
  await expect(workspaceTabs.getByRole("tab", { name: "Inbox", exact: true })).toBeVisible();
  await workspaceTabs.getByRole("button", { name: "Close Inbox" }).click();
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  await ticketDockButton.click();
  await expect(workspaceTabs.getByRole("tab", { name: "Inbox", exact: true })).toHaveCount(0);

  const agentToggle = page.getByRole("button", { name: "Toggle Agent panel" });
  await expect(agentToggle).toHaveAttribute("data-state", "closed");
  await agentToggle.click();
  await expect(agentToggle).toHaveAttribute("data-state", "open");
  await expect(agentToggle).not.toHaveClass(/active/);
  const agentPanel = page.getByRole("complementary", { name: "Agent panel" });
  await expect(agentPanel).toBeVisible();
  const agentHeight = await agentPanel.evaluate(
    (element) => element.getBoundingClientRect().height / innerHeight,
  );
  expect(agentHeight).toBeGreaterThan(0.75);
  expect(agentHeight).toBeLessThan(0.95);
  await expect(agentPanel.getByRole("navigation", { name: "Conversation mode" })).toHaveCount(0);
  const composerAlignment = await agentPanel.locator(".agent-input-shell").evaluate((element) => {
    const input = element.querySelector<HTMLElement>("textarea")?.getBoundingClientRect();
    const send = element
      .querySelector<HTMLElement>("[aria-label='Send message']")
      ?.getBoundingClientRect();
    const styles = getComputedStyle(document.documentElement);
    return {
      aligned: Boolean(input && send && Math.abs(input.bottom - send.bottom) <= 12),
      inputHeight: input?.height,
      tabHeightToken: styles.getPropertyValue("--workspace-tab-height").trim(),
      windowControlToken: styles.getPropertyValue("--window-control-size").trim(),
      windowControlInsetToken: styles.getPropertyValue("--window-control-inset").trim(),
    };
  });
  expect(composerAlignment.aligned).toBe(true);
  expect(composerAlignment.inputHeight).toBeLessThanOrEqual(40);
  expect(composerAlignment.tabHeightToken).toBe("38px");
  expect(composerAlignment.windowControlToken).toBe("28px");
  expect(composerAlignment.windowControlInsetToken).toBe("5px");
  const closeControlStyles = await page
    .locator(".window-minimize-control")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          width: style.width,
          height: style.height,
          radius: style.borderRadius,
          borderWidth: style.borderTopWidth,
        };
      }),
    );
  expect(closeControlStyles).toHaveLength(2);
  expect(closeControlStyles[0]).toEqual(closeControlStyles[1]);
  expect(Number.parseFloat(closeControlStyles[0]?.width ?? "0")).toBe(28);
  await page.waitForTimeout(400);
  const openPosition = await workspace.evaluate((element) => {
    const workspaceElement = element as HTMLElement;
    const panel = document.querySelector<HTMLElement>(".agent-panel");
    const desktopWidth = workspaceElement.offsetParent?.clientWidth ?? 0;
    const panelRight = (panel?.offsetLeft ?? 0) + (panel?.offsetWidth ?? 0);
    return {
      centerAnchor: workspaceElement.offsetLeft,
      availableCenter: panelRight + (desktopWidth - panelRight) / 2,
    };
  });
  expect(Math.abs(openPosition.centerAnchor - openPosition.availableCenter)).toBeLessThan(16);
  await page.screenshot({ path: `${evidenceDirectory}/ticket-agent-open.png`, fullPage: true });

  for (const [key, label] of [
    ["the-harvesters", "The Harvesters"],
    ["mountainous-landscape", "A Mountainous Landscape"],
    ["river-landscape", "River Landscape"],
  ] as const) {
    await selectBackground(page, key, label);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.screenshot({ path: `${evidenceDirectory}/ticket-${key}.png` });
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await selectBackground(page, "river-landscape", "River Landscape");
  await expect(page.locator("main.factory-desktop")).toHaveAttribute(
    "data-background",
    "river-landscape",
  );
});

test("keeps the desktop and active app usable at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto("/");
  await signIn(page);
  const topbarOverlaps = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const overlaps = (first?: DOMRect, second?: DOMRect) =>
      Boolean(
        first &&
          second &&
          first.left < second.right &&
          first.right > second.left &&
          first.top < second.bottom &&
          first.bottom > second.top,
      );
    return overlaps(rect(".context-button"), rect(".workspace-dock"));
  });
  expect(topbarOverlaps).toBe(false);

  await page.getByRole("button", { name: "Open project menu" }).click();
  const projectMenuLayout = await page.locator(".project-menu").evaluate((element) => {
    const menu = element.getBoundingClientRect();
    const dock = document.querySelector(".workspace-dock")?.getBoundingClientRect();
    return {
      withinViewport: menu.left >= 0 && menu.right <= innerWidth,
      overlapsDock: Boolean(
        dock &&
          menu.left < dock.right &&
          menu.right > dock.left &&
          menu.top < dock.bottom &&
          menu.bottom > dock.top,
      ),
      menuTop: menu.top,
      dockBottom: dock?.bottom ?? 0,
    };
  });
  expect(projectMenuLayout.withinViewport).toBe(true);
  expect(projectMenuLayout.menuTop).toBeGreaterThanOrEqual(projectMenuLayout.dockBottom);
  expect(projectMenuLayout.overlapsDock).toBe(false);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${evidenceDirectory}/narrow-project-menu.png`, fullPage: true });
  await page.getByRole("button").filter({ hasText: projectSlug }).click();

  const mobileBoard = await page.locator(".board").evaluate((element) => {
    const lane = element.querySelector(".lane")?.getBoundingClientRect();
    const board = element.getBoundingClientRect();
    return {
      snap: getComputedStyle(element).scrollSnapType,
      revealsNextLane: Boolean(lane && lane.width < board.width),
    };
  });
  expect(mobileBoard.snap).toContain("mandatory");
  expect(mobileBoard.revealsNextLane).toBe(true);
  await expect(page.getByText(/Swipe through 4 stages/)).toBeVisible();
  const reviewLane = page.getByRole("region", { name: "review" });
  await page.locator(".board").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(reviewLane).toBeInViewport();
  await page.locator(".board").evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page.screenshot({
    path: `${coreFlowEvidenceDirectory}/narrow-four-stage-board.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const mountainousTitleOverflows = await page
    .locator(".background-mountainous-landscape strong")
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(mountainousTitleOverflows).toBe(false);
  const settingsOverlap = await page.locator(".settings-menu").evaluate((element) => {
    const menu = element.getBoundingClientRect();
    const dock = document.querySelector(".workspace-dock")?.getBoundingClientRect();
    return Boolean(
      dock &&
        menu.left < dock.right &&
        menu.right > dock.left &&
        menu.top < dock.bottom &&
        menu.bottom > dock.top,
    );
  });
  expect(settingsOverlap).toBe(false);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${evidenceDirectory}/narrow-settings-menu.png`, fullPage: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button", { name: /Refine the project atlas/ })
    .click();
  await expect(page.locator(".workspace-window")).toBeVisible();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(page.getByRole("dialog", { name: "Agent panel" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimize Agent panel" })).toBeVisible();
  await expect(page.locator(".workspace-window")).toHaveAttribute("inert", "");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedAnimationDuration = await page
    .locator(".agent-panel")
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(reducedAnimationDuration).toBe("0.001s");
  await page.screenshot({ path: `${evidenceDirectory}/narrow-agent.png`, fullPage: true });
});
