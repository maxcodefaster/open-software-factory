import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { z } from "zod";
import { desktopBackgrounds } from "../../apps/factory/src/artworks";
import { CommandError } from "../../apps/factory/src/command-error";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserFunction, mockFactoryFunctions } from "../fixtures/server-functions";
import { luminance } from "../support/visual-contrast";
import { fixtureValue } from "../fixtures/value";

test("Project backgrounds stay shared and persistent with a compact, expandable artwork picker", async ({
  page,
  browser,
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
      if (!line.startsWith('{"fixtureBase"')) return;
      try {
        resolve(ready.parse(JSON.parse(line)));
      } catch (cause) {
        reject(cause);
      }
    });
    host.once("exit", () => reject(new Error(`Owned browser host exited: ${stderr.slice(-3000)}`)));
  });
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = fixture.databaseURL;
  const database = createDatabase(3);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  const evidence = ".factory/test-results/compact-wallpapers/browser";
  const projectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const errors: string[] = [];
  const observerContext = await browser.newContext({ reducedMotion: "reduce" });
  const observer = await observerContext.newPage();
  for (const target of [page, observer]) {
    target.on("pageerror", (error) => errors.push(error.message));
    await mockFactoryFunctions(target, {
      workspaces: {
        ensurePersonalSource: async () => {
          throw new CommandError("unavailable", "Planning-only wallpaper fixture");
        },
      },
    });
    await mockFactoryFunctions(target, {
      workspaces: {
        ensureEditor: async () => {
          throw new CommandError("unavailable", "Planning-only wallpaper fixture");
        },
      },
    });
  }
  const desktop = (target: Page) => target.locator("main.factory-desktop");
  const picker = (target: Page) => target.getByRole("group", { name: "Project background" });
  const choices = (target: Page) =>
    picker(target).locator(".background-options").getByRole("button");
  const expand = (target: Page) =>
    picker(target).getByRole("button", { name: "Show all 6 backgrounds", exact: true });
  const collapse = (target: Page) =>
    picker(target).getByRole("button", { name: "Show fewer backgrounds", exact: true });
  const signIn = async (target: Page, email: string) => {
    await target.goto(fixture.fixtureBase);
    await target.getByLabel("Email", { exact: true }).fill(email);
    await target
      .getByLabel("Password", { exact: true })
      .fill("owned-process-password-not-a-secret");
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(desktop(target)).toBeVisible();
  };
  const selectProject = async (target: Page, slug: string) => {
    if (!(await target.getByRole("button", { name: "Open project menu", exact: true }).isVisible()))
      await target.getByRole("button", { name: "Settings", exact: true }).click();
    await openProjectMenu(target);
    await target
      .getByRole("region", { name: "Projects" })
      .getByRole("button")
      .filter({ hasText: slug })
      .click();
    await expect(target.locator(".project-menu")).toBeHidden();
  };
  const read = async (id: string) => {
    const [row] = await database.client<{ key: string }[]>`
      SELECT desktop_background_key AS key FROM factory.project WHERE id=${id}`;
    return row?.key;
  };
  let releaseMutation: (() => void) | undefined;
  let heldSave: Promise<unknown> | undefined;
  async function cleanup() {
    releaseMutation?.();
    const cleanups = await Promise.allSettled([
      heldSave,
      observerContext.close(),
      database.client.end(),
    ]);
    if (host.exitCode === null) {
      const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
      host.kill("SIGTERM");
      await exited;
    }
    for (const result of cleanups) if (result.status === "rejected") throw result.reason;
  }
  try {
    await mkdir(evidence, { recursive: true });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await signIn(page, `owned-${fixture.id}@factory.local`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(picker(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const [administrator] = await database.client<{ id: string }[]>`
      SELECT user_id AS id FROM factory.administrator`;
    if (!administrator) throw new Error("Owned administrator missing");
    for (const [id, slug, name, background] of [
      [projectId, "coastal-studio", "Coastal Studio", "river-landscape"],
      [otherProjectId, "harvest-studio", "Harvest Studio", "the-harvesters"],
    ]) {
      await database.client`INSERT INTO factory.project(
        id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
        VALUES(${fixtureValue(id, "id")},${fixtureValue(slug, "slug")},${fixtureValue(name, "name")},'https://example.invalid/wallpapers.git','main',
          '.devcontainer/devcontainer.json',${administrator.id},${fixtureValue(background, "background")})`;
      await database.client`INSERT INTO factory.ticket(id,project_id,title,description,created_by)
        VALUES(${crypto.randomUUID()},${fixtureValue(id, "id")},'Give each Project a familiar workspace',
          'Keep the shared background stable between visits.',${administrator.id})`;
    }
    const contributorEmail = `contributor-${fixture.id}@background.test`;
    const memberResponse = await serverCall(
      browserFunction(page, "createAccount", [
        {
          name: "Mara Fischer",
          email: contributorEmail,
          password: "owned-process-password-not-a-secret",
        },
      ]),
    );
    const member = z.object({ id: z.uuid() }).parse(memberResponse);
    for (const id of [projectId, otherProjectId])
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${id},${member.id},'product-contributor',false,${administrator.id})`;
    const preferences = await database.client`SELECT * FROM factory.user_ui_preference`;
    await page.reload();
    await selectProject(page, "coastal-studio");
    await signIn(observer, contributorEmail);
    await selectProject(observer, "coastal-studio");
    await observer.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(choices(observer)).toHaveCount(2);
    await expect(choices(observer).first()).toContainText("River Landscape");
    await expect(picker(observer)).toContainText("Only project managers can change it.");
    await expect(expand(observer)).toBeEnabled();
    await expand(observer).click();
    await expect(choices(observer)).toHaveCount(6);
    for (const button of await choices(observer).all()) await expect(button).toBeDisabled();
    await observer.getByRole("button", { name: "Settings", exact: true }).click();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(choices(page)).toHaveCount(2);
    await expect(choices(page).first()).toBeFocused();
    await expect(picker(page).locator(".background-peek")).toHaveAttribute("aria-hidden", "true");
    await expect(expand(page)).toHaveAttribute("aria-controls", "background-options");
    await page.screenshot({ path: `${evidence}/picker-desktop-collapsed.png`, fullPage: true });
    await page.keyboard.press("End");
    await expect(expand(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(collapse(page)).toHaveAttribute("aria-expanded", "true");
    await expect(choices(page)).toHaveCount(6);
    await expect(picker(page).locator(".background-peek")).toHaveCount(0);
    await page.keyboard.press("ArrowUp");
    await expect(choices(page).last()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(choices(page)).toHaveCount(2);
    await expect(expand(page)).toHaveAttribute("aria-expanded", "false");
    await expect(expand(page)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(choices(page).nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();

    let currentBackground = "river-landscape";
    for (const background of desktopBackgrounds) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(picker(page)).toContainText("Shared with everyone in Coastal Studio.");
      await expect(choices(page)).toHaveCount(2);
      await expect(choices(page).first()).toHaveClass(
        new RegExp(`background-${currentBackground}`),
      );
      await expect(choices(page).first()).toHaveAttribute("aria-pressed", "true");
      await expand(page).click();
      const orderBeforeSelection = await choices(page).allTextContents();
      await choices(page).filter({ hasText: background.title }).click();
      await expect(desktop(page)).toHaveAttribute("data-background", background.key);
      await expect.poll(() => read(projectId)).toBe(background.key);
      await expect(desktop(observer)).toHaveAttribute("data-background", background.key);
      await expect.poll(() => read(otherProjectId)).toBe("the-harvesters");
      await expect(choices(page).filter({ hasText: background.title })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(picker(page)).toHaveAttribute("aria-busy", "false");
      expect(await choices(page).allTextContents()).toEqual(orderBeforeSelection);
      currentBackground = background.key;
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const colors = await desktop(page).evaluate(async (element) => {
        const style = getComputedStyle(element);
        const path = style
          .getPropertyValue("--desktop-art")
          .match(/url\(["']?([^"')]+)["']?\)/)?.[1];
        if (!path) throw new Error("Project artwork is absent");
        const image = new Image();
        image.src = path;
        await image.decode();
        return {
          path,
          width: image.naturalWidth,
          accent: style.getPropertyValue("--color-river-deep").trim(),
          inverse: style.getPropertyValue("--color-ink-inverse").trim(),
          surface: style.getPropertyValue("--surface-rgb").trim(),
          muted: style.getPropertyValue("--color-ink-muted").trim(),
          alpha:
            Number(style.getPropertyValue("--material-window").match(/\/\s*([\d.]+)%/)?.[1]) / 100,
        };
      });
      expect(colors.path).toBe(background.image);
      expect(colors.width).toBe(2560);
      const hex = (value: string) =>
        [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
      expect(
        (luminance(hex(colors.inverse)) + 0.05) / (luminance(hex(colors.accent)) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
      const darkestSurface = colors.surface.split(" ").map((value) => Number(value) * colors.alpha);
      expect(
        (luminance(darkestSurface) + 0.05) / (luminance(hex(colors.muted)) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({ path: `${evidence}/${background.key}-desktop.png`, fullPage: true });
    }

    // A slow save belongs to its original Project even after navigating elsewhere.
    const held = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    releaseMutation = released.resolve;
    heldSave = database.client.begin(async (transaction) => {
      await transaction`SELECT id FROM factory.project WHERE id=${projectId} FOR UPDATE`;
      held.resolve();
      await released.promise;
    });
    await held.promise;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(choices(page).first()).toContainText("Moonlit Landscape");
    await expand(page).click();
    const orderBeforeSave = await choices(page).allTextContents();
    await choices(page).filter({ hasText: "A Scene on the Ice" }).click();
    await expect(desktop(page)).toHaveAttribute("data-background", "scene-on-the-ice");
    await expect(picker(page)).toBeVisible();
    await expect(choices(page).filter({ hasText: "A Scene on the Ice" })).toBeFocused();
    await expect(picker(page)).toHaveAttribute("aria-busy", "true");
    expect(await choices(page).allTextContents()).toEqual(orderBeforeSave);
    await selectProject(page, "harvest-studio");
    await expect(desktop(page)).toHaveAttribute("data-background", "the-harvesters");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(choices(page)).toHaveCount(2);
    await expect(choices(page).first()).toContainText("The Harvesters");
    await expect(choices(page).first()).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    released.resolve();
    await heldSave;
    await expect.poll(() => read(projectId)).toBe("scene-on-the-ice");
    await expect(desktop(page)).toHaveAttribute("data-background", "the-harvesters");
    await expect(desktop(observer)).toHaveAttribute("data-background", "scene-on-the-ice");
    await selectProject(page, "coastal-studio");
    await page.reload();
    await selectProject(page, "coastal-studio");
    await expect(desktop(page)).toHaveAttribute("data-background", "scene-on-the-ice");
    await expect(desktop(observer)).toHaveAttribute("data-background", "scene-on-the-ice");
    expect(await database.client`SELECT * FROM factory.user_ui_preference`).toEqual(preferences);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(choices(page)).toHaveCount(2);
    await expect(choices(page).first()).toContainText("A Scene on the Ice");
    await page.screenshot({ path: `${evidence}/picker-mobile-collapsed.png`, fullPage: true });
    await expand(page).focus();
    await page.keyboard.press("Enter");
    await expect(choices(page)).toHaveCount(6);
    const last = choices(page).filter({ hasText: "Moonlit Landscape" });
    await last.focus();
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(desktop(page)).toHaveAttribute("data-background", "moonlit-landscape");
    await expect.poll(() => read(projectId)).toBe("moonlit-landscape");
    await expect(desktop(observer)).toHaveAttribute("data-background", "moonlit-landscape");
    await expect(picker(page)).toHaveAttribute("aria-busy", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const menu = await page.locator(".settings-menu").boundingBox();
    expect(menu?.y).toBeGreaterThanOrEqual(0);
    expect((menu?.y ?? 0) + (menu?.height ?? 0)).toBeLessThanOrEqual(844);
    await page.screenshot({ path: `${evidence}/picker-mobile.png`, fullPage: true });
    await collapse(page).focus();
    await page.keyboard.press("Enter");
    await expect(choices(page)).toHaveCount(2);
    await expect(expand(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(choices(page)).toHaveCount(2);
    await expect(choices(page).first()).toContainText("Moonlit Landscape");
    await expect(choices(page).first()).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `${evidence}/picker-mobile-selected-first.png`, fullPage: true });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.screenshot({ path: `${evidence}/moonlit-landscape-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.screenshot({ path: `${evidence}/picker-desktop.png`, fullPage: true });
    await expand(page).click();
    await page.screenshot({ path: `${evidence}/picker-desktop-expanded.png`, fullPage: true });
    await observer.setViewportSize({ width: 390, height: 844 });
    await observer.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(choices(observer)).toHaveCount(2);
    await expect(choices(observer).first()).toContainText("Moonlit Landscape");
    await page.screenshot({ path: `${evidence}/picker-manager.png`, fullPage: true });
    await observer.screenshot({ path: `${evidence}/picker-readonly-mobile.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await cleanup();
  }
});
