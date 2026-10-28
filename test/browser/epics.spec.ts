import { mockFactoryFunctions } from "../fixtures/server-functions";
import { CommandError } from "../../apps/factory/src/command-error";
import { browserBootstrap } from "../fixtures/server-functions";
import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { createPlanningEpic, deleteFactoryProject, signIn } from "../support/factory-fixture";

const evidence = ".factory/test-results/epic-folders";
test.use({ viewport: { width: 1440, height: 960 }, contextOptions: { reducedMotion: "reduce" } });
test.setTimeout(90_000);

test("Epic folders replace filtering, retain live updates and expose hierarchy and editing", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectId = crypto.randomUUID();
  const slug = `epic-qa-${projectId.slice(0, 8)}`;
  const errors: string[] = [];
  let commissioned = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:conversation\/message|agent\/(?:start|prompt))$/.test(new URL(request.url()).pathname)
    )
      commissioned++;
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture");
      },
    },
  });
  try {
    await mkdir(evidence, { recursive: true });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await browserBootstrap(page);
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectId},${slug},'Epic folders','https://example.invalid/owned-epics.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    const root = await createPlanningEpic({
      database,
      userID: session.user.id,
      projectID: projectId,
      title: "Release",
    });
    const child = await createPlanningEpic({
      database,
      userID: session.user.id,
      projectID: projectId,
      title: "Onboarding",
      parentID: root,
    });
    const board = page.getByRole("region", { name: "Ticket board", exact: true });
    await expect(page.getByLabel("Filter by Epic")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New Ticket", exact: true })).toBeVisible();
    await expect(board.locator(".lane-heading button")).toHaveCount(0);
    await expect(board.locator(".board-toolbar button.new-ticket-button")).toHaveCount(0);
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await page.getByLabel("Ticket title", { exact: true }).fill("Welcome new developers");
    await expect(
      page.getByRole("button", { name: "Write requirements", exact: true }),
    ).toHaveAttribute("data-primary", "true");
    await page.getByRole("button", { name: "Create as idea", exact: true }).click();
    await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assign to Epic…", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Assign to Epic", exact: true })
      .getByRole("button", { name: "Onboarding", exact: true })
      .click();
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    const openRoot = board.getByRole("button", { name: "Open Epic Release", exact: true });
    await openRoot.focus();
    await openRoot.press("Enter");
    const folder = page.getByRole("dialog", { name: "Release", exact: true });
    await expect(
      folder.getByRole("button", { name: "Open Epic Onboarding", exact: true }),
    ).toBeFocused();
    await expect(folder.locator(".epic-progress")).toHaveText("0/1 done");
    await page.screenshot({ path: `${evidence}/root-desktop.png` });
    await folder.getByRole("button", { name: "Edit Epic", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit Epic", exact: true });
    expect(await edit.getByLabel("Parent Epic").locator("option").allTextContents()).toEqual([
      "No parent",
    ]);
    await page.keyboard.press("Escape");
    await expect(edit).toBeHidden();
    await expect(folder.getByRole("button", { name: "Edit Epic", exact: true })).toBeFocused();
    await folder.getByRole("button", { name: "Open Epic Onboarding", exact: true }).click();
    const childFolder = page.getByRole("dialog", { name: "Onboarding", exact: true });
    const card = childFolder.getByRole("button", { name: /Welcome new developers/ });
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await database.client`UPDATE factory.ticket SET title='Welcome every developer',version=version+1 WHERE project_id=${projectId}`;
    await expect(
      childFolder.getByRole("button", { name: /Welcome every developer/ }),
    ).toBeVisible();
    await expect(
      childFolder.getByRole("button", { name: /Welcome every developer/ }),
    ).toBeFocused();
    await childFolder.getByRole("button", { name: "Edit Epic", exact: true }).click();
    await edit.getByLabel("Epic title").fill("Developer onboarding");
    await edit.getByLabel("Parent Epic").selectOption("");
    await edit.getByRole("button", { name: "Save Epic", exact: true }).click();
    await expect(edit).toBeHidden();
    const renamed = page.getByRole("dialog", { name: "Developer onboarding", exact: true });
    await expect(renamed).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${evidence}/folder-narrow.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.keyboard.press("Escape");
    await expect(renamed).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "New Ticket", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Write requirements", exact: true }),
    ).toHaveAttribute("data-primary", "true");
    await page.getByLabel("Ticket title", { exact: true }).fill("Create directly in Requirements");
    await page.getByRole("button", { name: "Write requirements", exact: true }).click();
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveText(
      "Create directly in Requirements",
    );
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    await expect(
      board
        .getByRole("region", { name: "requirements", exact: true })
        .getByRole("button", { name: /Create directly in Requirements/ }),
    ).toBeVisible();
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const heights = await board
        .locator(".lane-heading")
        .evaluateAll((headings) =>
          headings.map((heading) => heading.getBoundingClientRect().height),
        );
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      const opener = board.getByRole("button", {
        name: "Open Epic Developer onboarding",
        exact: true,
      });
      await opener.click();
      await page.screenshot({ path: `${evidence}/folder-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({ path: `${evidence}/board-${width}.png` });
    }
    expect(commissioned).toBe(0);
    expect(errors).toEqual([]);
    const [created] = await database.client<{ state: string }[]>`
      SELECT state FROM factory.ticket WHERE project_id=${projectId} AND title='Create directly in Requirements'`;
    expect(created?.state).toBe("ready");
    const [edited] = await database.client<{ parent_id: string | null }[]>`
      SELECT parent_id FROM factory.epic WHERE id=${child}`;
    expect(edited?.parent_id).toBe(null);
  } finally {
    await deleteFactoryProject(projectId, database);
    await database.client.end();
  }
});

test("Epic grid centers sparse and incomplete rows and remains usable on small screens", async ({
  page,
}) => {
  const database = createDatabase(1);
  const projectId = crypto.randomUUID();
  const slug = `epic-grid-${projectId.slice(0, 8)}`;
  const captures = ".factory/test-results/epic-grid";
  const errors: string[] = [];
  let commissioned = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(?:conversation\/message|agent\/(?:start|prompt))$/.test(new URL(request.url()).pathname)
    )
      commissioned++;
  });
  await mockFactoryFunctions(page, {
    workspaces: {
      ensurePersonalSource: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture");
      },
      ensureEditor: async () => {
        throw new CommandError("unavailable", "Controlled planning fixture");
      },
    },
  });
  try {
    await mkdir(captures, { recursive: true });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await browserBootstrap(page);
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectId},${slug},'Epic grid','https://example.invalid/owned-grid.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    const epic = await createPlanningEpic({
      database,
      userID: session.user.id,
      projectID: projectId,
      title: "Developer onboarding",
    });
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    const board = page.getByRole("region", { name: "Ticket board", exact: true });
    const opener = board.getByRole("button", {
      name: "Open Epic Developer onboarding",
      exact: true,
    });
    await opener.click();
    await page.mouse.move(0, 0);
    const folder = page.getByRole("dialog", { name: "Developer onboarding", exact: true });
    await expect(folder.getByText("No tickets in this Epic yet.", { exact: true })).toBeVisible();
    await expect(folder.getByRole("button", { name: "Close Epic", exact: true })).toBeFocused();
    expect(
      await folder.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          shadow: style.boxShadow,
          border: style.borderWidth,
        };
      }),
    ).toEqual({ background: "rgba(0, 0, 0, 0)", shadow: "none", border: "0px" });
    await page.screenshot({ path: `${captures}/empty-desktop.png` });
    const titles = [
      "Welcome new developers",
      "Create a project from the starter",
      "Connect a source repository",
      "Invite a teammate",
      "Save requirements without starting AI",
      "Review the first implementation",
      "Add feedback on the live preview",
      "Keep the chat draft when switching projects",
      "Deliver the verified change",
      "Restore the last workspace",
      "Open the shared terminal",
      "Choose a project background",
      "Find related tickets",
      "Browse completed work",
      "Check keyboard navigation",
      `Keep a long imported reference readable: ${"onboarding".repeat(12)}`,
      "Preserve feedback after reconnecting",
    ];
    const states = ["inbox", "ready", "in-progress", "done", "cancelled"] as const;
    let added = 0;
    for (const count of [1, 2, 9, 16, 17]) {
      while (added < count) {
        const title = titles[added];
        const state = states[added % states.length];
        if (!title || !state) throw new Error("Missing owned Epic grid fixture");
        await database.client`INSERT INTO factory.ticket(id,project_id,epic_id,title,state,created_by)
          VALUES(${crypto.randomUUID()},${projectId},${epic},${title},${state},${session.user.id})`;
        added++;
      }
      await expect(folder.locator(".ticket-card")).toHaveCount(count);
      // Each row is centered independently, including the short final row.
      const layout = await folder.locator(".epic-folder-grid").evaluate((grid) => {
        const bounds = grid.getBoundingClientRect();
        const rows: { top: number; left: number; right: number; count: number }[] = [];
        for (const card of grid.querySelectorAll<HTMLElement>(":scope > .ticket-card")) {
          const rect = card.getBoundingClientRect();
          const row = rows.find((row) => Math.abs(row.top - card.offsetTop) < 1);
          if (row) {
            row.right = rect.right;
            row.count++;
          } else rows.push({ top: card.offsetTop, left: rect.left, right: rect.right, count: 1 });
        }
        return {
          center: bounds.left + bounds.right,
          rows,
          widths: Array.from(grid.children, (card) => card.getBoundingClientRect().width),
        };
      });
      expect(layout.rows[0]?.count).toBe(Math.min(count, 4));
      for (const row of layout.rows)
        expect(Math.abs(row.left + row.right - layout.center)).toBeLessThanOrEqual(2);
      expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThanOrEqual(1);
      expect(Math.max(...layout.widths)).toBeLessThanOrEqual(272);
      await page.screenshot({ path: `${captures}/tickets-${count}-1440.png` });
      if (count <= 2 || count === 9) {
        const width = count === 9 ? 1024 : 390;
        await page.setViewportSize({ width, height: 844 });
        const centered = await folder.locator(".epic-folder-grid").evaluate((grid) => {
          const bounds = grid.getBoundingClientRect();
          return Array.from(grid.children).every((card) => {
            const rect = card.getBoundingClientRect();
            return Math.abs(rect.left + rect.right - bounds.left - bounds.right) <= 2;
          });
        });
        if (count <= 2) expect(centered).toBe(true);
        await page.screenshot({ path: `${captures}/tickets-${count}-${width}.png` });
        await page.setViewportSize({ width: 1440, height: 960 });
      }
    }
    for (const status of ["Idea", "Requirements", "Implementation", "Completed", "Cancelled"])
      await expect(
        folder.locator(".ticket-card").getByText(status, { exact: true }).first(),
      ).toBeVisible();
    const first = folder.getByRole("button", { name: /Welcome (?:new|every) developer/ });
    await first.focus();
    await expect(first).toBeFocused();
    await database.client`UPDATE factory.ticket SET title='Welcome every developer',version=version+1
      WHERE project_id=${projectId} AND title='Welcome new developers'`;
    await expect(first).toContainText("Welcome every developer");
    await expect(first).toBeFocused();
    for (const [width, columns] of [
      [1024, 3],
      [760, 2],
      [390, 1],
      [320, 1],
    ] as const) {
      await page.setViewportSize({ width, height: 844 });
      const grid = folder.locator(".epic-folder-grid");
      const layout = await grid.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const cards = Array.from(
          element.querySelectorAll<HTMLElement>(":scope > .ticket-card"),
          (card) => {
            const bounds = card.getBoundingClientRect();
            return { top: card.offsetTop, left: bounds.left, right: bounds.right };
          },
        );
        const first = cards[0];
        const last = cards.at(-1);
        if (!first || !last) throw new Error("Epic grid has no cards");
        const lastRow = cards.filter((card) => Math.abs(card.top - last.top) < 1);
        const rowStart = lastRow[0];
        if (!rowStart) throw new Error("Epic grid has no final row");
        return {
          columns: cards.filter((card) => Math.abs(card.top - first.top) < 1).length,
          center: bounds.left + bounds.right,
          last: rowStart.left + last.right,
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      expect(layout.columns).toBe(columns);
      expect(Math.abs(layout.center - layout.last)).toBeLessThanOrEqual(2);
      expect(layout.overflow).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({ path: `${captures}/tickets-17-${width}.png` });
      await folder.locator(".ticket-card-body").last().focus();
      await expect(folder.locator(".ticket-card-body").last()).toBeInViewport();
      if (width <= 390) {
        expect(await folder.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await page.screenshot({ path: `${captures}/scrolled-${width}.png` });
      }
      await page.keyboard.press("Escape");
      await expect(folder).toBeHidden();
      await expect(opener.first()).toBeFocused();
      await opener.first().press("Enter");
      await expect(folder.locator(".ticket-card-body").first()).toBeFocused();
      expect(await folder.evaluate((element) => element.scrollTop)).toBe(0);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    expect(
      await folder.evaluate((element) => getComputedStyle(element, "::backdrop").backdropFilter),
    ).toBe("none");
    await page.screenshot({ path: `${captures}/reduced-transparency-320.png` });
    await page.mouse.click(1, 1);
    await expect(folder).toBeHidden();
    await expect(opener.first()).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 960 });
    await opener.first().click();
    await first.click();
    await expect(folder).toBeHidden();
    await expect(page.getByLabel("Ticket title", { exact: true })).toHaveText(
      "Welcome every developer",
    );
    expect(commissioned).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await deleteFactoryProject(projectId, database);
    await database.client.end();
  }
});
