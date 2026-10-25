import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserFunction } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";

test("MCP library uses landscape connection covers, retains private drafts and keeps definitions separate from activation", async ({
  page,
}) => {
  test.setTimeout(360_000);
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
    host.once("exit", () => reject(new Error(`Owned browser host exited: ${stderr.slice(-3000)}`)));
  });
  const errors: string[] = [];
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = fixture.databaseURL;
  const database = createDatabase(1);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  page.on("pageerror", (error) => errors.push(error.message));
  const evidence = ".factory/test-results/mcp-library";
  async function expectConnectionCovers() {
    const covers = page.locator(".mcp-cover:visible");
    expect(await covers.count()).toBeGreaterThan(0);
    for (const cover of await covers.all()) {
      await expect(cover).toHaveAttribute("src", /^\/art\/mcp\/.*\.webp$/);
      await expect(cover).toHaveJSProperty("naturalWidth", 768);
      await expect(cover).toHaveJSProperty("naturalHeight", 512);
      const size = await cover.boundingBox();
      if (!size) throw new Error("Connection cover is not rendered");
      expect(size.width / size.height).toBeCloseTo(1.5, 1);
    }
  }
  async function open() {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Settings navigation" });
    await chooseSettingsPage(page, "MCP connections");
    await expect(page.getByRole("heading", { name: "MCP connections", exact: true })).toBeVisible();
    if (await navigation.isVisible())
      await expect(
        navigation.getByRole("button", { name: "MCP connections", exact: true }),
      ).toHaveAttribute("aria-current", "page");
    else
      await expect(page.getByRole("button", { name: "Choose settings page" })).toHaveText(
        "MCP connections",
      );
    await expect(page.getByRole("status")).not.toContainText("Loading connections");
  }
  try {
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(fixture.fixtureBase);
    await page.getByLabel("Email", { exact: true }).fill(`owned-${fixture.id}@factory.local`);
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await open();
    await expect(page.locator(".mcp-library").getByRole("heading")).toHaveText(["MCP connections"]);
    await expect(page.getByRole("button", { name: "Set up Sentry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up Datadog" })).toBeVisible();
    await expectConnectionCovers();
    await expect(page.getByRole("button", { name: "Set up Sentry" })).toContainText(
      "mcp.sentry.dev",
    );
    await page.screenshot({ path: `${evidence}/gallery-desktop.png`, fullPage: true });
    await page
      .getByRole("region", { name: "Recommended MCP connections", exact: true })
      .screenshot({ path: `${evidence}/connection-cards-desktop.png` });
    await page.getByRole("button", { name: "Set up Sentry" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Owned MCP source");
    await page.getByLabel("MCP endpoint", { exact: true }).fill("http://unsafe.example/mcp");
    await page.getByRole("button", { name: "Save definition", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("HTTPS");
    await page.getByLabel("MCP endpoint", { exact: true }).fill("https://source.example/mcp");
    await page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "MCP connections", exact: true })
      .click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Owned MCP source");
    await page.getByRole("button", { name: "Save definition", exact: true }).click();
    const detail = page.getByRole("region", { name: "MCP details", exact: true });
    await expect(
      detail.getByRole("heading", { name: "Owned MCP source", exact: true }),
    ).toBeVisible();
    await expect(detail).toContainText("Not connected");
    await expect(detail).toContainText("Select a Project to enable connections");
    await expect(
      detail.getByRole("combobox", { name: "Owned MCP source Build choice" }),
    ).toBeDisabled();
    await expect(page.getByRole("region", { name: "MCP gallery" })).toBeHidden();
    await expectConnectionCovers();
    await page.screenshot({ path: `${evidence}/detail-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: `${evidence}/detail-mobile.png`, fullPage: true });
    const overflow = await detail.evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
      overflowing: [...element.querySelectorAll("*")]
        .filter(
          (child) =>
            child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1,
        )
        .map((child) => ({
          tag: child.tagName,
          class: child.className,
          text: child.textContent?.slice(0, 100),
          width: child.getBoundingClientRect().width,
        })),
    }));
    expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width + 1);
    await detail.getByRole("button", { name: "Back to library", exact: true }).click();
    await page
      .getByRole("searchbox", { name: "Search MCP connections" })
      .fill("no matching source");
    await expect(page.getByRole("heading", { name: "No matching connections" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page.getByRole("button", { name: "Inspect Owned MCP source" })).toBeVisible();
    await expectConnectionCovers();
    await expect(page.getByRole("button", { name: "Inspect Owned MCP source" })).toContainText(
      "source.example",
    );
    await page.getByRole("button", { name: "Inspect Owned MCP source" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      detail.getByRole("heading", { name: "Owned MCP source", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Inspect Owned MCP source" })).toBeFocused();
    await page.screenshot({ path: `${evidence}/gallery-mobile.png`, fullPage: true });
    const view = await serverCall(browserFunction(page, "getMCPLibrary", []));
    expect(view.entries).toHaveLength(1);
    expect(view.choices).toHaveLength(0);
    expect(view.entries[0]!.connection).toBeNull();
    await page.reload();
    await open();
    await expect(page.getByRole("button", { name: "Inspect Owned MCP source" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 960 });
    const project = crypto.randomUUID();
    const projectName = `MCP proof ${project.slice(0, 8)}`;
    const [manager] = await database.client<
      Array<{ id: string }>
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!manager) throw new Error("Owned fixture manager is missing");
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`mcp-ui-${project}`},${projectName},'https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager.id})`;
    const sharedId = crypto.randomUUID();
    const sharedRevision = crypto.randomUUID();
    expect(
      await browserFunction(page, "saveMCPDefinition", [
        {
          libraryId: sharedId,
          revisionId: sharedRevision,
          expectedRevision: 0,
          scope: "system",
          content: {
            name: "Owned shared source",
            description: "Synthetic read-only connection for the owned browser proof.",
            endpoint: "https://source.example/mcp",
            authentication: "none",
            provider: "custom",
            roles: ["planning", "build"],
          },
        },
      ]),
    ).toMatchObject({ ok: true });
    // This UI fixture seeds discovery only, never a provider delivery. The
    // separate SDK/controller and live lanes exercise actual connections.
    const tools = [
      {
        name: "read_issue",
        description: "Read a synthetic owned issue.",
        inputSchema: { type: "object", properties: {} },
        digest: "a".repeat(64),
        readOnlyHint: true,
      },
      {
        name: "delete_issue",
        description: "Synthetic write tool. Do not approve.",
        inputSchema: { type: "object", properties: {} },
        digest: "b".repeat(64),
        readOnlyHint: false,
      },
    ];
    await database.client`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,tools,authorized_by)
      VALUES(${sharedId},${sharedRevision},'review',1,${crypto.randomUUID()},${JSON.stringify(tools)}::jsonb,${manager.id})`;
    await openProjectMenu(page);
    await page.getByRole("button", { name: new RegExp(projectName) }).click();
    await open();
    await expectConnectionCovers();
    await page.screenshot({ path: `${evidence}/sources-desktop.png`, fullPage: true });
    await page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await expect(page.locator(".skill-cover:visible").first()).toHaveAttribute(
      "src",
      /^\/art\/skills\//,
    );
    for (const cover of await page.locator(".skill-cover:visible").all()) {
      await expect
        .poll(() => cover.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      const size = await cover.boundingBox();
      if (!size) throw new Error("Skill book cover is not rendered");
      expect(size.width / size.height).toBeCloseTo(3 / 4, 2);
    }
    await page.screenshot({ path: `${evidence}/skills-comparison-desktop.png`, fullPage: true });
    await page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "MCP connections", exact: true })
      .click();
    await page.getByRole("button", { name: "Inspect Owned shared source", exact: true }).click();
    const review = page.getByRole("region", { name: "Read-only tool review", exact: true });
    await expect(review).toBeVisible();
    const buildChoice = page.getByRole("combobox", { name: "Owned shared source Build choice" });
    await expect(buildChoice.locator('option[value="enable"]')).toHaveAttribute("disabled", "");
    await expect(
      page.getByText("Connect and approve read-only access before enabling.").first(),
    ).toBeVisible();
    await review.getByText("Input schema", { exact: true }).first().click();
    await expect(review.locator("pre").first()).toContainText('"type": "object"');
    await expect(
      page.getByRole("button", { name: "Grant Project access", exact: true }),
    ).toBeDisabled();
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/tool-review-desktop.png`, fullPage: true });
    await review.getByRole("checkbox", { name: /^read_issue/ }).check();
    await expect(review.getByRole("checkbox", { name: /^delete_issue/ })).not.toBeChecked();
    await expect(review.getByRole("button", { name: "Approve read-only access" })).toBeDisabled();
    await review.getByRole("checkbox", { name: /I verified/ }).check();
    await review.getByRole("button", { name: "Approve read-only access" }).click();
    await expect(page.getByRole("region", { name: "MCP connection", exact: true })).toContainText(
      "Connected",
    );
    await expect(buildChoice.locator('option[value="enable"]')).toHaveAttribute("disabled", "");
    await expect(
      page.getByText("Grant this Project access before enabling.").first(),
    ).toBeVisible();
    await page.getByRole("region", { name: "MCP availability" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/activation-blocked-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("region", { name: "MCP availability" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/activation-blocked-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    const grant = page.getByRole("region", { name: "Project connection access", exact: true });
    await grant.getByRole("button", { name: "Grant Project access", exact: true }).click();
    await expect(
      grant.getByRole("button", { name: "Revoke Project access", exact: true }),
    ).toBeVisible();
    await expect(buildChoice.locator('option[value="enable"]')).not.toHaveAttribute("disabled");
    await detail
      .getByRole("combobox", { name: "Owned shared source Build choice", exact: true })
      .selectOption("enable");
    await detail.getByRole("button", { name: "Back to library", exact: true }).click();
    await page.locator('summary[aria-label="MCP library actions"]').click();
    await page.getByRole("button", { name: "Manage", exact: true }).click();
    await expect(
      page
        .locator("details")
        .filter({ has: page.locator('summary[aria-label="MCP library actions"]') }),
    ).not.toHaveAttribute("open", "");
    await expect(page.getByLabel("Manage defaults for")).toHaveValue("project");
    await page.getByRole("button", { name: "Inspect Owned shared source", exact: true }).click();
    await detail
      .getByRole("combobox", { name: "Owned shared source Build choice", exact: true })
      .selectOption("required");
    await detail.getByRole("button", { name: "Back to library", exact: true }).click();
    await page.getByRole("button", { name: "Browse connections", exact: true }).click();
    await page.getByRole("button", { name: "Inspect Owned shared source", exact: true }).click();
    await expect(
      detail.getByRole("combobox", { name: "Owned shared source Build choice", exact: true }),
    ).toBeDisabled();
    await expect(detail).toContainText("Required by Project policy");
    await grant.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/granted-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await grant.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/granted-mobile.png`, fullPage: true });
    const sharedView = await serverCall(browserFunction(page, "getMCPLibrary", [project]));
    const currentEntry = sharedView.entries.find((item) => item.id === sharedId);
    if (!currentEntry) throw new Error("Owned shared MCP definition missing");
    expect(currentEntry.connection?.allowedTools).toEqual(["read_issue"]);
    // A reconnected definition may be ready before the replacement account is
    // granted to this Project. Version adoption must obey the same gate.
    const nextRevision = crypto.randomUUID();
    expect(
      await browserFunction(page, "saveMCPChoice", [
        {
          libraryId: sharedId,
          revisionId: sharedRevision,
          scope: "project",
          projectId: project,
          role: "build",
          state: "inherit",
          expectedVersion: 1,
        },
      ]),
    ).toMatchObject({ ok: true });
    expect(
      await browserFunction(page, "saveMCPDefinition", [
        {
          libraryId: sharedId,
          revisionId: nextRevision,
          expectedRevision: 1,
          scope: "system",
          content: {
            ...currentEntry.revisions[0]!.content,
            description: "Synthetic replacement account.",
          },
        },
      ]),
    ).toMatchObject({ ok: true });
    await database.client`UPDATE factory.mcp_connection SET revision_id=${nextRevision},credential_epoch=${crypto.randomUUID()},
      version=version+1 WHERE id=${sharedId}`;
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 960 });
    await open();
    await page.getByRole("button", { name: "Inspect Owned shared source", exact: true }).click();
    const adopt = page.getByRole("button", { name: "Use connected v2 for new work", exact: true });
    await expect(adopt).toBeDisabled();
    await adopt.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/adoption-blocked-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await adopt.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/adoption-blocked-mobile.png`, fullPage: true });
    await page.getByRole("button", { name: "Grant Project access", exact: true }).click();
    await expect(adopt).toBeEnabled();
    await adopt.click();
    await expect(adopt).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await database.client.end();
    host.kill("SIGTERM");
    await new Promise<void>((resolve) => host.once("exit", () => resolve()));
  }
});
