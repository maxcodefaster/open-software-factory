import { repositoryDocumentsSchema } from "../../apps/factory/src/api-contracts";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

const evidence = ".factory/test-results/responsive-workspaces";
const commit = "a".repeat(40);

async function resize(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await expect
    .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual(viewport);
  // Media-query listeners and their focus/scroll updates settle with the next paint.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function withinViewport(page: Page, shellGap = false) {
  await expect
    .poll(() =>
      page.locator(".workspace-window").evaluate((element, gap) => {
        const bounds = element.getBoundingClientRect();
        const topbar = document.querySelector(".factory-topbar")?.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - innerWidth,
          pageHeight: document.documentElement.scrollHeight - innerHeight,
          belowDock: topbar ? Math.round(bounds.top - topbar.bottom) : -1,
          bottom: bounds.bottom <= innerHeight,
          left: bounds.left >= 0,
          right: bounds.right <= innerWidth,
          gap,
        };
      }, shellGap),
    )
    .toMatchObject({
      overflow: 0,
      pageHeight: 0,
      bottom: true,
      left: true,
      right: true,
      ...(shellGap ? { belowDock: 8 } : {}),
    });
}

for (const touch of [false, true]) {
  test.describe(touch ? "Touch workspaces" : "Pointer workspaces", () => {
    test.use({
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
      hasTouch: touch,
      isMobile: touch,
    });
    test("share compact navigation and use the available window height", async ({ page }) => {
      test.setTimeout(180_000);
      const database = createDatabase(1);
      const projectId = crypto.randomUUID();
      const slug = `responsive-${projectId.slice(0, 8)}`;
      const projectName = `Responsive workspace ${projectId.slice(0, 8)}`;
      const errors: string[] = [];
      const execution: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          request.method() === "POST" &&
          /\/(conversation|agent-turns|changes|ensure)(\/|$)/.test(path) &&
          // Selecting a Project prepares source/IDE access without commissioning compute or AI.
          !/\/(developer-ide|source-workspace)\/ensure$/.test(path)
        )
          execution.push(request.url());
      });
      try {
        await mkdir(evidence, { recursive: true });
        await signIn(page);
        const [admin] = await database.client<{ id: string }[]>`
          SELECT user_id AS id FROM factory.administrator LIMIT 1
        `;
        if (!admin) throw new Error("Owned responsive fixture has no administrator.");
        await database.client`
          INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
          VALUES(${projectId},${slug},${projectName},'https://example.invalid/responsive.git',
            'main','.devcontainer/devcontainer.json',${admin.id})
        `;
        for (const [index, title] of ["Product guide", "Review guide"].entries()) {
          const id = crypto.randomUUID();
          await database.client`
            INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
            VALUES(${id},${projectId},${`guide-${index}`},${title},${`Saved ${title} content.`},
              ${`Saved ${title} content.`},${commit},${admin.id})
          `;
        }
        await database.client`
          INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,state,created_by,completed_at)
          VALUES(${crypto.randomUUID()},${projectId},${commit},'succeeded',${admin.id},now())
        `;
        await mockFactoryFunctions(page, {
          knowledge: {
            documents: async () =>
              repositoryDocumentsSchema.parse({ commitSha: commit, documents: [] }),
          },
        });
        await openProjectMenu(page);
        await page.getByRole("button").filter({ hasText: slug }).click();
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "Open settings", exact: true }).click();
        await chooseSettingsPage(page, "Inputs");
        const settings = page.getByRole("region", { name: "Settings", exact: true });
        const navigation = settings.getByRole("navigation", { name: "Settings navigation" });
        const chooser = settings.getByRole("button", { name: "Choose settings page", exact: true });
        await expect(navigation).toBeVisible();
        await expect(chooser).toBeHidden();
        await expect(
          settings.getByRole("button", { name: "Add input", exact: true }),
        ).toBeVisible();
        await withinViewport(page);
        const suffix = touch ? "touch" : "pointer";
        await page.screenshot({ path: `${evidence}/settings-wide-${suffix}.png` });

        // Small-screen navigation must not replace the desktop sidebar beside the assistant.
        await resize(page, { width: 1200, height: 900 });
        await page.getByRole("button", { name: "Toggle Agent panel" }).click();
        await expect(chooser).toBeHidden();
        await expect(navigation).toBeVisible();
        await expect
          .poll(() => settings.evaluate((node) => node.clientWidth))
          .toBeLessThanOrEqual(760);
        await expect(
          settings.getByRole("button", { name: "Add input", exact: true }),
        ).toBeVisible();
        await withinViewport(page);
        await page.screenshot({ path: `${evidence}/settings-split-${suffix}.png` });
        await page.getByRole("button", { name: "Toggle Agent panel" }).click();

        await resize(page, { width: 760, height: 900 });
        await expect(chooser).toBeVisible();
        await expect(navigation).toBeHidden();
        await resize(page, { width: 761, height: 900 });
        await expect(chooser).toBeHidden();
        await expect(navigation).toBeVisible();

        for (const viewport of [
          { width: 390, height: 844 },
          { width: 320, height: 700 },
          { width: 844, height: 390 },
        ]) {
          await resize(page, viewport);
          await withinViewport(page, true);
          if (viewport.width > 760) {
            await expect(navigation).toBeVisible();
            await expect(chooser).toBeHidden();
            await expect(
              navigation.getByRole("button", { name: "Inputs", exact: true }),
            ).toBeInViewport({ ratio: 1 });
            await page.screenshot({ path: `${evidence}/settings-landscape-${suffix}.png` });
            continue;
          }
          await expect(chooser).toBeVisible();
          await expect(settings.getByText("Settings page", { exact: true })).toHaveCount(0);
          await expect(settings.getByRole("heading", { name: "Inputs", exact: true })).toHaveCount(
            1,
          );
          const actions = settings.getByRole("group", { name: "Input actions" });
          await expect(actions.getByRole("button", { name: "Add input" })).toBeVisible();
          await expect
            .poll(() =>
              actions.evaluate((bar) => {
                const title = bar
                  .querySelector(".workspace-navigation-trigger")
                  ?.getBoundingClientRect();
                const action = bar.querySelector('[data-primary="true"]')?.getBoundingClientRect();
                return title && action ? Math.abs(title.top - action.top) : Infinity;
              }),
            )
            .toBeLessThanOrEqual(6);
          if (touch) await chooser.tap();
          else await chooser.click();
          await expect(
            navigation.getByRole("button", { name: "Inputs", exact: true }),
          ).toBeFocused();
          await expect
            .poll(() =>
              navigation.evaluate((node) => {
                const bounds = node.getBoundingClientRect();
                return bounds.bottom;
              }),
            )
            .toBeLessThanOrEqual(viewport.height);
          const menu = await navigation.boundingBox();
          expect(menu?.x).toBeGreaterThanOrEqual(0);
          await page.screenshot({
            path: `${evidence}/settings-menu-${viewport.width}-${suffix}.png`,
          });
          if (viewport.width === 390) {
            const before = await navigation.evaluate((node) => node.scrollTop);
            if (touch && menu) {
              const cdp = await page.context().newCDPSession(page);
              try {
                await cdp.send("Input.synthesizeScrollGesture", {
                  x: menu.x + menu.width / 2,
                  y: menu.y + menu.height - 60,
                  yDistance: -320,
                  gestureSourceType: "touch",
                  speed: 600,
                });
              } finally {
                await cdp.detach();
              }
            } else {
              await navigation.hover();
              await page.mouse.wheel(0, 320);
            }
            await expect
              .poll(() => navigation.evaluate((node) => node.scrollTop))
              .toBeGreaterThan(before);
            await expect(chooser).toHaveText("Inputs");
          }
          await page.keyboard.press("End");
          const last = navigation.getByRole("button", { name: "Company sign-in", exact: true });
          await expect(last).toBeFocused();
          await expect(last).toBeInViewport({ ratio: 1 });
          await page.keyboard.press("Escape");
          await expect(navigation).toBeHidden();
          await expect(chooser).toBeFocused();
        }
        await resize(page, { width: 390, height: 844 });
        for (const [label, group] of [
          ["Models", "Factory administration"],
          ["Usage & limits", "Factory administration"],
          ["People & access", "Factory administration"],
          ["Login & security", "Personal"],
          ["Skills", "Libraries"],
          ["MCP connections", "Libraries"],
          ["Environments", `Project · ${projectName}`],
          ["Inputs", `Project · ${projectName}`],
        ]) {
          if (!label || !group) throw new Error("Missing settings fixture label.");
          await chooseSettingsPage(page, label, group);
          await expect(chooser).toHaveText(label);
          await expect(navigation).toBeHidden();
          await withinViewport(page, true);
          await expect
            .poll(() => settings.evaluate((node) => node.scrollWidth - node.clientWidth))
            .toBeLessThanOrEqual(1);
        }
        await page.screenshot({ path: `${evidence}/settings-390-${suffix}.png` });
        await page.getByRole("button", { name: "Knowledge", exact: true }).click();
        const wikiNavigation = page.getByRole("complementary", { name: "Wiki navigation" });
        const pages = page.getByRole("button", { name: "Browse Wiki pages" });
        await expect(pages).toBeVisible();
        await expect(wikiNavigation).toBeHidden();
        await pages.click();
        await wikiNavigation.getByRole("button", { name: "Product guide", exact: true }).click();
        await expect(wikiNavigation).toBeHidden();
        await expect(page.locator(".knowledge-article:visible")).toContainText(
          "Saved Product guide",
        );
        await withinViewport(page, true);
        await page.screenshot({ path: `${evidence}/wiki-390-${suffix}.png` });
        await pages.click();
        await expect(wikiNavigation.getByRole("button", { name: "Product guide" })).toBeFocused();
        await wikiNavigation.getByRole("button", { name: "Wiki", exact: true }).click();
        await resize(page, { width: 1440, height: 960 });
        await expect(wikiNavigation).toBeVisible();
        await expect(
          wikiNavigation.getByRole("button", { name: "Wiki", exact: true }),
        ).toHaveAttribute("aria-expanded", "false");
        await expect(pages).toBeHidden();
        await resize(page, { width: 1200, height: 900 });
        await page.getByRole("button", { name: "Toggle Agent panel" }).click();
        await expect(wikiNavigation).toBeVisible();
        await expect(pages).toBeHidden();
        await page.screenshot({ path: `${evidence}/wiki-split-${suffix}.png` });
        await page.getByRole("button", { name: "Toggle Agent panel" }).click();
        await resize(page, { width: 390, height: 844 });
        await pages.click();
        await expect(
          wikiNavigation.getByRole("button", { name: "Wiki", exact: true }),
        ).toHaveAttribute("aria-expanded", "false");
        await wikiNavigation.getByRole("button", { name: "Wiki", exact: true }).click();
        await wikiNavigation.getByRole("button", { name: "Review guide", exact: true }).click();
        await expect(page.locator(".knowledge-article:visible")).toContainText(
          "Saved Review guide",
        );
        await pages.click();
        await wikiNavigation.getByRole("button", { name: "Search Wiki" }).click();
        await expect(wikiNavigation).toBeHidden();
        await expect(page.getByRole("dialog", { name: "Search Wiki" })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Inbox", exact: true }).click();
        await expect(page.locator(".inbox-workspace")).toBeVisible();
        await withinViewport(page, true);
        await page.screenshot({ path: `${evidence}/inbox-390-${suffix}.png` });
        await page.getByRole("button", { name: "Toggle Agent panel" }).click();
        const agent = page.locator(".agent-panel");
        await expect(agent).toBeVisible();
        await expect
          .poll(() =>
            agent.evaluate((node) => {
              const dock = document.querySelector(".factory-topbar")?.getBoundingClientRect();
              return dock ? Math.round(node.getBoundingClientRect().top - dock.bottom) : -1;
            }),
          )
          .toBe(8);
        if (touch) {
          // The shared tab strip keeps full touch targets without a second toolbar row.
          expect(
            await page
              .locator(".workspace-tabbar")
              .evaluate((node) => node.getBoundingClientRect().height),
          ).toBe(44);
        }
        await page.screenshot({ path: `${evidence}/assistant-390-${suffix}.png` });
        expect(execution).toEqual([]);
        expect(errors).toEqual([]);
      } catch (cause) {
        await page.screenshot({
          path: `${evidence}/failed-${touch ? "touch" : "pointer"}.png`,
        });
        throw cause;
      } finally {
        await deleteFactoryProject(projectId);
        await database.client.end();
      }
    });
  });
}
