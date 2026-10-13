import { expect } from "bun:test";
import { resolve } from "node:path";
import { expect as visible } from "@playwright/test";
import type { releaseInstallation } from "./release-installation";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

export async function releaseVisuals(fixture: Fixture) {
  const observations: Array<{ screen: string; width: number; dialogWidth?: number }> = [];
  for (const role of ["admin", "manager", "developer"] as const) {
    const page = await fixture.page(role);
    await fixture.selectProject(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Agent settings", exact: true });
    await visible(dialog.getByRole("combobox", { name: /^Build/ })).toHaveCount(1);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 960 });
      const bounds = await dialog.boundingBox();
      expect(bounds && bounds.x >= 0 && bounds.width + bounds.x <= width).toBe(true);
      fixture.noSecrets(await page.locator("body").innerHTML());
      await page.mouse.move(0, 0);
      const screen = `settings-${role}-models-${width}`;
      await page.screenshot({ path: resolve(fixture.evidence, `${screen}.png`) });
      observations.push({ screen, width, ...(bounds ? { dialogWidth: bounds.width } : {}) });
    }
    await dialog.getByRole("button", { name: "Skills", exact: true }).click();
    await visible(dialog.getByRole("button", { name: "Save Skills", exact: true })).toBeVisible();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 960 });
      fixture.noSecrets(await page.locator("body").innerHTML());
      const screen = `settings-${role}-skills-${width}`;
      await page.screenshot({ path: resolve(fixture.evidence, `${screen}.png`) });
      observations.push({ screen, width });
    }
    await page.keyboard.press("Escape");
    if (role !== "developer") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "People & access", exact: true }).click();
      await visible(
        page.getByRole("dialog", { name: "People & access", exact: true }),
      ).toBeVisible();
      await visible(
        page
          .getByLabel("Project membership")
          .getByText(fixture.credentials("developer").email, { exact: true }),
      ).toBeVisible();
      const screen = `settings-${role}-access-900`;
      await page.screenshot({ path: resolve(fixture.evidence, `${screen}.png`) });
      observations.push({ screen, width: 900 });
    }
    await page.context().close();
  }
  await fixture.record("suite-visuals", observations);
}

export async function releaseProductVisuals(fixture: Fixture) {
  const page = await fixture.page("developer");
  await fixture.selectProject(page);
  await visible(page.locator(".ticket-card-blockers")).toHaveCount(0);
  await visible(
    page.locator(".ticket-card-body").filter({ hasText: "Release version" }),
  ).toContainText("Verified");
  const capture = async (name: string, width = 1440) => {
    await page.setViewportSize({ width, height: 960 });
    const hideAgent = width === 900 && ["knowledge", "staging", "ide"].includes(name);
    if (hideAgent) await page.getByRole("button", { name: "Minimize Agent panel" }).click();
    if (name === "ide")
      await visible(
        page
          .locator('iframe[title="Factory IDE"]')
          .contentFrame()
          .locator('.factory-runtime-widget [data-process="app"]'),
      ).toContainText("Running", { timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    fixture.noSecrets(await page.locator("body").innerHTML());
    await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(fixture.evidence, `final-${name}-${width}.png`) });
    if (hideAgent) await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  };
  await capture("board");
  await capture("board", 900);
  await page.getByRole("button", { name: "Open project menu" }).click();
  await capture("project-menu", 900);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await capture("settings-menu", 900);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 960 });
  const ticketID = fixture.state.dependentTicketID;
  if (!ticketID) throw new Error("Verified dependent Ticket required");
  await page
    .locator(".ticket-card-body")
    .filter({ hasText: `TCK-${ticketID.slice(0, 6).toUpperCase()}` })
    .click();
  if (!(await page.locator(".agent-panel").isVisible()))
    await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await visible(page.locator(".agent-panel")).toBeVisible();
  await visible(page.locator(".agent-state")).toHaveText("Complete", { timeout: 15_000 });
  await visible(page.locator(".agent-messages")).toContainText(
    "Implemented the approved release change",
  );
  await visible(page.locator(".agent-messages")).not.toContainText("Factory development browser:");
  await visible(page.locator(".agent-messages")).not.toContainText(
    "Factory-approved Build Skills follow.",
  );
  await visible(page.locator(".agent-messages")).not.toContainText(
    "Implement the approved ticket:",
  );
  await capture("agent-spec");
  await capture("agent-spec", 900);
  await page.getByRole("button", { name: "Minimize Agent panel" }).click();
  await capture("spec", 900);
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await page
    .locator(".agent-turn-details > summary")
    .filter({ hasText: "Agent configuration" })
    .click();
  await capture("agent-configuration");
  await capture("agent-configuration", 900);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await visible(page.locator(".knowledge-article")).toBeVisible();
  await capture("knowledge");
  await capture("knowledge", 900);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const staging = page.getByRole("menuitem", { name: /Staging/ });
  if (await staging.isVisible()) await staging.click();
  await visible(
    page.locator('iframe[title="Factory Preview"]').contentFrame().locator("h1"),
  ).toBeVisible();
  await capture("staging");
  await capture("staging", 900);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const ideTarget = page.getByRole("menuitem").filter({ hasText: "Release version" });
  if (await ideTarget.isVisible()) await ideTarget.click();
  await visible(
    page.locator('iframe[title="Factory IDE"]').contentFrame().locator("#theia-app-shell"),
  ).toBeVisible({ timeout: 60_000 });
  await capture("ide");
  await capture("ide", 900);
}
