import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

const evidence = ".factory/test-results/parallel-delivery";
const cache = resolve(".factory/test-results/vite", `delivery-${crypto.randomUUID()}`);
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["delivery-settings.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = fixtureValue(
    fixtureValue(server.resolvedUrls, "server.resolvedUrls").local[0],
    "server.resolvedUrls!.local[0]",
  ).replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

test("Ticket Delivery needs explicit scoped consent and remains usable on narrow screens", async ({
  page,
}) => {
  let enabled = false,
    writes = 0;
  const policyId = "10000000-0000-4000-8000-000000000002";
  const value = () => ({
    policyId: enabled ? policyId : null,
    enabled,
    delegatedBy: enabled ? policyId : null,
    canManage: true,
    canDelegate: true,
  });
  await mockFactoryFunctions(page, {
    delivery: {
      settings: async () => value(),
      configure: async (_actor, _project, input) => {
        writes++;
        enabled = input.enabled;
        return value();
      },
    },
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/delivery-settings.html`);
    const region = page.getByRole("region", { name: "Automatic Ticket Delivery" });
    const enable = region.getByRole("button", { name: "Enable automatic Delivery", exact: true });
    await expect(enable).toBeVisible();
    // This feature does not mount an ActionBar to load its button styles.
    expect(await enable.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe(
      "0px",
    );
    expect(await enable.evaluate((element) => getComputedStyle(element).fontSize)).toBe("13px");
    await enable.click();
    const confirm = region.getByRole("button", { name: "Confirm automatic Delivery", exact: true });
    await expect(confirm).toHaveAttribute("data-primary", "true");
    await expect(confirm).toBeDisabled();
    const before = writes;
    await region.getByRole("checkbox").check();
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: `${evidence}/consent-${width}.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await confirm.click();
    await expect(
      region.getByText("Automatic Delivery is enabled for eligible Tickets.", { exact: true }),
    ).toBeVisible();
    expect(writes).toBe(before + 1);
    await region.getByRole("button", { name: "Disable automatic Delivery", exact: true }).click();
    await expect(
      region.getByText("Each Ticket requires human Delivery approval.", { exact: true }),
    ).toBeVisible();
  }
});

test("contributors cannot enable Ticket Delivery by reading Settings", async ({ page }) => {
  let writes = 0;
  await mockFactoryFunctions(page, {
    delivery: {
      settings: async () => ({
        policyId: null,
        enabled: false,
        delegatedBy: null,
        canManage: false,
        canDelegate: false,
      }),
      configure: async () => {
        writes++;
        throw new Error("Must not write");
      },
    },
  });
  await page.goto(`${origin}/delivery-settings.html`);
  await expect(
    page.getByRole("button", { name: "Enable automatic Delivery", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(0);
});

test("an unconfirmed enable is observed before a different Delivery decision gets a new identity", async ({
  page,
}) => {
  let enabled = false,
    drop = true;
  const commands: string[] = [];
  const policyId = "10000000-0000-4000-8000-000000000002";
  const value = () => ({
    policyId: enabled ? policyId : null,
    enabled,
    delegatedBy: enabled ? policyId : null,
    canManage: true,
    canDelegate: true,
  });
  await mockFactoryFunctions(
    page,
    {
      delivery: {
        settings: async () => value(),
        configure: async (_actor, _project, input) => {
          commands.push(input.commandId);
          enabled = input.enabled;
          return value();
        },
      },
    },
    (name) => {
      if (name !== "configureDelivery" || !drop) return false;
      drop = false;
      return true;
    },
  );
  await page.goto(`${origin}/delivery-settings.html`);
  const region = page.getByRole("region", { name: "Automatic Ticket Delivery" });
  await region.getByRole("button", { name: "Enable automatic Delivery", exact: true }).click();
  await region.getByRole("checkbox").check();
  await region.getByRole("button", { name: "Confirm automatic Delivery", exact: true }).click();
  await expect(region.getByRole("alert")).toBeVisible();
  expect(commands).toHaveLength(1);
  await region.getByRole("button", { name: "Reload Delivery settings", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Disable automatic Delivery", exact: true }),
  ).toBeVisible();
  expect(commands).toHaveLength(1);
  await region.getByRole("button", { name: "Disable automatic Delivery", exact: true }).click();
  await expect(
    region.getByText("Each Ticket requires human Delivery approval.", { exact: true }),
  ).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0]).not.toBe(commands[1]);
});
