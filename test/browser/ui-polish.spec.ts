import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";
import { luminance, rgb } from "../support/visual-contrast";

const evidence = ".factory/screenshots/ui-polish";
const auditViewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
let projectID = "";
let ticketID = "";
const title = "A quiet, readable workspace";
test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(45_000);
test.use({ actionTimeout: 5000 });

test.beforeEach(async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await signIn(page);
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  const { session } = await (await page.request.get("/api/session")).json();
  projectID = crypto.randomUUID();
  for (const endpoint of ["source-workspace", "developer-ide"]) {
    await page.route(`**/api/projects/${projectID}/${endpoint}/ensure`, (route) =>
      route.fulfill({ status: 503, json: { error: "Planning-only visual fixture" } }),
    );
  }
  const db = createDatabase(1);
  ticketID = crypto.randomUUID();
  const content = canonicalRequirementContent({
    summary: "Keep the **important work** readable without competing controls.",
    acceptanceCriteria: ["One clear next action.", "Retain drafts when minimized."],
    nonGoals: [],
  });
  try {
    await db.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`polish-${projectID}`}, 'UI polish', 'https://example.invalid/polish.git', 'main', '.devcontainer/devcontainer.json', ${session.user.id})`;
    await db.client`INSERT INTO factory.ticket(id, project_id, title, state, created_by)
      VALUES (${ticketID}, ${projectID}, ${title}, 'ready', ${session.user.id})`;
    await db.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${crypto.randomUUID()}, ${ticketID}, 1, ${content}, ${createHash("sha256").update(content).digest("hex")}, ${session.user.id})`;
  } finally {
    await db.client.end();
  }
  await page.getByRole("button", { name: "Open project menu" }).click();
  await page
    .getByRole("button")
    .filter({ hasText: `polish-${projectID}` })
    .click();
  await page.getByRole("region", { name: "requirements", exact: true }).getByRole("button").click();
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeVisible();
});

test.afterEach(async () => {
  if (projectID) await deleteFactoryProject(projectID);
  projectID = "";
});

async function openSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  return page.getByRole("navigation", { name: "Settings navigation" });
}

