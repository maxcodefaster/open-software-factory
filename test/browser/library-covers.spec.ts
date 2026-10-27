import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { chooseSettingsPage } from "../fixtures/settings-navigation";

test("owned Factory saves thirty-choice covers across reloads without changing content or MCP access", async ({
  page,
}) => {
  test.setTimeout(360_000);
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/skill-browser-host.ts"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const ready = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
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
    host.once("exit", () =>
      reject(new Error(`Owned cover browser host exited: ${stderr.slice(-3000)}`)),
    );
  });
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = fixture.databaseURL;
  const database = createDatabase(1);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  const directory = ".factory/test-results/library-covers/browser";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let loseResponseFor: string | undefined;
  const saves: string[] = [];
  await page.route("**/_server/**", async (route) => {
    const body = route.request().postData();
    if (
      route.request().method() === "POST" &&
      body?.includes('"expectedVersion"') &&
      body.includes('"key"')
    )
      saves.push(body);
    if (!loseResponseFor || !body?.includes(loseResponseFor)) return route.continue();
    loseResponseFor = undefined;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    return route.abort("failed");
  });
  async function openLibrary(name: "Skills" | "MCP connections") {
    const settings = page.getByRole("region", { name: "Settings", exact: true });
    if (!(await settings.isVisible())) {
      await page.goto(new URL("/settings", fixture.fixtureBase).href);
      await expect(settings).toBeVisible();
    }
    await chooseSettingsPage(page, name);
  }
  try {
    await mkdir(directory, { recursive: true });
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(fixture.fixtureBase);
    await page.getByLabel("Email", { exact: true }).fill(`owned-${fixture.id}@factory.local`);
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    for (const kind of ["skill", "mcp"] as const) {
      const name = `Owned ${kind} cover`;
      const libraryName = kind === "skill" ? "Skills" : "MCP connections";
      await page.setViewportSize({ width: 1440, height: 960 });
      await openLibrary(libraryName);
      if (kind === "skill") {
        await page.getByRole("button", { name: "Add skill", exact: true }).click();
        await page.getByLabel("Name", { exact: true }).fill(name);
        await page
          .getByLabel("When to use", { exact: true })
          .fill("Use for owned cover verification.");
        await page
          .getByLabel("Instructions", { exact: true })
          .fill("Retain these exact instructions.");
        await page.getByRole("button", { name: "Save skill", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Add MCP", exact: true }).click();
        await page.getByLabel("Name", { exact: true }).fill(name);
        await page.getByLabel("MCP endpoint", { exact: true }).fill("https://owned.example/mcp");
        await page
          .getByRole("combobox", { name: "Authentication", exact: true })
          .selectOption("none");
        await page.getByRole("button", { name: "Save definition", exact: true }).click();
      }
      const detail = page.getByRole("region", {
        name: kind === "skill" ? "Skill details" : "MCP details",
        exact: true,
      });
      await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
      const artwork = detail.locator(".skill-detail-heading > img");
      await expect(artwork).toHaveAttribute("src", /^\/art\/library\/.+\.webp$/);
      const initialURL = await artwork.getAttribute("src");
      if (!initialURL) throw new Error("Owned cover did not receive an illustration");
      const target = initialURL.includes("nested-arches") ? "woven-ribbons" : "nested-arches";
      const targetName = target === "nested-arches" ? "Nested arches" : "Woven ribbons";
      const change = detail.getByRole("button", { name: "Change cover", exact: true });
      const panel = detail.getByRole("region", { name: "Cover selection", exact: true });
      await change.click();
      await expect(panel.getByRole("radio")).toHaveCount(30);
      for (const image of await panel.locator("img").all()) {
        await image.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            image.evaluate(
              (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
            ),
          )
          .toBe(true);
      }
      await panel.getByRole("radio", { name: targetName, exact: true }).check();
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(change).toBeFocused();
      await expect(artwork).toHaveAttribute("src", initialURL);
      await change.click();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(detail).toBeVisible();
      await expect(change).toBeFocused();
      await change.click();
      await panel.getByRole("radio", { name: targetName, exact: true }).check();
      await panel.locator(".library-cover-options").evaluate((element) => {
        element.scrollTop = 0;
      });
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${directory}/${kind}-picker-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${directory}/${kind}-picker-mobile.png`, fullPage: true });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      const previousSaves = saves.length;
      loseResponseFor = target;
      await panel.getByRole("button", { name: "Save cover", exact: true }).click();
      await expect(panel.getByRole("alert")).toBeVisible();
      await expect(panel.getByRole("radio", { name: targetName, exact: true })).toBeChecked();
      await panel.getByRole("button", { name: "Save cover", exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(artwork).toHaveAttribute("src", `/art/library/${target}-${kind}.webp`);
      expect(saves.length - previousSaves).toBe(2);
      expect(saves.at(-1)).toBe(saves.at(-2));
      await detail.evaluate((element) => {
        element.scrollTop = 0;
      });
      await artwork.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${directory}/${kind}-saved-mobile.png`, fullPage: true });
      await page.goto(fixture.fixtureBase);
      await page.reload();
      await openLibrary(libraryName);
      if (!(await detail.getByRole("heading", { name, exact: true }).isVisible()))
        await page.getByRole("button", { name: `Inspect ${name}`, exact: true }).click();
      await expect(artwork).toHaveAttribute("src", `/art/library/${target}-${kind}.webp`);
      if (kind === "skill") {
        const [row] = await database.client`SELECT cover.version::float8 AS version,
          (SELECT count(*)::int FROM factory.skill_revision r WHERE r.skill_key=l.storage_key) AS revisions
          FROM factory.skill_library l JOIN factory.skill_library_cover cover ON cover.library_id=l.id
          WHERE EXISTS(SELECT 1 FROM factory.skill_revision r WHERE r.skill_key=l.storage_key AND r.content->>'name'=${name})`;
        expect(row).toMatchObject({ version: 2, revisions: 1 });
      } else {
        const [row] = await database.client`SELECT cover.version::float8 AS version,
          (SELECT count(*)::int FROM factory.mcp_revision r WHERE r.library_id=l.id) AS revisions,
          (SELECT count(*)::int FROM factory.mcp_connection c WHERE c.id=l.id) AS connections
          FROM factory.mcp_library l JOIN factory.mcp_library_cover cover ON cover.library_id=l.id
          WHERE EXISTS(SELECT 1 FROM factory.mcp_revision r WHERE r.library_id=l.id AND r.content->>'name'=${name})`;
        expect(row).toMatchObject({ version: 2, revisions: 1, connections: 0 });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await database.client.end();
    host.kill("SIGTERM");
    await new Promise<void>((resolve) => host.once("exit", () => resolve()));
  }
});
