import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { skillLibraryView } from "../../packages/conversation-domain/src/skill-library";
import { createDatabase } from "../../packages/db/src/client";

test("product contributors author corporate guidance; managers review sharing and per-skill inheritance", async ({
  page,
  browser,
}) => {
  const host = spawn("mise", ["exec", "--", "bun", "test/fixtures/skill-browser-host.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  const authorContext = await browser.newContext();
  const managerContext = await browser.newContext();
  const author = await authorContext.newPage();
  const manager = await managerContext.newPage();
  const projectId = crypto.randomUUID();
  const projectName = `Skills proof ${projectId.slice(0, 8)}`;
  const errors: string[] = [];
  for (const current of [page, author, manager])
    current.on("pageerror", (error) => errors.push(error.message));
  async function login(current: Page, email: string, password: string) {
    await current.goto(fixture.fixtureBase);
    await current.getByLabel("Email", { exact: true }).fill(email);
    await current.getByLabel("Password", { exact: true }).fill(password);
    await current.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(current.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  }
  async function selectProject(current: Page) {
    await current.getByRole("button", { name: "Open project menu" }).click();
    await current.getByRole("button", { name: new RegExp(projectName) }).click();
  }
  async function open(current: Page, group: string) {
    await current.getByRole("button", { name: "Settings", exact: true }).click();
    await current.getByRole("button", { name: "Open settings", exact: true }).click();
    const region = current.getByRole("region", { name: "Settings", exact: true });
    await region
      .getByRole("navigation", { name: "Settings navigation" })
      .locator("section")
      .filter({ has: current.getByRole("heading", { name: group, exact: true }) })
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await expect(region.getByRole("searchbox", { name: "Search skills" })).toBeVisible();
    return region;
  }
  try {
    await login(page, `owned-${fixture.id}@factory.local`, "owned-process-password-not-a-secret");
    const [admin] = await database.client<
      Array<{ id: string }>
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!admin) throw new Error("Owned admin missing");
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES (${projectId},${`skills-${projectId}`},${projectName},'https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${admin.id})`;
    const password = "owned-skill-browser-password";
    const authorEmail = `product-${projectId}@factory.local`,
      managerEmail = `manager-${projectId}@factory.local`;
    for (const email of [authorEmail, managerEmail]) {
      const user = await page.request.post(`${fixture.fixtureBase}/api/admin/users`, {
        headers: { origin: fixture.fixtureBase },
        data: {
          name: email === authorEmail ? "Product author" : "Project manager",
          email,
          password,
        },
      });
      expect(user.status()).toBe(201);
      const member = await page.request.post(
        `${fixture.fixtureBase}/api/projects/${projectId}/members`,
        {
          headers: { origin: fixture.fixtureBase },
          data: { email, role: "product-contributor", manageProject: email === managerEmail },
        },
      );
      expect(member.ok()).toBe(true);
    }
    await login(author, authorEmail, password);
    await selectProject(author);
    const personal = await open(author, "Personal");
    await personal
      .getByRole("combobox", { name: "Choices for", exact: true })
      .selectOption("build");
    const interviewSkill = personal.getByRole("article", {
      name: "Requirements interview",
      exact: true,
    });
    await expect(interviewSkill).toContainText("Investigate & Plan only");
    await expect(interviewSkill).not.toContainText("Build only");
    await personal
      .getByRole("combobox", { name: "Choices for", exact: true })
      .selectOption("planning");
    await expect(personal.getByRole("button", { name: "New skill", exact: true })).toBeVisible();
    await personal.getByRole("button", { name: "New skill", exact: true }).click();
    const editor = personal.getByRole("form", { name: "Skill editor" });
    await editor.getByLabel("Name", { exact: true }).fill("Corporate design");
    await editor
      .getByLabel("When to use", { exact: true })
      .fill("Use when designing our product interfaces.");
    await editor
      .getByLabel("Instructions", { exact: true })
      .fill("Use our blue #1646a0 and generous spacing.");
    const navigation = personal.getByRole("navigation", { name: "Settings navigation" });
    const personalNavigation = navigation.locator("section").filter({
      has: author.getByRole("heading", { name: "Personal", exact: true }),
    });
    await personalNavigation.getByRole("button", { name: "Login & security", exact: true }).click();
    await personalNavigation.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Corporate design");
    await expect(editor.getByLabel("Instructions", { exact: true })).toHaveValue(
      "Use our blue #1646a0 and generous spacing.",
    );
    await expect(editor.getByLabel("Available to", { exact: true })).toHaveValue("personal");
    await mkdir(".factory/test-results", { recursive: true });
    await personal.locator(".settings-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await author.screenshot({
      path: ".factory/test-results/skills-editor-simple-implemented.png",
      fullPage: true,
    });
    await editor.locator("summary").filter({ hasText: "Files, source & options" }).click();
    await editor.getByRole("button", { name: "Add reference", exact: true }).click();
    const reference = editor.getByLabel("references/note-1.md", { exact: true });
    await reference.fill("Our brand guidance. ");
    await reference.pressSequentially("Keep focus.");
    await expect(reference).toBeFocused();
    await mkdir(".factory/test-results", { recursive: true });
    await author.screenshot({
      path: ".factory/test-results/skills-editor-implemented.png",
      fullPage: true,
    });
    await editor.getByRole("button", { name: "Save skill", exact: true }).click();
    const card = personal.getByRole("article", { name: "Corporate design", exact: true });
    await expect(card).toBeVisible();
    await card.getByRole("combobox", { name: "Corporate design choice" }).selectOption("enable");
    await expect(personal.getByRole("status")).toHaveText("Choice saved for new work");
    const firstView = skillLibraryView.parse(
      await (
        await author.request.get(`${fixture.fixtureBase}/api/skills?project=${projectId}`)
      ).json(),
    );
    const privateEntry = firstView.entries.find(
      (entry) => entry.revisions[0]?.content.name === "Corporate design",
    );
    if (!privateEntry) throw new Error("Personal skill missing");
    await login(manager, managerEmail, password);
    await selectProject(manager);
    const shared = await open(manager, projectName);
    await expect(
      shared.getByRole("article", { name: "Corporate design", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await manager.request.get(
          `${fixture.fixtureBase}/api/skills/revisions/${privateEntry.revisions[0]?.id}?project=${projectId}`,
        )
      ).status(),
    ).toBe(404);
    await card.getByRole("button", { name: "Propose sharing", exact: true }).click();
    await expect(personal.getByRole("status")).toHaveText("Exact version proposed for sharing");
    // Scope navigation refreshes the shared review queue without discarding an editor.
    await shared
      .getByRole("navigation", { name: "Settings navigation" })
      .locator("section")
      .filter({ has: manager.getByRole("heading", { name: "Personal", exact: true }) })
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await shared
      .getByRole("navigation", { name: "Settings navigation" })
      .locator("section")
      .filter({ has: manager.getByRole("heading", { name: projectName, exact: true }) })
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await shared.getByRole("button", { name: "Inspect proposed version", exact: true }).click();
    await shared.getByRole("button", { name: "Add to shared library", exact: true }).click();
    const sharedCard = shared.getByRole("article", { name: "Corporate design", exact: true });
    await expect(sharedCard).toBeVisible();
    await sharedCard
      .getByRole("combobox", { name: "Corporate design choice" })
      .selectOption("required");
    await expect(shared.getByRole("status")).toHaveText("Choice saved for new work");
    await author.reload();
    const refreshed = await open(author, "Personal");
    const required = refreshed
      .getByRole("article", { name: "Corporate design", exact: true })
      .filter({ has: author.locator(".skill-card-heading small").filter({ hasText: /^Project/ }) });
    await expect(
      required.getByRole("combobox", { name: "Corporate design choice" }),
    ).toBeDisabled();
    const own = refreshed
      .getByRole("article", { name: "Corporate design", exact: true })
      .filter({ hasText: "Only me" });
    await own.getByRole("button", { name: "Edit", exact: true }).click();
    await refreshed
      .getByRole("form", { name: "Skill editor" })
      .getByLabel("Instructions", { exact: true })
      .fill("Use our revised blue #1646b0.");
    await refreshed.getByRole("button", { name: "Save skill", exact: true }).click();
    await own.getByText("Update available", { exact: false }).click();
    await own.getByRole("button", { name: "Use this version", exact: true }).click();
    await expect(refreshed.getByRole("status")).toHaveText("Choice saved for new work");
    await author.screenshot({
      path: ".factory/test-results/skills-library-implemented.png",
      fullPage: true,
    });
    await author.setViewportSize({ width: 760, height: 860 });
    await author.screenshot({
      path: ".factory/test-results/skills-library-implemented-narrow.png",
      fullPage: true,
    });
    expect(
      await personal
        .locator(".settings-content")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await authorContext.close();
    await managerContext.close();
    await database.client.end();
    host.kill("SIGTERM");
    await new Promise<void>((resolve) => host.once("exit", () => resolve()));
  }
});