test("visual sweep keeps Project membership separate from Factory account actions", async ({
  page,
}) => {
  const navigation = await openSettings(page);
  await navigation.getByRole("button", { name: "People & access", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Project membership" })).toBeVisible();
  await expect
    .soft(page.getByRole("region", { name: "Managed accounts" }))
    .toHaveCount(0, { timeout: 1500 });
  await page.screenshot({ path: `${evidence}/sweep-project-access.png` });
  await navigation.getByRole("button", { name: "People & access", exact: true }).last().click();
  const accounts = page.getByRole("region", { name: "Managed accounts" });
  await expect(accounts).toBeVisible();
  const opener = accounts.getByRole("button", {
    name: "Access actions for Local administrator",
    exact: true,
  });
  const row = opener.locator("xpath=ancestor::li");
  const height = await row.evaluate((element) => element.getBoundingClientRect().height);
  await opener.click();
  const menu = page.getByRole("menu", {
    name: "Access actions for Local administrator",
    exact: true,
  });
  await expect(menu).toBeVisible({ timeout: 1500 });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(
    height,
    0,
  );
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  for (const viewport of auditViewports) {
    await page.setViewportSize(viewport);
    const bounds = await menu.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `${evidence}/sweep-account-menu-${viewport.width}.png` });
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(opener).toBeFocused();
  const lastOpener = accounts.getByRole("button", { name: /^Access actions for / }).last();
  await lastOpener.scrollIntoViewIfNeeded();
  await lastOpener.click();
  const bottomMenu = accounts.getByRole("menu");
  await expect(bottomMenu).toBeVisible();
  const bottom = await bottomMenu.evaluate((element) => {
    const viewport = element.closest(".settings-content");
    if (!viewport) throw new Error("Missing Settings viewport");
    return element.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom;
  });
  expect(bottom).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${evidence}/sweep-account-menu-bottom.png` });
});

test("visual sweep uses the active accent and aligned Settings form actions", async ({ page }) => {
  const navigation = await openSettings(page);
  await navigation.getByRole("button", { name: "Environments", exact: true }).click();
  const environment = page.getByRole("region", { name: "Project environment", exact: true });
  await environment.getByRole("button", { name: "Add variable", exact: true }).click();
  const checkbox = environment.getByRole("checkbox", { name: "Runtime", exact: true });
  const color = await checkbox.evaluate((element) => {
    const primary = document.querySelector(".primary-button");
    if (!primary) throw new Error("Missing primary action");
    return {
      actual: getComputedStyle(element).accentColor,
      expected: getComputedStyle(primary).backgroundColor,
    };
  });
  expect.soft(color.actual).toBe(color.expected);
  for (const category of ["Environments", "Usage & limits", "Company sign-in"]) {
    await navigation.getByRole("button", { name: category, exact: true }).first().click();
    for (const viewport of auditViewports) {
      await page.setViewportSize(viewport);
      const form = page.locator(".settings-content form").last();
      const action = form.locator('button[type="submit"]');
      await expect(action).toBeVisible();
      const alignment = await action.evaluate((button) => {
        const form = button.closest("form");
        if (!form) throw new Error("Missing form");
        const parent = form.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return { right: parent.right - bounds.right, smaller: bounds.width < parent.width - 30 };
      });
      expect.soft(alignment.right).toBeLessThanOrEqual(1);
      expect.soft(alignment.smaller).toBe(true);
      await page.screenshot({
        path: `${evidence}/sweep-form-${category.replaceAll(" ", "-")}-${viewport.width}.png`,
      });
    }
  }
  await expect(page.getByRole("heading", { name: "Company sign-in", exact: true })).toHaveCount(1, {
    timeout: 1500,
  });
});

test("visual sweep keeps citation markers on their claim's last line", async ({ page }) => {
  const body =
    "Staging Preview shows the app from the default branch; it is not the Ticket workspace, which is where you work with a specific Ticket. The Wiki does not describe the Ticket workspace’s contents or behavior, so I can’t make a more detailed comparison from it.[^1]";
  await page.route(new RegExp(`/api/projects/${projectID}/conversation(?:\\?.*)?$`), (route) =>
    route.fulfill({
      json: {
        id: crypto.randomUUID(),
        projectId: projectID,
        ticketId: ticketID,
        mode: "plan",
        version: 1,
        entries: [
          {
            id: crypto.randomUUID(),
            ordinal: 1,
            kind: "agent-message",
            actor: "project-agent",
            mode: "plan",
            body,
            payload: {},
            citations: [{ source: "ticket", id: ticketID, label: title, reference: 1 }],
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  const citation = page.getByRole("button", { name: `Source 1: ${title}`, exact: true });
  await expect(citation).toBeVisible();
  // Each width can put the citation at a line boundary. Inspect the real final text run,
  // not just the button's DOM parent or its nominal inline display.
  for (const width of [1280, 1200, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page
          .locator(".agent-panel")
          .evaluate((e) => e.getAnimations().some((a) => a.playState === "running")),
      )
      .toBe(false);
    const layout = await citation.evaluate((button) => {
      const node = button.previousSibling;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("Missing claim text");
      const range = document.createRange();
      const text = node.textContent ?? "";
      const end = text.replace(/[\s\u2060]+$/, "").length;
      range.setStart(node, end - 3);
      range.setEnd(node, end);
      const last = Array.from(range.getClientRects()).at(-1);
      if (!last) throw new Error("Missing final text line");
      const marker = button.getBoundingClientRect();
      return { sameLine: marker.top < last.bottom && marker.bottom > last.top };
    });
    expect.soft(layout.sameLine, `citation at width ${width}`).toBe(true);
    await page.screenshot({ path: `${evidence}/sweep-citation-${width}.png` });
  }
});

test("visual sweep captures every Settings category without clipped controls", async ({ page }) => {
  const navigation = await openSettings(page);
  // Settings loads its authorized categories asynchronously. An empty .all() result
  // would otherwise pass without visiting a single category.
  await expect(navigation.getByRole("button")).toHaveCount(13);
  const categories = await navigation.getByRole("button").all();
  for (let index = 0; index < categories.length; index++) {
    const category = categories[index];
    if (!category) throw new Error("Missing Settings category");
    await category.click();
    await expect(page.locator(".settings-content-heading h2")).toBeVisible();
    await expect(page.locator(".settings-content").getByText(/^Loading .*…$/)).toHaveCount(0);
    await expect(page.locator('.settings-content [aria-busy="true"]')).toHaveCount(0);
    for (const viewport of auditViewports) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          page
            .locator(".workspace-window")
            .evaluate((element) =>
              element.getAnimations().some((animation) => animation.playState === "running"),
            ),
        )
        .toBe(false);
      const outside = await page.locator(".settings-content").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll("input, select, textarea, button"))
          .filter((item) => item.getClientRects().length > 0)
          .filter((item) => {
            const r = item.getBoundingClientRect();
            return r.left < bounds.left - 1 || r.right > bounds.right + 1;
          })
          .map((item) => item.getAttribute("aria-label") ?? item.textContent?.trim());
      });
      expect.soft(outside, `Settings category ${index}, width ${viewport.width}`).toEqual([]);
      await page.screenshot({ path: `${evidence}/sweep-settings-${index}-${viewport.width}.png` });
    }
  }
});

test("document frost visibly transmits the obscured Board, with readable supporting text", async ({
  page,
}) => {
  await expect
    .poll(() =>
      page
        .locator(".workspace-window")
        .evaluate((element) =>
          element.getAnimations().some((animation) => animation.playState === "running"),
        ),
    )
    .toBe(false);
  const bounds = await page.locator(".workspace-window").boundingBox();
  if (!bounds) throw new Error("Missing document window");
  const clip = { x: bounds.x + 24, y: bounds.y + 180, width: 48, height: 48 };
  const rasterMean = async () => {
    const capture = await page.screenshot({ clip });
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing raster context");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let total = 0;
      for (let index = 0; index < pixels.length; index += 4) total += pixels[index] ?? 0;
      return total / (pixels.length / 4);
    }, capture.toString("base64"));
  };
  // Change only the scene behind the actual document. This checks rendered transmission,
  // including Board dimming and every real intermediate material layer, rather than token names.
  const probe = await page.addStyleTag({
    content:
      ".kanban-desktop { background: black !important; } .kanban-desktop > * { visibility: hidden !important; }",
  });
  try {
    const dark = await rasterMean();
    await probe.evaluate((element) => {
      element.textContent += ".kanban-desktop { background: white !important; }";
    });
    const light = await rasterMean();
    expect.soft(light - dark).toBeGreaterThanOrEqual(35);
    const material = await page.locator(".workspace-window").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        muted: style.getPropertyValue("--color-ink-muted").trim(),
        blur: style.backdropFilter,
      };
    });
    const surface = rgb(material.background);
    const muted = [1, 3, 5].map((offset) =>
      Number.parseInt(material.muted.slice(offset, offset + 2), 16),
    );
    expect(material.blur).toMatch(/blur\([\d.]+px\)/);
    expect(
      (luminance(surface.channels.map((value) => value * surface.alpha)) + 0.05) /
        (luminance(muted) + 0.05),
    ).toBeGreaterThanOrEqual(4.5);
  } finally {
    await probe.evaluate((element) => element.parentNode?.removeChild(element));
  }
});

test("frost, integrated controls and action hierarchy stay coherent", async ({ page }) => {
  await page.screenshot({ path: `${evidence}/ticket-desktop.png` });
  const material = await page.locator(".ticket-editor-frame").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    control: Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--window-control-size"),
    ),
  }));
  expect.soft(material.background).toBe("rgba(0, 0, 0, 0)");
  expect.soft(material.control).toBeGreaterThanOrEqual(28);
  await expect
    .soft(page.locator(".ticket-header-actions > button").filter({ hasText: "History" }))
    .toHaveCount(0);
  const order = await page.locator(".ticket-header-actions").evaluate((element) => {
    const primary = element.querySelector(".primary-button")?.getBoundingClientRect();
    const menu = element.querySelector(".ticket-secondary-actions")?.getBoundingClientRect();
    return Boolean(primary && menu && menu.left >= primary.right);
  });
  expect.soft(order).toBe(true);
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await expect.soft(page.getByRole("menuitem", { name: "History", exact: true })).toBeVisible();
  await expect.soft(page.locator(".ticket-action-menu select")).toHaveCount(0, { timeout: 1500 });
  await expect
    .soft(page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }))
    .toBeVisible({ timeout: 1500 });
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".workspace-window");
    if (!element) throw new Error("Missing window");
    let sampled = false;
    new MutationObserver(() => {
      if (!sampled && element.dataset["closing"] === "true") {
        sampled = true;
        const animation = element
          .getAnimations()
          .find(
            (animation) =>
              animation instanceof CSSAnimation && animation.animationName === "window-out",
          );
        if (!animation) throw new Error("Missing native exit animation");
        const duration = Number(animation.effect?.getTiming().duration);
        // Seek the real compositor effect, avoiding a missed 140ms RAF window under host load.
        animation.pause();
        animation.currentTime = duration / 2;
        Object.assign(window, {
          factoryExitSample: {
            hidden: element.hidden,
            inert: element.inert,
            animation: getComputedStyle(element).animationName,
            opacity: Number(getComputedStyle(element).opacity),
            duration,
          },
        });
        animation.play();
      }
    }).observe(element, { attributes: true });
  });
  await page.getByRole("button", { name: "Minimize workspace" }).click();
  const exit = await page.evaluate(
    () =>
      (
        window as typeof window & {
          factoryExitSample: {
            hidden: boolean;
            inert: boolean;
            animation: string;
            opacity: number;
            duration: number;
          };
        }
      ).factoryExitSample,
  );
  expect(exit).toBeDefined();
  expect.soft(exit.hidden).toBe(false);
  expect.soft(exit.inert).toBe(true);
  expect.soft(exit.animation).toBe("window-out");
  expect(exit.duration).toBe(140);
  expect(exit.opacity).toBeGreaterThan(0);
  expect(exit.opacity).toBeLessThan(1);
  await expect(page.locator(".workspace-window")).toBeHidden();
  await page.getByRole("button", { name: "Ticket", exact: true }).click();
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ticket", exact: true }).dispatchEvent("click");
  await page.getByRole("button", { name: "Ticket", exact: true }).dispatchEvent("click");
  await expect(page.locator(".workspace-window")).toHaveAttribute("data-closing", "false");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await page.locator(".workspace-window").boundingBox())?.x)
    .toBeLessThan(12);
  await page.screenshot({ path: `${evidence}/ticket-narrow.png` });
  const overlaps = await page.locator(".ticket-status-row").evaluate((element) => {
    const actions = element.querySelector(".ticket-header-actions")?.getBoundingClientRect();
    if (!actions) throw new Error("Missing Ticket actions");
    return Array.from(element.querySelectorAll(".ticket-status-context span")).some((span) => {
      const context = span.getBoundingClientRect();
      return (
        context.right > actions.left &&
        context.left < actions.right &&
        context.bottom > actions.top &&
        context.top < actions.bottom
      );
    });
  });
  expect(overlaps).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("silent Preview attachment offers a bounded reload of the same instance", async ({ page }) => {
  const attemptID = crypto.randomUUID();
  const developmentAttemptID = crypto.randomUUID();
  let documents = 0;
  let computeStarts = 0;
  let release = () => {};
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(personal-workspace|ticket-workspace|staging)\/ensure$/.test(request.url())
    )
      computeStarts++;
  });
  await page.route(`**/api/runtime-attempts?projectId=${projectID}`, (route) =>
    route.fulfill({
      json: {
        attempts: [
          {
            id: attemptID,
            projectId: projectID,
            runtimeKind: "staging",
            currentStaging: true,
            state: "ready",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/projects/${projectID}/app-previews`, (route) =>
    route.fulfill({
      json: {
        previews: [
          { attemptID: developmentAttemptID, projectID, channel: "web", label: "Development app" },
        ],
      },
    }),
  );
  await page.route("**/api/runtime-access?embed=1&path=*", async (route) => {
    documents++;
    if (documents === 1) await stalled;
    await route
      .fulfill({ contentType: "text/html", body: "<!doctype html><p>Attached Preview</p>" })
      .catch(() => {});
  });
  try {
    // This chooser appears only after the complete lifecycle projection is applied.
    // Waiting for one HTTP response alone can race the other batched projections.
    const chooser = page.getByRole("button", { name: "Choose Preview instance", exact: true });
    await expect(chooser).toBeVisible();
    await page.clock.install();
    await chooser.click();
    await page.getByRole("menuitem", { name: /^Staging ready$/ }).click();
    await expect.poll(() => documents).toBe(1);
    await page.clock.fastForward(31_000);
    const retry = page.getByRole("button", { name: "Reload view", exact: true });
    await expect(retry).toBeVisible({ timeout: 1500 });
    await page.screenshot({ path: `${evidence}/sweep-preview-retry.png` });
    await retry.click();
    await expect.poll(() => documents).toBe(2);
    await expect(
      page.frameLocator('iframe[title="Factory Preview"]').getByText("Attached Preview"),
    ).toBeVisible();
    await expect(page.locator('iframe[title="Factory Preview"]')).toHaveAttribute(
      "data-runtime-attempt-id",
      attemptID,
    );
    expect(computeStarts).toBe(0);
  } finally {
    release();
  }
});

