import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { CommandError } from "../../apps/factory/src/command-error";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { skillLibraryView } from "../../packages/conversation-domain/src/skill-library";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserFunction, mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { fixtureValue } from "../fixtures/value";

test("skill gallery preserves discovery, private drafts, scoped choices, imports and reviewed sharing", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/skill-browser-host.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const fixture = await new Promise<z.infer<typeof ready>>((resolve, reject) => {
    const lines = createInterface({ input: host.stdout });
    lines.on("line", (line) => {
      if (line.startsWith('{"fixtureBase"')) {
        try {
          resolve(ready.parse(JSON.parse(line)));
        } catch (error) {
          reject(error);
        }
      }
    });
    host.once("exit", () => reject(new Error(`Owned browser host exited: ${stderr.slice(-2000)}`)));
  });
  const oldURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = fixture.databaseURL;
  const database = createDatabase(1);
  if (oldURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = oldURL;
  const options = { viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" as const };
  const authorContext = await browser.newContext(options);
  const managerContext = await browser.newContext(options);
  const author = await authorContext.newPage();
  const manager = await managerContext.newPage();
  const projectId = crypto.randomUUID();
  const projectName = `Skills proof ${projectId.slice(0, 8)}`;
  const evidence = ".factory/test-results/skill-gallery";
  const directory = resolve(evidence, `import-${projectId}`);
  const errors: string[] = [];
  const choiceRequests: unknown[] = [];
  let rejectChoice = false;
  for (const current of [page, author, manager])
    current.on("pageerror", (error) => errors.push(error.message));
  await mockFactoryFunctions(author, {
    skills: {
      async choose(_actor, input) {
        choiceRequests.push(input);
        if (rejectChoice) {
          rejectChoice = false;
          throw new CommandError(
            "conflict",
            "Skill choices changed elsewhere. Reload before saving.",
          );
        }
        return serverCall(browserFunction(author, "saveSkillChoice", [input]));
      },
      async previewRepository() {
        throw new CommandError(
          "unavailable",
          "Repository is unavailable. Check the source and try again.",
        );
      },
    },
  });
  async function login(current: Page, email: string, password: string) {
    await current.goto(fixture.fixtureBase);
    await current.getByLabel("Email", { exact: true }).fill(email);
    await current.getByLabel("Password", { exact: true }).fill(password);
    await current.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(current.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  }
  async function selectProject(current: Page) {
    await openProjectMenu(current);
    await current.getByRole("button", { name: new RegExp(projectName) }).click();
  }
  async function open(current: Page) {
    await current.getByRole("button", { name: "Settings", exact: true }).click();
    await current.getByRole("button", { name: "Open settings", exact: true }).click();
    const region = current.getByRole("region", { name: "Settings", exact: true });
    const navigation = region.getByRole("navigation", { name: "Settings navigation" });
    await chooseSettingsPage(current, "Skills");
    if (await navigation.isVisible()) {
      await expect(navigation.getByRole("button", { name: "Skills", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
    } else {
      await expect(region.getByRole("button", { name: "Choose settings page" })).toHaveText(
        "Skills",
      );
    }
    await expect(region.getByRole("searchbox", { name: "Search skills" })).toBeVisible();
    const library = region.locator(".skill-library:not(.mcp-library)");
    await expect(library.locator(".skill-library-status")).not.toHaveText("Loading skills…");
    return library;
  }
  const detail = (current: Page) =>
    current.getByRole("region", { name: "Skill details", exact: true });
  const libraryActions = (current: Page) =>
    current.locator("details").filter({
      has: current.locator('summary[aria-label="Library actions"]'),
    });
  async function libraryAction(current: Page, name: "Import" | "Manage") {
    const actions = libraryActions(current);
    const summary = actions.locator('summary[aria-label="Library actions"]');
    await expect(summary).toBeVisible();
    if (!(await actions.evaluate((element: HTMLDetailsElement) => element.open)))
      await summary.click();
    await actions.getByRole("button", { name, exact: true }).click();
  }
  async function filtersClosed(current: Page) {
    await expect(current.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
    await expect(current.getByRole("button", { name: "Filters", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    for (const name of ["Work type", "Ownership", "Availability"])
      await expect(current.getByRole("combobox", { name, exact: true })).toBeHidden();
  }
  async function setFilter(
    current: Page,
    name: "Work type" | "Ownership" | "Availability",
    value: string,
  ) {
    const toggle = current.getByRole("button", { name: "Filters", exact: true });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await current.getByRole("combobox", { name, exact: true }).selectOption(value);
  }
  async function coverLoaded(cover: Locator) {
    await expect(cover).toHaveCount(1);
    await cover.scrollIntoViewIfNeeded();
    await expect(cover).toBeVisible();
    await expect
      .poll(() =>
        cover.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    const size = await cover.boundingBox();
    if (!size) throw new Error("Skill book cover is not rendered");
    expect(size.width / size.height).toBeCloseTo(3 / 4, 2);
  }
  async function fullWidthReader(current: Page) {
    const library = current.locator(".skill-library:not(.mcp-library)");
    await expect(detail(current)).toBeVisible();
    await expect(current.getByRole("region", { name: "Skill gallery", exact: true })).toBeHidden();
    await expect(library.locator(".skill-gallery-scroll")).toBeHidden();
    await expect(current.getByRole("searchbox", { name: "Search skills" })).toBeHidden();
    await expect(library.locator(".skill-library-heading")).toBeHidden();
    await expect
      .poll(async () => {
        const readerWidth = await detail(current).evaluate(
          (element) => element.getBoundingClientRect().width,
        );
        const layoutWidth = await library
          .locator(".skill-library-layout")
          .evaluate((element) => element.getBoundingClientRect().width);
        return readerWidth / layoutWidth;
      })
      .toBeGreaterThan(0.9);
  }
  async function readView(current: Page) {
    return skillLibraryView.parse(
      await serverCall(browserFunction(current, "getSkillLibrary", [projectId])),
    );
  }
  async function noOverflow(current: Page) {
    await expect
      .poll(
        () => current.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        { message: `Page overflow at ${current.viewportSize()?.width}px` },
      )
      .toBeLessThanOrEqual(1);
    for (const target of [
      ".settings-content",
      ".skill-library:not(.mcp-library)",
      ".skill-gallery-detail:visible",
    ]) {
      const element = current.locator(target);
      if (await element.isVisible())
        await expect
          .poll(() => element.evaluate((node) => node.scrollWidth - node.clientWidth), {
            message: `${target} overflow at ${current.viewportSize()?.width}px`,
          })
          .toBeLessThanOrEqual(1);
    }
  }
  try {
    await mkdir(evidence, { recursive: true });
    await login(page, `owned-${fixture.id}@factory.local`, "owned-process-password-not-a-secret");
    const unbound = await open(page);
    await unbound.getByRole("button", { name: "Inspect Frontend design", exact: true }).click();
    await expect(
      detail(page).getByRole("combobox", { name: "Frontend design Build choice" }),
    ).toBeDisabled();
    await expect(detail(page)).toContainText("Select a Project to enable skills");

    const [admin] = await database.client<
      Array<{ id: string }>
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!admin) throw new Error("Owned admin missing");
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES (${projectId},${`skills-${projectId}`},${projectName},'https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${admin.id})`;
    const password = "owned-skill-browser-password";
    const authorEmail = `product-${projectId}@factory.local`;
    const managerEmail = `manager-${projectId}@factory.local`;
    for (const email of [authorEmail, managerEmail]) {
      const user = await browserFunction(page, "createAccount", [
        {
          name: email === authorEmail ? "Product author" : "Project manager",
          email,
          password,
        },
      ]);
      expect(user.ok).toBe(true);
      const member = await browserFunction(page, "saveProjectMember", [
        projectId,
        { email, role: "product-contributor", manageProject: email === managerEmail },
      ]);
      expect(member.ok).toBe(true);
    }
    await login(author, authorEmail, password);
    await selectProject(author);
    const library = await open(author);
    await expect(libraryActions(author)).toHaveJSProperty("open", false);
    await expect(
      libraryActions(author).getByRole("button", {
        name: "Import",
        exact: true,
        includeHidden: true,
      }),
    ).toBeHidden();
    await libraryActions(author).locator('summary[aria-label="Library actions"]').click();
    await expect(
      libraryActions(author).getByRole("button", { name: "Import", exact: true }),
    ).toBeVisible();
    await expect(
      library.getByRole("button", { name: "Manage", exact: true, includeHidden: true }),
    ).toHaveCount(0);
    await libraryActions(author).locator('summary[aria-label="Library actions"]').click();
    for (const viewport of [
      options.viewport,
      { width: 760, height: 860 },
      { width: 390, height: 844 },
    ]) {
      await author.setViewportSize(viewport);
      await expect(library.getByRole("searchbox", { name: "Search skills" })).toBeVisible();
      await filtersClosed(author);
    }
    await author.setViewportSize(options.viewport);
    const starterCards = library.locator("article.skill-gallery-card");
    await expect(starterCards).toHaveCount(7);
    for (const card of await starterCards.all()) {
      const name = await card.getAttribute("aria-label");
      if (!name) throw new Error("Starter cover missing its skill name");
      await expect(
        card.getByRole("button", { name: `Inspect ${name}`, exact: true }),
      ).toBeVisible();
      await coverLoaded(card.locator("img.skill-cover"));
      await expect(card.locator(".skill-tile-title")).toHaveText(name);
      await expect(card.locator(".skill-tile-description")).not.toHaveText("");
      await expect(
        card.locator(".skill-tile-metadata, .skill-tile-availability, .skill-state"),
      ).toHaveCount(0);
    }
    await library.locator(".skill-gallery-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await author.screenshot({ path: `${evidence}/gallery-desktop.png`, fullPage: true });
    for (const viewport of [
      { width: 1024, height: 900 },
      { width: 760, height: 860 },
      { width: 390, height: 844 },
      { width: 320, height: 844 },
    ]) {
      await author.setViewportSize(viewport);
      await noOverflow(author);
      await author.screenshot({
        path: `${evidence}/starter-gallery-${viewport.width}.png`,
        fullPage: true,
      });
    }
    await author.setViewportSize(options.viewport);
    await library.getByRole("button", { name: "Inspect Code review", exact: true }).click();
    await fullWidthReader(author);
    await author.screenshot({ path: `${evidence}/code-review-desktop.png`, fullPage: true });
    for (const width of [390, 320]) {
      await author.setViewportSize({ width, height: 844 });
      await noOverflow(author);
      await author.screenshot({
        path: `${evidence}/code-review-${width}.png`,
        fullPage: true,
      });
    }
    await detail(author).getByRole("button", { name: "Back to library", exact: true }).click();
    await author.setViewportSize({ width: 390, height: 844 });
    const lastSkill = library.getByRole("button", {
      name: "Inspect Verify completion",
      exact: true,
    });
    await lastSkill.scrollIntoViewIfNeeded();
    const previousScroll = await library
      .locator(".skill-gallery-scroll")
      .evaluate((element) => element.scrollTop);
    expect(previousScroll).toBeGreaterThan(0);
    await lastSkill.click();
    await detail(author).getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(lastSkill).toBeFocused();
    await expect
      .poll(() => library.locator(".skill-gallery-scroll").evaluate((element) => element.scrollTop))
      .toBe(previousScroll);
    await author.setViewportSize(options.viewport);
    await library.locator(".skill-gallery-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await setFilter(author, "Work type", "build");
    await expect(
      library.getByRole("article", { name: "Requirements interview", exact: true }),
    ).toHaveCount(0);
    await setFilter(author, "Work type", "all");
    await setFilter(author, "Work type", "planning");
    await setFilter(author, "Ownership", "system");
    await setFilter(author, "Availability", "enabled");
    await library.getByRole("searchbox", { name: "Search skills" }).fill("interview");
    const inspect = library.getByRole("button", {
      name: "Inspect Requirements interview",
      exact: true,
    });
    await inspect.focus();
    await author.keyboard.press("Enter");
    await expect(
      detail(author).getByRole("heading", { name: "Requirements interview", exact: true }),
    ).toBeFocused();
    await expect(detail(author).getByRole("article", { name: "Skill instructions" })).toBeVisible();
    await fullWidthReader(author);
    const starter = (await readView(author)).entries.find(
      (entry) => entry.revisions[0]?.content.name === "Requirements interview",
    );
    const origin = starter?.revisions[0]?.content.origin;
    if (!origin) throw new Error("Starter source missing");
    const sourceLink = detail(author).locator(`a[href=${JSON.stringify(origin.repository)}]`);
    await expect(sourceLink).toBeHidden();
    expect(await sourceLink.evaluate((element) => element.closest("details")?.open)).toBe(false);
    const starterCover = detail(author).locator("img").first();
    await coverLoaded(starterCover);
    await detail(author).evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(starterCover).toBeInViewport();
    await author.screenshot({ path: `${evidence}/starter-detail-desktop.png`, fullPage: true });
    await author.keyboard.press("Escape");
    await expect(inspect).toBeFocused();
    await expect(library.getByRole("searchbox", { name: "Search skills" })).toHaveValue(
      "interview",
    );
    await expect(library.getByRole("button", { name: "Filters", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await library.getByRole("button", { name: "Filters", exact: true }).click();
    await expect(library.getByRole("combobox", { name: "Work type", exact: true })).toHaveValue(
      "planning",
    );
    await expect(library.getByRole("combobox", { name: "Ownership", exact: true })).toHaveValue(
      "system",
    );
    await expect(library.getByRole("combobox", { name: "Availability", exact: true })).toHaveValue(
      "enabled",
    );
    expect(choiceRequests).toHaveLength(0);
    await library.getByRole("searchbox", { name: "Search skills" }).fill("nothing-matches-this");
    await expect(library.getByRole("heading", { name: "No matching skills" })).toBeVisible();
    await library.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(library.locator(".skill-gallery-card")).toHaveCount(7);

    const addSkill = library.getByRole("button", { name: "Add skill", exact: true });
    await expect(addSkill).toHaveText("Add skill");
    await addSkill.click();
    const editor = library.getByRole("form", { name: "Skill editor" });
    await expect(library.locator(".skill-library-heading")).toBeVisible();
    await expect(editor.getByRole("heading", { name: "New skill", exact: true })).toBeFocused();
    await editor.getByLabel("Name", { exact: true }).fill("Corporate design");
    await editor
      .getByLabel("When to use", { exact: true })
      .fill("Use when designing our product interfaces.");
    await editor
      .getByLabel("Instructions", { exact: true })
      .fill("Use our blue #1646a0 and generous spacing.");
    await editor.getByRole("button", { name: "Back to library", exact: true }).click();
    await library.getByRole("button", { name: "Resume draft", exact: true }).click();
    const navigation = author.getByRole("navigation", { name: "Settings navigation" });
    await navigation
      .locator("section")
      .filter({ has: author.getByRole("heading", { name: "Personal", exact: true }) })
      .getByRole("button", { name: "Login & security", exact: true })
      .click();
    await navigation.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Corporate design");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue(
      "Use our blue #1646a0 and generous spacing.",
    );
    await expect(editor.getByLabel("Available to", { exact: true })).toHaveValue("personal");
    await expect(library.locator(".skill-library-status")).not.toHaveText("Loading skills…");
    await editor.getByRole("heading", { name: "New skill", exact: true }).focus();
    await editor.evaluate((element) => {
      element.closest(".skill-editor-screen")?.scrollTo(0, 0);
    });
    await author.screenshot({ path: `${evidence}/editor-desktop.png`, fullPage: true });
    await editor.locator("summary").filter({ hasText: "Files, source & options" }).click();
    await editor.getByRole("button", { name: "Add reference", exact: true }).click();
    const reference = editor.getByLabel("references/note-1.md", { exact: true });
    await reference.fill("Our brand guidance. ");
    await reference.pressSequentially("Keep focus.");
    await expect(reference).toBeFocused();
    await editor.getByRole("button", { name: "Save skill", exact: true }).click();
    await expect(
      detail(author).getByRole("heading", { name: "Corporate design", exact: true }),
    ).toBeFocused();
    await detail(author).getByRole("button", { name: "Back to library", exact: true }).click();
    const customCard = library.getByRole("article", { name: "Corporate design", exact: true });
    await coverLoaded(customCard.locator("img.skill-cover"));
    await customCard.getByRole("button", { name: "Inspect Corporate design", exact: true }).click();
    const privateEntry = (await readView(author)).entries.find(
      (entry) => entry.revisions[0]?.content.name === "Corporate design",
    );
    if (!privateEntry) throw new Error("Private skill missing");
    expect(
      (await readView(author)).choices.some((choice) => choice.libraryId === privateEntry.id),
    ).toBe(false);
    const planningChoice = detail(author).getByRole("combobox", {
      name: "Corporate design Investigate & Plan choice",
    });
    rejectChoice = true;
    await planningChoice.selectOption("enable");
    await expect(library.getByRole("alert")).toContainText("changed elsewhere");
    await library.getByRole("button", { name: "Reload library", exact: true }).click();
    await expect(library.getByRole("alert")).toHaveCount(0);
    await planningChoice.selectOption("enable");
    await expect(library.locator(".skill-library-status")).toHaveText(
      "Choice saved for your new work in this Project",
    );
    expect(choiceRequests).toHaveLength(2);
    expect(choiceRequests[1]).toMatchObject({ scope: "personal", projectId, role: "planning" });
    await login(manager, managerEmail, password);
    await selectProject(manager);
    const managed = await open(manager);
    await expect(
      managed.getByRole("article", { name: "Corporate design", exact: true }),
    ).toHaveCount(0);
    expect(
      await browserFunction(manager, "getSkillRevision", [
        fixtureValue(privateEntry.revisions[0], "privateEntry.revisions[0]").id,
        projectId,
      ]),
    ).toMatchObject({ ok: false, status: 404 });
    await detail(author).locator("summary").filter({ hasText: "Share this skill" }).click();
    await detail(author).getByRole("button", { name: "Propose sharing", exact: true }).click();
    await expect(library.locator(".skill-library-status")).toHaveText(
      "Exact version proposed for sharing",
    );
    await expect(libraryActions(manager)).toHaveJSProperty("open", false);
    await expect(
      libraryActions(manager).getByRole("button", {
        name: "Manage",
        exact: true,
        includeHidden: true,
      }),
    ).toBeHidden();
    await libraryAction(manager, "Manage");
    await expect(managed.getByRole("button", { name: "Browse skills", exact: true })).toBeVisible();
    const managementScope = managed.getByRole("combobox", {
      name: "Manage defaults for",
      exact: true,
    });
    await expect(managementScope).toBeVisible();
    await expect(managementScope).toHaveValue("project");
    const queue = managed.getByRole("region", { name: "Sharing review queue" });
    await expect(queue).toBeVisible();
    await expect(
      queue.getByRole("button", { name: "Add to shared library", exact: true }),
    ).toBeDisabled();
    await queue.getByRole("button", { name: "Inspect proposed version", exact: true }).click();
    await expect(queue.getByRole("article", { name: "Skill instructions" })).toContainText(
      "#1646a0",
    );
    await queue.getByRole("button", { name: "Add to shared library", exact: true }).click();
    await detail(manager)
      .getByRole("combobox", { name: "Corporate design Investigate & Plan choice" })
      .selectOption("required");
    await expect(managed.locator(".skill-library-status")).toHaveText(
      "Default saved for new Project work",
    );
    await fullWidthReader(manager);
    await detail(manager).evaluate((element) => {
      element.scrollTop = 0;
    });
    await manager.screenshot({ path: `${evidence}/management-desktop.png`, fullPage: true });

    await author.reload();
    await open(author);
    await filtersClosed(author);
    await setFilter(author, "Ownership", "project");
    await library.getByRole("button", { name: "Inspect Corporate design", exact: true }).click();
    await expect(detail(author)).toContainText("Required by Project");
    await expect(
      detail(author).getByRole("combobox", { name: "Corporate design Investigate & Plan choice" }),
    ).toBeDisabled();
    await detail(author).getByRole("button", { name: "Back to library", exact: true }).click();
    await setFilter(author, "Ownership", "personal");
    await library.getByRole("button", { name: "Inspect Corporate design", exact: true }).click();
    await detail(author).getByRole("button", { name: "Edit skill", exact: true }).click();
    await editor.getByLabel("Instructions", { exact: true }).fill("Use our revised blue #1646b0.");
    await editor.getByRole("button", { name: "Save skill", exact: true }).click();
    await expect(detail(author).getByRole("article", { name: "Skill instructions" })).toContainText(
      "#1646a0",
    );
    await detail(author).locator("summary").filter({ hasText: "Update available" }).click();
    await detail(author)
      .getByRole("button", { name: "Use v2 for Investigate & Plan", exact: true })
      .click();
    await expect(
      detail(author).getByRole("article", { name: "Skill instructions" }).first(),
    ).toContainText("#1646b0");
    const updated = await readView(author);
    const shared = updated.entries.find(
      (entry) =>
        entry.scope === "project" && entry.revisions[0]?.content.name === "Corporate design",
    );
    expect(shared?.revisions[0]?.content.instructions).toBe(
      "Use our blue #1646a0 and generous spacing.",
    );
    await fullWidthReader(author);
    await detail(author).evaluate((element) => {
      element.scrollTop = 0;
    });
    await author.screenshot({ path: `${evidence}/detail-desktop.png`, fullPage: true });
    await author.setViewportSize({ width: 760, height: 860 });
    await fullWidthReader(author);
    await detail(author).evaluate((element) => {
      element.scrollTop = 0;
    });
    await noOverflow(author);
    await author.screenshot({ path: `${evidence}/detail-tablet.png`, fullPage: true });
    await author.setViewportSize({ width: 390, height: 844 });
    await fullWidthReader(author);
    await detail(author).evaluate((element) => {
      element.scrollTop = 0;
    });
    await noOverflow(author);
    await author.screenshot({ path: `${evidence}/detail-mobile.png`, fullPage: true });
    const instructionsBox = await detail(author)
      .getByRole("article", { name: "Skill instructions" })
      .boundingBox();
    const detailBox = await detail(author).boundingBox();
    expect(instructionsBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    if (instructionsBox && detailBox)
      expect(instructionsBox.y + instructionsBox.height).toBeLessThanOrEqual(
        detailBox.y + detailBox.height,
      );
    await expect(library.getByRole("region", { name: "Skill gallery" })).toBeHidden();
    await detail(author).getByRole("button", { name: "Back to library", exact: true }).click();
    await setFilter(author, "Ownership", "all");
    await library.getByRole("button", { name: "Filters", exact: true }).click();
    await filtersClosed(author);
    await noOverflow(author);
    const mobileCovers = library.locator(".skill-gallery-card img.skill-cover");
    expect(await mobileCovers.count()).toBeGreaterThanOrEqual(7);
    const coverBoxes = await mobileCovers.evaluateAll((images) =>
      images.map((image) => {
        const { x, y, width, height } = image.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    const [firstCover, secondCover, thirdCover] = coverBoxes;
    if (!firstCover || !secondCover || !thirdCover) throw new Error("Mobile covers missing");
    expect(firstCover.width).toBeGreaterThan(0);
    for (const cover of coverBoxes) expect(cover.width / cover.height).toBeCloseTo(3 / 4, 2);
    expect(secondCover.x).toBeGreaterThanOrEqual(firstCover.x + firstCover.width);
    expect(secondCover.y).toBeCloseTo(firstCover.y, 0);
    expect(thirdCover.x).toBeCloseTo(firstCover.x, 0);
    expect(thirdCover.y).toBeGreaterThan(firstCover.y);
    const cardBox = await library.locator(".skill-gallery-card").first().boundingBox();
    const scrollBox = await library.locator(".skill-gallery-scroll").boundingBox();
    expect(cardBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    if (cardBox && scrollBox)
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height);
    await author.screenshot({ path: `${evidence}/gallery-mobile.png`, fullPage: true });
    const mobileInspect = library
      .locator(".skill-gallery-card")
      .last()
      .getByRole("button", { name: /^Inspect / });
    await mobileInspect.scrollIntoViewIfNeeded();
    await mobileInspect.focus();
    const galleryScroll = library.locator(".skill-gallery-scroll");
    const savedScroll = await galleryScroll.evaluate((element) => element.scrollTop);
    expect(savedScroll).toBeGreaterThan(0);
    await mobileInspect.click();
    await fullWidthReader(author);
    await detail(author).getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(mobileInspect).toBeFocused();
    await expect
      .poll(() => galleryScroll.evaluate((element) => element.scrollTop))
      .toBeCloseTo(savedScroll, 0);
    await filtersClosed(author);
    await author.setViewportSize(options.viewport);

    await libraryAction(author, "Import");
    const importer = library.getByRole("region", { name: "Import a skill", exact: true });
    await expect(library.locator(".skill-library-heading")).toBeVisible();
    await expect(
      importer.getByRole("heading", { name: "Import a skill", exact: true }),
    ).toBeFocused();
    await expect(library.locator(".skill-library-status")).not.toContainText("saved");
    await importer.getByLabel("SKILL.md", { exact: true }).setInputFiles({
      name: "wrong.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Wrong file"),
    });
    await expect(importer.getByRole("alert")).toContainText("Choose SKILL.md");
    await importer.getByLabel("SKILL.md", { exact: true }).setInputFiles({
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "---\nname: imported-guide\ndescription: Use for a deliberate review.\n---\nRead the exact proposed change.",
      ),
    });
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("imported guide");
    await expect(editor.getByRole("heading", { name: "New skill", exact: true })).toBeFocused();
    await expect(editor.getByRole("button", { name: "Save skill", exact: true })).toBeDisabled();
    await editor
      .getByRole("checkbox", { name: "I reviewed these compatibility and source details" })
      .check();
    await editor.getByRole("button", { name: "Save skill", exact: true }).click();
    await expect(
      detail(author).getByRole("heading", { name: "imported guide", exact: true }),
    ).toBeVisible();
    const imported = (await readView(author)).entries.find(
      (entry) => entry.revisions[0]?.content.name === "imported guide",
    );
    expect(
      (await readView(author)).choices.some((choice) => choice.libraryId === imported?.id),
    ).toBe(false);
    await detail(author).getByRole("button", { name: "Back to library", exact: true }).click();
    await coverLoaded(
      library
        .getByRole("article", { name: "imported guide", exact: true })
        .locator("img.skill-cover"),
    );
    await libraryAction(author, "Import");
    await importer.getByRole("combobox", { name: "Import source" }).selectOption("directory");
    await mkdir(`${directory}/scripts`, { recursive: true });
    await writeFile(
      `${directory}/SKILL.md`,
      "---\nname: scripted-guide\ndescription: Use when running an explicit check.\n---\nRead scripts/check.sh before using it.",
    );
    await writeFile(`${directory}/scripts/check.sh`, "printf 'owned fixture only\\n'\n");
    await importer.getByLabel("Skill directory", { exact: true }).setInputFiles(directory);
    await expect(editor).toContainText("Build only");
    await editor.getByRole("button", { name: "Discard draft", exact: true }).click();
    await libraryAction(author, "Import");
    await importer.getByRole("combobox", { name: "Import source" }).selectOption("repository");
    await importer.getByLabel("Repository URL").fill("https://github.com/example/skills");
    await importer.getByLabel("Exact commit").fill("main");
    await importer.getByLabel("Skill path").fill("skills/review/SKILL.md");
    await importer.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(
      libraryActions(author).locator('summary[aria-label="Library actions"]'),
    ).toBeFocused();
    await expect(libraryActions(author)).toHaveJSProperty("open", false);
    await expect(
      libraryActions(author).getByRole("button", {
        name: "Import",
        exact: true,
        includeHidden: true,
      }),
    ).toBeHidden();
    await libraryAction(author, "Import");
    await expect(importer.getByRole("combobox", { name: "Import source" })).toHaveValue(
      "repository",
    );
    await expect(importer.getByLabel("Repository URL")).toHaveValue(
      "https://github.com/example/skills",
    );
    await expect(importer.getByLabel("Exact commit")).toHaveValue("main");
    await expect(importer.getByLabel("Skill path")).toHaveValue("skills/review/SKILL.md");
    expect(
      await importer
        .getByLabel("Exact commit")
        .evaluate((input: HTMLInputElement) => input.validity.valid),
    ).toBe(false);
    await importer.getByLabel("Exact commit").fill("a".repeat(40));
    await importer.getByRole("button", { name: "Preview import", exact: true }).click();
    await expect(importer.getByRole("alert")).toContainText("Repository is unavailable");
    await expect(library.locator(".skill-library-status")).not.toContainText("saved");
    await author.screenshot({ path: `${evidence}/import-error-desktop.png`, fullPage: true });
    await importer.getByRole("button", { name: "Back to library", exact: true }).click();
    await library.getByRole("searchbox", { name: "Search skills" }).fill("imported-guide");
    await expect(library.locator(".skill-gallery-card")).toHaveCount(1);
    await setFilter(author, "Availability", "enabled");
    await expect(library.getByRole("heading", { name: "No matching skills" })).toBeVisible();
    await library.getByRole("button", { name: "Clear filters", exact: true }).click();
    await noOverflow(author);
    expect(errors).toEqual([]);
    const [turns] = await database.client<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM factory.agent_turn WHERE project_id = ${projectId}`;
    expect(turns?.count).toBe(0);
  } finally {
    await authorContext.close();
    await managerContext.close();
    await database.client.end();
    await rm(directory, { recursive: true, force: true });
    const stopped = new Promise<void>((resolve) => host.once("exit", () => resolve()));
    host.kill("SIGTERM");
    await stopped;
  }
});
