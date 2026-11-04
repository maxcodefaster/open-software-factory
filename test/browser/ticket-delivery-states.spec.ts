import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { visualReviewSchema } from "../../packages/conversation-domain/src/visual-review";
import { test } from "../fixtures/browser-test";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { deliveryStates } from "../fixtures/ticket-delivery-states";
import { fixtureValue } from "../fixtures/value";

const directory = ".factory/test-results/ticket-delivery-states";
const cache = resolve(".factory/test-results/vite", `ticket-delivery-${crypto.randomUUID()}`);
const actions = [
  "Deliver",
  "Retry review",
  "Retry Main Preview",
  "Resume checks",
  "Create follow-up",
];
let server: ViteDevServer;
let origin: string;
test.setTimeout(60_000);
test.use({ contextOptions: { reducedMotion: "reduce" } });
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["ticket-delivery.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = fixtureValue(
    fixtureValue(server.resolvedUrls, "server.resolvedUrls").local[0],
    "server.resolvedUrls!.local[0]",
  ).replace(/\/$/, "");
  await mkdir(directory, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

async function open(page: Page, state: string, width: number) {
  const threads = Number(deliveryStates[state]?.delivery["openReviewThreads"] ?? 0);
  await mockFactoryFunctions(page, {
    review: {
      get: async () =>
        visualReviewSchema.parse({
          feedback: Array.from({ length: threads }, (_, index) => ({
            id: crypto.randomUUID(),
            kind: "thread",
            state: "open",
            version: 1,
            authorId: "10000000-0000-4000-8000-000000000009",
            author: "Tom Development",
            commitSha: "a".repeat(40),
            annotation: null,
            createdAt: "2026-10-26T10:00:00Z",
            messages: [
              {
                id: crypto.randomUUID(),
                author: "Tom Development",
                body: `Open question ${index + 1}`,
                createdAt: "2026-10-26T10:00:00Z",
              },
            ],
          })),
          recording: null,
          scenarios: [],
        }),
    },
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}/ticket-delivery.html?state=${state}`);
  await expect(page.locator(".ticket-checks > summary")).toBeVisible();
}

for (const width of [1440, 390]) {
  for (const [name, state] of Object.entries(deliveryStates)) {
    test(`${name} offers ${state.primary ?? "no Delivery action"} at ${width}px`, async ({
      page,
    }) => {
      await open(page, name, width);
      await expect(page.locator(".ticket-checks > summary")).toContainText(state.summary);
      for (const label of actions) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (label === state.primary) await expect(button).toBeVisible();
        else await expect(button).toHaveCount(0);
      }
      if (state.progress)
        await expect(page.getByRole("status", { name: "Ticket progress" })).toContainText(
          state.progress,
        );
      else
        await expect(page.getByRole("status", { name: "Ticket progress" })).not.toContainText(
          "Waiting for",
        );
      if (state.primary === "Deliver")
        await expect(page.getByRole("button", { name: "Deliver", exact: true })).toBeEnabled();
      await page.locator(".ticket-checks > summary").click();
      await expect(page.locator(".ticket-check-details")).toBeVisible();
      if (state.detail)
        await expect(page.locator(".ticket-check-details")).toContainText(state.detail);
      for (const finding of fixtureValue(state.delivery["reviewFindings"] ?? [], "findings") as {
        title: string;
      }[])
        await expect(page.locator(".ticket-check-details")).toContainText(finding.title);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `${directory}/${name}-${width}.png` });
    });
  }
}

test("the primary Delivery action reports exactly one command", async ({ page }) => {
  await open(page, "deliverable", 1440);
  await page.getByRole("button", { name: "Deliver", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText("deliver");
  await open(page, "review-incomplete", 1440);
  await page.getByRole("button", { name: "Retry review", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText("retry-review");
  await open(page, "promotion-failed", 1440);
  await page.getByRole("button", { name: "Retry Main Preview", exact: true }).click();
  await expect(page.getByLabel("Fixture action")).toHaveText("retry-promotion");
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const name of ["deliverable", "review-defects", "promotion-failed"]) {
    test(`${name} keeps Delivery controls at least 44px`, async ({ page }) => {
      await open(page, name, 390);
      await page.locator(".ticket-checks > summary").click();
      const small = await page.evaluate(() => {
        const found: string[] = [];
        for (const element of document.querySelectorAll(
          ".ticket-document-heading button, .ticket-checks summary, .ticket-check-details a",
        )) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (box.height < 44 && !(element instanceof HTMLAnchorElement))
            found.push(`${element.textContent?.trim().slice(0, 30)} ${Math.round(box.height)}`);
        }
        return found;
      });
      expect(small).toEqual([]);
    });
  }
});