test("Dock chooser is integrated, keyboard navigable and does not start compute", async ({
  page,
}) => {
  const changeID = crypto.randomUUID();
  let starts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(personal-workspace|ticket-workspace|staging)\/ensure$/.test(request.url())
    )
      starts++;
  });
  await page.route("**/api/changes?*", (route) =>
    route.fulfill({
      json: {
        changes: [
          {
            id: changeID,
            projectId: projectID,
            ticketId: ticketID,
            branchName: "factory/visual-only",
            baseSha: "a".repeat(40),
            state: "active",
            branchState: "succeeded",
            implementationState: "committed",
            buildTurnState: "completed",
          },
        ],
      },
    }),
  );
  const chooser = page.getByRole("button", { name: "Choose IDE instance", exact: true });
  await expect(chooser).toBeVisible({ timeout: 10_000 });
  const group = page.locator(".dock-app.has-instances");
  const shape = await group.evaluate((element) => {
    const group = element.getBoundingClientRect();
    const arrow = element.querySelector(".dock-instance-menu")?.getBoundingClientRect();
    return {
      enclosed: Boolean(arrow && arrow.left >= group.left && arrow.right <= group.right),
      width: arrow?.width,
      background: getComputedStyle(element).backgroundColor,
    };
  });
  expect(shape.enclosed).toBe(true);
  expect(shape.width).toBeGreaterThanOrEqual(24);
  expect(shape.background).not.toBe("rgba(0, 0, 0, 0)");
  await chooser.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "IDE instances", exact: true });
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  const focused = await items.nth(1).elementHandle();
  const refreshed = await page.waitForResponse((response) =>
    response.url().endsWith(`/api/changes?projectId=${projectID}`),
  );
  await refreshed.finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect
    .poll(() => focused?.evaluate((element) => element.isConnected), { timeout: 1500 })
    .toBe(true);
  await expect(items.nth(1)).toBeFocused({ timeout: 1500 });
  await page.screenshot({ path: `${evidence}/dock-keyboard.png` });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(chooser).toBeFocused();
  expect(starts).toBe(0);
});

