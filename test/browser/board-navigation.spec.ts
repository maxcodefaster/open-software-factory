import { mockFactoryFunctions } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import { browserBootstrap } from "../fixtures/server-functions";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { desktopBackgroundKeys } from "../../packages/interface-domain/src/background";
import { openProjectMenu } from "../fixtures/project-menu";
import { serveChatAssets } from "../support/chat-assets";
import { createPlanningEpic, deleteFactoryProject, signIn } from "../support/factory-fixture";
import { luminance, rgb } from "../support/visual-contrast";

const evidence = ".factory/test-results/board-navigation-refinement";
const materialsEvidence = ".factory/test-results/board-materials";
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test.setTimeout(90_000);
let database: ReturnType<typeof createDatabase>;
let projectID = "";
let otherID = "";
let commissioned = 0;

test.beforeEach(async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await mkdir(materialsEvidence, { recursive: true });
  await serveChatAssets(page);
  await signIn(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const { session } = await browserBootstrap(page);
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  otherID = crypto.randomUUID();
  commissioned = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:conversation\/(?:message|answer)|agent\/(?:start|prompt)|runtime-attempts\/[^/]+\/start)$/.test(
        new URL(request.url()).pathname,
      )
    )
      commissioned++;
  });
  for (const id of [projectID, otherID]) {
    await mockFactoryFunctions(page, {
      workspaces: {
        ensurePersonalSource: async () => {
          throw new CommandError("unavailable", "Owned navigation proof has no runtime");
        },
        ensureEditor: async () => {
          throw new CommandError("unavailable", "Owned navigation proof has no runtime");
        },
      },
    });
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
      VALUES(${id},${`navigation-${id}`},
        ${id === projectID ? "Product workspace" : "Another workspace with a deliberately long Project name"},
        'https://example.invalid/navigation.git','main','.devcontainer/devcontainer.json',${session.user.id},'the-harvesters')`;
  }
  await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
    VALUES(${crypto.randomUUID()},${projectID},'Explore the onboarding flow','inbox',${session.user.id}),
      (${crypto.randomUUID()},${projectID},'Make navigation easier to scan','ready',${session.user.id})`;
  const conversationID = crypto.randomUUID();
  await database.client`INSERT INTO factory.ticket_conversation(id,project_id,mode,created_by)
    VALUES(${conversationID},${projectID},'plan',${session.user.id})`;
  await database.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,citations,created_by)
    VALUES(${crypto.randomUUID()},${conversationID},1,'user-message','user','plan',
      'Can we simplify the board navigation?','{}'::jsonb,'[]'::jsonb,${session.user.id}),
      (${crypto.randomUUID()},${conversationID},2,'agent-message','project-agent','plan',
      'Keep one clear place to create a ticket. The column headings can stay focused on the stages.',
      '{}'::jsonb,'[]'::jsonb,${session.user.id})`;
  await openProjectMenu(page);
  await page
    .getByRole("button")
    .filter({ hasText: `navigation-${projectID}` })
    .click();
  const dock = page.getByRole("navigation", { name: "Workspace dock", exact: true });
  await expect(dock.getByRole("button", { name: "IDE", exact: true })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
});

test.afterEach(async () => {
  for (const id of [projectID, otherID]) if (id) await deleteFactoryProject(id, database);
  await database?.client.end();
  projectID = "";
  otherID = "";
});

test("desktop keeps compact actions, aligned stage headings and one retained draft", async ({
  page,
}) => {
  const topbar = page.locator(".factory-topbar");
  const board = page.getByRole("region", { name: "Ticket board", exact: true });
  await expect(board.locator(".lane-heading h2")).toHaveText([
    "Ideas",
    "Requirements",
    "Implementation",
    "Review",
  ]);
  await expect(board.locator(".lane-heading button, .lane-heading-actions")).toHaveCount(0);
  await expect(board.locator(".board-project-name, .board-toolbar")).toHaveCount(0);
  await expect(
    board.getByRole("region", { name: "ideas", exact: true }),
  ).toHaveAccessibleDescription("1 ticket");
  for (const lane of await board.locator(".lane").all())
    await expect(lane).toHaveCSS("border-top-width", "0px");
  const project = topbar.getByRole("button", { name: "Open project menu", exact: true });
  const create = topbar.getByRole("button", { name: "New Ticket", exact: true });
  for (const width of [1440, 1024, 901]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(project).toBeVisible();
    await expect(create).toBeVisible();
    const left = await project.boundingBox();
    const right = await create.boundingBox();
    const dock = await page.getByRole("navigation", { name: "Workspace dock" }).boundingBox();
    if (!left || !right || !dock) throw new Error("Global navigation is missing");
    expect(right.width).toBeLessThanOrEqual(128);
    expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(1);
    expect(left.x + left.width).toBeLessThan(dock.x);
    expect(right.x).toBeGreaterThan(dock.x + dock.width);
    const headings = await board.locator(".lane-heading").evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, top: bounds.top };
      }),
    );
    expect(
      Math.max(...headings.map((heading) => heading.width)) -
        Math.min(...headings.map((heading) => heading.width)),
    ).toBeLessThanOrEqual(1);
    expect(new Set(headings.map((heading) => heading.height)).size).toBe(1);
    expect(new Set(headings.map((heading) => heading.top)).size).toBe(1);
    for (const heading of await board.locator(".lane-heading").all()) {
      await expect(heading).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(heading).toHaveCSS("padding-left", "0px");
    }
    const lanes = board.locator(".lane");
    await expect(lanes.first()).toHaveCSS("border-inline-start-width", "0px");
    for (const lane of (await lanes.all()).slice(1))
      await expect(lane).toHaveCSS("border-inline-start-width", "1px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: `${evidence}/board-${width}.png` });
  }
  await project.click();
  await page
    .getByRole("button")
    .filter({ hasText: `navigation-${otherID}` })
    .click();
  await expect(project).toHaveAttribute(
    "title",
    "Another workspace with a deliberately long Project name",
  );
  const text = project.locator("span");
  await expect(text).toHaveCSS("text-overflow", "ellipsis");
  await project.click();
  await page.keyboard.press("Escape");
  await expect(project).toBeFocused();
  await project.click();
  await page
    .getByRole("button")
    .filter({ hasText: `navigation-${projectID}` })
    .click();
  await create.click();
  await expect(
    page.getByRole("button", { name: "Write requirements", exact: true }),
  ).toHaveAttribute("data-primary", "true");
  await expect(page.getByRole("button", { name: "Create as idea", exact: true })).toBeVisible();
  await page.getByLabel("Ticket title", { exact: true }).fill("Retain this ticket draft");
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await create.click();
  await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
    "Retain this ticket draft",
  );
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(topbar.getByRole("button", { name: "New Ticket", exact: true })).toHaveCount(0);
  const phoneCreate = board.getByRole("button", { name: "New Ticket", exact: true });
  await expect(phoneCreate).toBeVisible();
  await phoneCreate.click();
  await expect(page.getByLabel("Ticket title", { exact: true })).toHaveValue(
    "Retain this ticket draft",
  );
  expect(commissioned).toBe(0);
});

test("shared Board materials stay readable on all six Project backgrounds", async ({ page }) => {
  const { session } = await browserBootstrap(page);
  const epicID = await createPlanningEpic({
    database,
    projectID,
    userID: session.user.id,
    title: "Navigation polish",
  });
  await database.client`INSERT INTO factory.ticket(id,project_id,title,state,epic_id,created_by)
    VALUES(${crypto.randomUUID()},${projectID},'Group related onboarding improvements',
      'inbox',${epicID},${session.user.id})`;
  const board = page.getByRole("region", { name: "Ticket board", exact: true });
  const _stages = board.locator(".board");
  const desktop = page.locator(".factory-desktop");
  const card = board.locator(".ticket-card").first();
  const epic = board.locator(".epic-stack").first();
  await expect(epic).toBeVisible();
  await expect(epic).toContainText("Group related onboarding improvements");
  await page.mouse.move(0, 0);
  const readings: { width: number; background: string; minimumContrast: number }[] = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const background of desktopBackgroundKeys) {
      // Presentation-only variant on this owned Project, not a persisted preference change.
      await desktop.evaluate(async (element, key) => {
        element.setAttribute("data-background", key);
        const source = getComputedStyle(element).getPropertyValue("--desktop-art");
        const path = source.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
        if (!path) throw new Error("Project artwork is absent");
        const image = new Image();
        image.src = path;
        await image.decode();
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        );
      }, background);
      const observed = await desktop.evaluate((element) => {
        const stages = element.querySelector(".board");
        const chrome = element.querySelector(".workspace-dock");
        if (!stages || !chrome) throw new Error("Board navigation is absent");
        const band = getComputedStyle(stages, "::before");
        const material = (item: Element) => {
          const style = getComputedStyle(item);
          return { background: style.backgroundColor, blur: style.backdropFilter };
        };
        return {
          tint: getComputedStyle(element).getPropertyValue("--surface-rgb").trim(),
          chrome: material(chrome),
          band: band.content,
          surfaces: [...stages.querySelectorAll(".ticket-card, .epic-stack")].map((item) => ({
            ...material(item),
            colors: [...item.querySelectorAll("strong, small, .epic-stack-preview")].map(
              (text) => ({ label: text.textContent, color: getComputedStyle(text).color }),
            ),
          })),
          headings: [...stages.querySelectorAll(".lane-heading h2")].map((text) => ({
            ...material(text),
            colors: [{ label: text.textContent, color: getComputedStyle(text).color }],
          })),
        };
      });
      expect(observed.surfaces.length).toBeGreaterThanOrEqual(3);
      expect(observed.band).toBe("none");
      const tint = observed.tint.split(/\s+/).map(Number);
      const contents = observed.surfaces[0];
      if (!contents) throw new Error("Board content is absent");
      expect(rgb(contents.background).alpha).toBeLessThan(0.9);
      let minimumContrast = Infinity;
      for (const surface of [...observed.headings, ...observed.surfaces]) {
        expect({ background: surface.background, blur: surface.blur }).toEqual(observed.chrome);
        const material = rgb(surface.background);
        expect(material.channels).toEqual(tint);
        expect(surface.blur).toBe(observed.chrome.blur);
        // Conservative contrast floor over black, independent of a conveniently pale painting.
        const floor = luminance(material.channels.map((channel) => channel * material.alpha));
        for (const { label, color } of surface.colors) {
          const text = rgb(color);
          expect(text.alpha).toBe(1);
          const contrast = (floor + 0.05) / (luminance(text.channels) + 0.05);
          expect(contrast, `${background} at ${width}px: ${label}`).toBeGreaterThanOrEqual(4.5);
          minimumContrast = Math.min(minimumContrast, contrast);
        }
      }
      readings.push({ width, background, minimumContrast });
      await page.screenshot({ path: `${materialsEvidence}/${background}-${width}.png` });
    }
  }
  await writeFile(
    `${materialsEvidence}/contrast.json`,
    `${JSON.stringify({ conditions: "Computed materials over black, conservative floor", readings }, null, 2)}\n`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(0, 0);
  await card.hover();
  await expect
    .poll(() =>
      card
        .evaluate((element) => getComputedStyle(element).backgroundColor)
        .then((color) => rgb(color).alpha),
    )
    .toBe(0.78);
  const hover = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
  await epic.getByRole("button").focus();
  await expect(epic.getByRole("button")).toBeFocused();
  await expect
    .poll(() => epic.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(hover);
  expect(commissioned).toBe(0);
});

test("reduced transparency keeps Board content and interaction states opaque", async ({ page }) => {
  const { session } = await browserBootstrap(page);
  await createPlanningEpic({
    database,
    projectID,
    userID: session.user.id,
    title: "Opaque content",
  });
  const board = page.getByRole("region", { name: "Ticket board", exact: true });
  await expect(board.locator(".epic-stack")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  expect(
    await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches),
  ).toBe(true);
  const assertOpaque = async () => {
    await expect
      .poll(async () => {
        const surfaces = await page.locator(".factory-desktop").evaluate((element) => {
          const styles = [
            ...[
              ...element.querySelectorAll(
                ".lane-heading > h2, .ticket-card, .epic-stack, .workspace-dock, .topbar-new-ticket",
              ),
            ].map((item) => getComputedStyle(item)),
          ];
          return styles.map((style) => ({
            background: style.backgroundColor,
            blur: style.backdropFilter,
          }));
        });
        return surfaces.every(
          (surface) => rgb(surface.background).alpha === 1 && surface.blur === "none",
        );
      })
      .toBe(true);
  };
  await assertOpaque();
  await board.locator(".ticket-card").first().hover();
  await assertOpaque();
  await board.locator(".epic-stack").getByRole("button").focus();
  await assertOpaque();
  await page.screenshot({ path: `${materialsEvidence}/reduced-transparency.png` });
  await cdp.detach();
  expect(commissioned).toBe(0);
});

test("long lanes retain their headings and narrow boards scroll between stages", async ({
  page,
}) => {
  const { session } = await browserBootstrap(page);
  for (let index = 0; index < 18; index++)
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${crypto.randomUUID()},${projectID},
        ${`Requirements ${index}: Keep long ticket titles readable without widening the board or hiding the stage heading`},
        'ready',${session.user.id})`;
  const board = page.getByRole("region", { name: "Ticket board", exact: true });
  const requirements = board.getByRole("region", { name: "requirements", exact: true });
  await expect(requirements.locator(".ticket-card")).toHaveCount(19);
  const longWord = `Investigate ${"LongUnbrokenTicketTitle".repeat(6)}`;
  await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
    VALUES(${crypto.randomUUID()},${projectID},${longWord},'inbox',${session.user.id})`;
  const idea = board.getByRole("button").filter({ hasText: longWord });
  await expect(idea).toBeVisible();
  const ideas = board.getByRole("region", { name: "ideas", exact: true });
  expect(
    await ideas
      .locator(".lane-tickets")
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBe(0);
  const heading = requirements.locator(".lane-heading");
  const list = requirements.locator(".lane-tickets");
  const scrollAndCheckHeading = async () => {
    await list.evaluate((element) => element.scrollTo({ top: 350 }));
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(350);
    const laneBounds = await requirements.boundingBox();
    const headingBounds = await heading.boundingBox();
    if (!laneBounds || !headingBounds) throw new Error("Requirements lane is missing");
    const inset = await requirements.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingTop),
    );
    expect(Math.abs(headingBounds.y - laneBounds.y - inset)).toBeLessThanOrEqual(1);
    const ideaHeadingBounds = await ideas.locator(".lane-heading").boundingBox();
    if (!ideaHeadingBounds) throw new Error("Ideas heading is missing");
    expect(headingBounds.y).toBe(ideaHeadingBounds.y);
    expect(
      await heading.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return document
          .elementFromPoint(bounds.x + bounds.width / 2, bounds.y - 2)
          ?.closest(".ticket-card");
      }),
    ).toBeNull();
    expect(
      await heading.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
        );
      }),
    ).toBe(true);
  };
  await scrollAndCheckHeading();
  await page.screenshot({ path: `${evidence}/board-scrolled-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(board.getByRole("button", { name: "New Ticket", exact: true })).toBeVisible();
  await expect(board.getByText(/Swipe through/)).toHaveCount(0);
  const stages = board.locator(".board");
  await expect(stages).toHaveCSS("transition-property", "none");
  const mobileBoard = await stages.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const lane = element.querySelector(".lane")?.getBoundingClientRect();
    const action = element.previousElementSibling?.getBoundingClientRect();
    return {
      snap: getComputedStyle(element).scrollSnapType,
      revealsNextLane: Boolean(lane && lane.width < bounds.width),
      gapAfterActions: action ? bounds.top - action.bottom : undefined,
    };
  });
  expect(mobileBoard.snap).toContain("mandatory");
  expect(mobileBoard.revealsNextLane).toBe(true);
  expect(mobileBoard.gapAfterActions).toBe(0);
  await expect
    .poll(() => stages.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(0);
  await requirements.evaluate((element) =>
    element.scrollIntoView({ block: "nearest", inline: "start" }),
  );
  await expect.poll(() => stages.evaluate((element) => element.scrollLeft)).toBeGreaterThan(200);
  await scrollAndCheckHeading();
  await page.screenshot({ path: `${evidence}/board-scrolled-390.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect(commissioned).toBe(0);
});

test.describe("touch navigation", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("chat leaves the dock and menus usable, and navigation preserves its draft", async ({
    page,
  }) => {
    const toggle = page.getByRole("button", { name: "Toggle Agent panel", exact: true });
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    const topbar = page.locator(".factory-topbar");
    const dock = page.getByRole("navigation", { name: "Workspace dock", exact: true });
    await toggle.tap();
    const panel = page.getByRole("dialog", { name: "Agent panel", exact: true });
    const draft = panel.getByRole("textbox", { name: "Message conversation", exact: true });
    await draft.fill("Keep this unsent Project question.");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel).toHaveAttribute("aria-modal", "false");
      await expect(topbar).not.toHaveAttribute("inert", "");
      for (const control of [
        toggle,
        settings,
        dock.getByRole("button", { name: "Desktop", exact: true }),
      ]) {
        await expect(control).toBeVisible();
        await expect(control).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
        expect(
          await control.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              document
                .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
                ?.closest("button") === element
            );
          }),
        ).toBe(true);
      }
      const navigationBounds = await topbar.boundingBox();
      const backdrop = await page
        .getByRole("button", { name: "Dismiss Agent overlay" })
        .boundingBox();
      if (!navigationBounds || !backdrop) throw new Error("Mobile navigation is missing");
      expect(backdrop.y).toBe(0);
      expect(backdrop.x).toBe(0);
      expect(backdrop.width).toBe(width);
      expect(backdrop.height).toBe(844);
      await expect(draft).toHaveValue("Keep this unsent Project question.");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await page.screenshot({ path: `${evidence}/chat-${width}.png` });
    }
    await page.getByRole("button", { name: "Dismiss Agent overlay" }).click({
      position: { x: 2, y: 2 },
    });
    await expect(panel).toHaveCount(0);
    await toggle.tap();
    await expect(draft).toHaveValue("Keep this unsent Project question.");
    await settings.tap();
    const menu = page.getByRole("region", { name: "Settings", exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Open project menu", exact: true }).tap();
    await expect(page.getByRole("region", { name: "Projects", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await expect
      .poll(() => settings.evaluate((element) => getComputedStyle(element, "::after").opacity))
      .toBe("1");
    await draft.tap();
    await expect
      .poll(() => settings.evaluate((element) => getComputedStyle(element, "::after").opacity))
      .toBe("0");
    await expect(panel).toBeVisible();
    await expect(draft).toHaveValue("Keep this unsent Project question.");
    await dock.getByRole("button", { name: "Desktop", exact: true }).tap();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".agent-panel")).toHaveCount(0);
    const board = page.getByRole("region", { name: "Ticket board", exact: true });
    await expect(board.getByRole("button", { name: "New Ticket", exact: true })).toBeVisible();
    await page.screenshot({ path: `${evidence}/board-320.png` });
    await toggle.tap();
    await expect(draft).toHaveValue("Keep this unsent Project question.");
    await dock.getByRole("button", { name: "Knowledge", exact: true }).tap();
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "knowledge workspace", exact: true }),
    ).toBeVisible();
    await toggle.tap();
    await expect(draft).toHaveValue("Keep this unsent Project question.");
    expect(commissioned).toBe(0);
  });
});
