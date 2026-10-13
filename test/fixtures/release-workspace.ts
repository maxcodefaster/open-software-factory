import { expect } from "bun:test";
import { resolve } from "node:path";
import { expect as visible } from "@playwright/test";
import type { releaseInstallation } from "./release-installation";
import { deliveryViewSchema } from "../../apps/factory/src/api-contracts";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

export async function releaseWorkspace(fixture: Fixture) {
  const { state } = fixture;
  const ticketID = state.ticketID;
  if (!ticketID || !state.changeID)
    throw new Error("Release Build must verify before the Workspace proof");
  const delivery = deliveryViewSchema.parse(
    await fixture.command(
      await fixture.login("developer"),
      `/api/changes/${state.changeID}/delivery`,
    ),
  );
  expect(delivery.verificationState).toBe("succeeded");
  state.verifiedSHA = delivery.verificationCommitSha;
  const page = await fixture.page("developer");
  await fixture.selectProject(page);
  await page
    .locator(".ticket-card-body")
    .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const started = performance.now();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const target = page
    .getByRole("menuitem")
    .filter({ hasText: "Create centered welcome dashboard" });
  if (await target.isVisible()) await target.click();
  const frame = page.locator('iframe[title="Factory IDE"]');
  const ide = frame.contentFrame();
  await visible(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 300_000 });
  await visible(ide.locator(".theia-preload")).toHaveCount(0);
  const timeOrigin = await ide.locator("body").evaluate(() => performance.timeOrigin);
  await visible
    .poll(async () => {
      const body = await page.locator(".workspace-view-body").boundingBox();
      const box = await frame.boundingBox();
      return (
        body &&
        box &&
        (["x", "y", "width", "height"] as const).every((key) => Math.abs(body[key] - box[key]) <= 1)
      );
    })
    .toBe(true);
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  const terminal = ide.locator(".factory-terminal-widget");
  const host = terminal.locator(".factory-terminal-host:not([hidden])");
  await visible(host).toHaveAttribute("data-connection-state", "connected");
  await host.locator(".xterm").click({ force: true });
  await page.keyboard.type(`export FACTORY_RELEASE_SENTINEL=${fixture.slug}`);
  await page.keyboard.press("Enter");
  await page.keyboard.type(
    "printf 'release-pty=%s\\n' \"$FACTORY_RELEASE_SENTINEL\"; pwd; cat src/version.txt",
  );
  await page.keyboard.press("Enter");
  await visible(host.locator(".xterm-rows")).toContainText(`release-pty=${fixture.slug}`);
  await visible(host.locator(".xterm-rows")).toContainText("/workspace/project");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: resolve(fixture.evidence, "theia-terminal-wide.png") });
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Run" }).click();
  const run = ide.locator(".factory-runtime-widget");
  const worker = run.locator('[data-process="app-worker"]');
  await visible(worker).toContainText("Running");
  await worker.click();
  await run.getByRole("button", { name: "Stop", exact: true }).click();
  await visible(worker).toContainText("Stopped");
  await run.getByRole("button", { name: "Start", exact: true }).click();
  await visible(worker).toContainText("Running");
  await run.getByRole("button", { name: "Restart", exact: true }).click();
  await visible(worker).toContainText("Running");
  await run.locator('[data-process="app"]').click();
  await run.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator('iframe[title="Factory Preview"]').contentFrame();
  await visible(preview.locator("h1")).toContainText(/welcome/i, { timeout: 60_000 });
  await visible(
    preview
      .getByRole("button", { name: /Continue/ })
      .or(preview.getByRole("link", { name: /Continue/ })),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: resolve(fixture.evidence, "development-preview-wide.png") });
  await page.getByRole("tab", { name: /^IDE ·/ }).click();
  expect(await ide.locator("body").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  await visible(host).toHaveAttribute("data-connection-state", "connected");
  await host.locator(".xterm").click({ force: true });
  await page.keyboard.type("printf 'restored-pty=%s\\n' \"$FACTORY_RELEASE_SENTINEL\"");
  await page.keyboard.press("Enter");
  await visible(host.locator(".xterm-rows")).toContainText(`restored-pty=${fixture.slug}`);
  await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  if (await target.isVisible()) await target.click();
  await visible(ide.locator("#theia-app-shell")).toBeVisible();
  expect(await ide.locator("body").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  await visible(host).toHaveAttribute("data-connection-state", "connected");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "Minimize Agent panel" }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: resolve(fixture.evidence, "theia-terminal-narrow.png") });
  await fixture.save("workspace", performance.now() - started);
}