test("rapid minimize retains drafts and prefers solid, reduced-motion presentation when requested", async ({
  page,
}) => {
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  const draft = page.getByRole("region", { name: "New ticket draft", exact: true });
  await draft
    .getByRole("textbox", { name: "Ticket title", exact: true })
    .fill("Keep my unfinished idea");
  await page.getByRole("button", { name: "Toggle Agent panel", exact: true }).click();
  const input = page.locator(".agent-input-shell textarea");
  await input.fill("A retained question, not submitted");
  // Two real handlers in the same frame catch a stale delayed hide after reopening.
  await page
    .getByRole("button", { name: "Minimize Agent panel", exact: true })
    .dispatchEvent("click");
  await page
    .getByRole("button", { name: "Toggle Agent panel", exact: true })
    .dispatchEvent("click");
  await expect(input).toHaveValue("A retained question, not submitted");
  await expect(page.locator(".agent-panel")).toHaveAttribute("data-closing", "false");
  await page.getByRole("button", { name: "Minimize Agent panel", exact: true }).click();
  await page
    .getByRole("button", { name: "Minimize workspace", exact: true })
    .dispatchEvent("click");
  await page.getByRole("button", { name: "New Ticket", exact: true }).dispatchEvent("click");
  await expect(draft.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveValue(
    "Keep my unfinished idea",
  );
  await expect(page.locator(".workspace-window")).toHaveAttribute("data-closing", "false");
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  const fallback = await page.locator(".workspace-window").evaluate((element) => ({
    filter: getComputedStyle(element).backdropFilter,
    background: getComputedStyle(element).backgroundColor,
    duration: getComputedStyle(element).animationDuration,
  }));
  expect(fallback.filter).toBe("none");
  expect(fallback.background).toMatch(/^rgb\(/);
  expect(fallback.duration).toBe("0.001s");
  await page.screenshot({ path: `${evidence}/solid-reduced-motion.png` });
  await session.detach();
});

test("setup, Inbox and Trash remain readable at desktop and narrow widths", async ({ page }) => {
  const contained = async (selector: string) => {
    const outside = await page.locator(selector).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("button, input, h2, p"))
        .filter((item) => {
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
        })
        .map((item) => item.textContent?.trim() || item.getAttribute("aria-label"));
    });
    expect(outside).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 1440,
    );
  };
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.getByText("No decisions need your attention.", { exact: true })).toBeVisible();
  for (const viewport of auditViewports) {
    await page.setViewportSize(viewport);
    await contained(".inbox-workspace");
    await page.screenshot({ path: `${evidence}/inbox-${viewport.width}.png` });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const trash = page.getByRole("region", { name: "Trash", exact: true });
  await expect(trash.getByText("Trash is empty.", { exact: true })).toBeVisible();
  await contained(".trash-workspace");
  await page.screenshot({ path: `${evidence}/trash-empty.png` });
  await page.getByRole("tab", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Trash", exact: true }).click();
  await expect(trash.getByRole("button", { name: title, exact: true })).toBeVisible();
  for (const viewport of auditViewports) {
    await page.setViewportSize(viewport);
    await contained(".trash-workspace");
    await page.screenshot({ path: `${evidence}/trash-${viewport.width}.png` });
  }

  // UI-only setup responses do not begin or overwrite the administrator's retained setup.
  let setup = {
    id: crypto.randomUUID(),
    version: 1,
    state: "draft",
    projectID: null,
    commandID: null,
    failure: null as string | null,
    name: "A focused product",
    slug: "focused-product",
    kind: "starter",
    sourceURL: "",
  };
  await page.route("**/api/project-setup", async (route) => {
    if (route.request().method() === "PUT") {
      setup = { ...setup, ...route.request().postDataJSON(), version: setup.version + 1 };
    }
    await route.fulfill({ json: setup });
  });
  await page.route("**/api/project-setup/create", async (route) => {
    setup = {
      ...setup,
      state: "failed",
      failure: "Repository host is unavailable. Your setup is retained.",
    };
    await route.fulfill({ json: setup });
  });
  await page.getByRole("button", { name: "Open project menu", exact: true }).click();
  await page
    .locator(".project-menu")
    .getByRole("button", { name: /Create project|Continue project setup/ })
    .click();
  const panel = page.getByRole("region", { name: "Project setup", exact: true });
  await expect(panel.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue(
    "A focused product",
  );
  for (const viewport of auditViewports) {
    await page.setViewportSize(viewport);
    await contained(".project-setup-panel");
    await page.screenshot({ path: `${evidence}/setup-starter-${viewport.width}.png` });
  }
  await panel.getByRole("button", { name: "Import Git" }).click();
  await expect(panel.getByRole("textbox", { name: "Git URL", exact: true })).toBeVisible();
  await contained(".project-setup-panel");
  await page.screenshot({ path: `${evidence}/setup-import-narrow.png` });
  await panel.getByRole("button", { name: "Import project", exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", { name: "Import project", exact: true })).toBeVisible();
  await contained(".project-setup-panel");
  await page.screenshot({ path: `${evidence}/setup-import-action-narrow.png` });
  await panel.getByRole("button", { name: "Starter" }).click();
  await expect(panel.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(
    panel.getByText("Repository host is unavailable. Your setup is retained.", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry setup", exact: true })).toBeEnabled();
  await contained(".project-setup-panel");
  await page.screenshot({ path: `${evidence}/setup-failed-narrow.png` });
});

test("Ticket overflow contains long relationship names without clipping controls", async ({
  page,
}) => {
  const db = createDatabase(1);
  const candidate =
    "Keep the first-run workflow accessible with keyboard navigation and clear links to the project knowledge and source editor";
  try {
    await db.client`INSERT INTO factory.ticket(id, project_id, title, state, created_by)
      SELECT ${crypto.randomUUID()}, project_id, ${candidate}, 'inbox', created_by
      FROM factory.ticket WHERE id=${ticketID}`;
  } finally {
    await db.client.end();
  }
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add dependency…", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add dependency", exact: true });
  const search = picker.getByRole("searchbox", { name: "Search Tickets", exact: true });
  await expect(search).toBeFocused();
  await search.fill("not-a-match");
  await expect(picker.getByText("No matching Tickets", { exact: true })).toBeVisible();
  await expect(picker.getByRole("button", { name: candidate, exact: true })).toHaveCount(0);
  await search.fill("FIRST-RUN keyboard");
  await expect(picker.getByRole("button", { name: candidate, exact: true })).toBeVisible();
  await search.press("ArrowDown");
  await expect(picker.getByRole("button", { name: candidate, exact: true })).toBeFocused();
  for (const viewport of auditViewports) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page
          .locator(".workspace-window")
          .evaluate((element) =>
            element.getAnimations().some((animation) => animation.playState === "running"),
          ),
      )
      .toBe(false);
    const geometry = await page.locator(".ticket-action-menu").evaluate((element) => {
      const menu = element.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll("button, input")).map((item) => {
        const rect = item.getBoundingClientRect();
        return {
          name: item.getAttribute("aria-label") ?? item.textContent?.trim(),
          fits: rect.left >= menu.left && rect.right <= menu.right,
        };
      });
      return {
        onScreen: menu.left >= 0 && menu.right <= innerWidth,
        left: menu.left,
        right: menu.right,
        viewport: innerWidth,
        controls,
      };
    });
    expect(geometry, JSON.stringify(geometry)).toMatchObject({ onScreen: true });
    expect(geometry.controls.filter((control) => !control.fits)).toEqual([]);
    await page.screenshot({ path: `${evidence}/ticket-overflow-${viewport.width}.png` });
  }
  await picker.getByRole("button", { name: "Back to Ticket actions", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Ticket actions", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "History", exact: true })).toBeFocused();
  await page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search Epics", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ticket actions", exact: true })).toBeFocused();
});
