import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { defaultExecutionPolicy } from "../../packages/conversation-domain/src/execution-policy";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn } from "../support/factory-fixture";

test.use({ trace: "off" });

test("Usage settings retain exact saves and show truthful totals, prices and measurements at desktop and narrow widths", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const policy = defaultExecutionPolicy();
  let version = 0,
    saved = policy,
    attempt = 0;
  const writes: unknown[] = [];
  await page.route("**/api/admin/usage", async (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      if (++attempt === 1) return route.abort("failed");
      saved = route.request().postDataJSON().policy;
      version++;
      return route.fulfill({ json: {} });
    }
    return route.fulfill({
      json: {
        factory: saved,
        project: null,
        effective: saved,
        version,
        timezone: "UTC",
        canEdit: true,
        allowed: true,
        reason: null,
        scopes: [
          {
            scope: null,
            allowed: true,
            warning: true,
            reason: null,
            incomplete: true,
            knownNanoUSD: "800000000",
            reset: "2026-11-01T00:00:00.000Z",
          },
        ],
        projectAgentTotal: { knownNanoUSD: "10000000", incomplete: false },
        detailScope: "factory",
        allocation: { sandboxes: 1, cpuMilli: 500, memoryMiB: 1024 },
        summary: [
          {
            provider: "openai",
            model: "exact-coding",
            purpose: "coding",
            knownNanoUSD: "800000000",
            incomplete: true,
            steps: 2,
            input: "10000",
            output: "2000",
            cacheRead: "500",
            cacheWrite: "0",
          },
        ],
      },
    });
  });
  await page.route("**/api/admin/usage/compute", (route) =>
    route.fulfill({
      json: {
        hasMore: false,
        observations: [
          {
            id: crypto.randomUUID(),
            kind: "development",
            startedAt: new Date().toISOString(),
            timestamp: new Date().toISOString(),
            status: "stale",
            cpuMilli: 150,
            memoryMiB: 384,
          },
        ],
      },
    }),
  );
  const rates: unknown[] = [];
  const rateWrites: unknown[] = [];
  await page.route("**/api/admin/usage/rates", (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      rateWrites.push(input);
      rates.push({
        ...input,
        version: 1,
        rate: {
          provider: input.provider,
          model: input.model,
          source: "contract",
          fetchedAt: new Date().toISOString(),
          tiers: input.tiers,
        },
      });
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: { rates } });
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings
    .getByRole("navigation", { name: "Settings navigation" })
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Factory administration", exact: true }) })
    .getByRole("button", { name: "Usage & limits", exact: true })
    .click();
  const usage = page.getByRole("region", { name: "Usage & limits" });
  await expect(usage.getByLabel("Monthly Coding allowance")).toHaveValue("", { timeout: 5000 });
  navigations.length = 0;
  await expect(usage.getByText("Partial estimate.", { exact: false })).toBeVisible();
  await expect(usage.getByText("Stale ·", { exact: false })).toBeVisible();
  await usage.getByLabel("Monthly Coding allowance").fill("1");
  await usage.getByRole("button", { name: "Save limits", exact: true }).click();
  await expect(usage.getByRole("alert")).toBeVisible();
  await usage.getByRole("button", { name: "Retry exact save" }).click();
  await expect(usage.getByText("Saved. Existing work is retained.")).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await usage.getByText("Model usage", { exact: true }).click();
  await expect(usage.getByRole("cell").filter({ hasText: "exact-coding" })).toBeVisible();
  expect(navigations).toEqual([]);
  await mkdir(".factory/screenshots/usage-limits", { recursive: true });
  await page.screenshot({ path: ".factory/screenshots/usage-limits/desktop.png" });
  await usage.getByText("Contract prices", { exact: true }).click();
  await usage.getByLabel("Model", { exact: true }).fill("exact-coding");
  await usage.getByLabel("Input", { exact: true }).fill("2");
  await usage.getByLabel("Output", { exact: true }).fill("10");
  await usage.getByLabel("Cache read", { exact: true }).fill("0.2");
  await usage.getByLabel("Cache write", { exact: true }).fill("0");
  await usage.getByRole("button", { name: "Add context tier" }).click();
  await usage.getByRole("button", { name: "Remove context tier" }).click();
  await usage.getByRole("button", { name: "Save contract prices", exact: true }).click();
  await expect(usage.getByText("Saved for future work.", { exact: false })).toBeVisible();
  expect(rateWrites).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const box = await usage.getByLabel("Model", { exact: true }).boundingBox();
      return box ? box.x + box.width : Infinity;
    })
    .toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const control of await usage.locator("input,button").all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await usage
    .getByRole("button", { name: "Save contract prices", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".factory/screenshots/usage-limits/narrow.png" });
  await page.route("**/api/projects/*/usage", (route) =>
    route.fulfill({
      json: {
        factory: { ...policy, codingUSD: 5 },
        project: null,
        effective: { ...policy, codingUSD: 5 },
        version: 0,
        timezone: "UTC",
        canEdit: false,
        allowed: true,
        reason: null,
        detailScope: "own",
        scopes: [],
        allocation: { sandboxes: 0, cpuMilli: 0, memoryMiB: 0 },
        projectAgentTotal: { knownNanoUSD: "10000000", incomplete: false },
        summary: [
          {
            provider: "openai",
            model: "your-exact-model",
            purpose: "research",
            knownNanoUSD: "10000000",
            incomplete: false,
            steps: 1,
            input: "100",
            output: "20",
            cacheRead: "0",
            cacheWrite: "0",
          },
        ],
      },
    }),
  );
  await page.route("**/api/projects/*/usage/compute", (route) =>
    route.fulfill({
      json: { hasMore: false, observations: [] },
    }),
  );
  if (
    !(await settings
      .getByRole("navigation", { name: "Settings navigation" })
      .locator("section")
      .filter({ hasNot: page.getByRole("heading", { name: /^(Factory|Personal)$/ }) })
      .count())
  ) {
    await openProjectMenu(page);
    await page
      .getByRole("region", { name: "Projects", exact: true })
      .getByRole("button")
      .filter({ hasText: "factory-starter" })
      .first()
      .click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
  }
  const projectNavigation = settings
    .getByRole("navigation", { name: "Settings navigation" })
    .locator("section")
    .filter({ hasNot: page.getByRole("heading", { name: /^(Factory|Personal)$/ }) });
  await projectNavigation.getByRole("button", { name: "Usage & limits", exact: true }).click();
  await expect(usage.getByLabel("Monthly Coding allowance")).toBeDisabled();
  await expect(usage.getByText("Effective: 5 USD")).toBeVisible();
  await expect(usage.getByRole("button", { name: "Save limits" })).toHaveCount(0);
  await expect(usage.getByLabel("Installation timezone")).toHaveCount(0);
  await expect(usage.getByText("Contract prices", { exact: true })).toHaveCount(0);
  await usage.getByText("Your model usage", { exact: true }).click();
  await expect(usage.getByRole("cell", { name: "your-exact-model openai" })).toBeVisible();
  await page.screenshot({ path: ".factory/screenshots/usage-limits/project-readonly-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: ".factory/screenshots/usage-limits/project-readonly.png" });
  expect(errors).toEqual([]);
});
