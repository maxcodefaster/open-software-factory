import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import { CommandError } from "../../apps/factory/src/command-error";
import { test } from "../fixtures/browser-test";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { factoryFixtureStart } from "../fixtures/start-plugins";

const evidence = ".factory/test-results/password-change";
const cache = resolve(".factory/test-results/vite", `password-${crypto.randomUUID()}`);
const current = "current-fixture-secret-1";
const next = "new-fixture-secret-1234";
const typo = "typo-fixture-secret-9999";
const secrets = [current, next, typo];
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["repository-mirrors.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("Password fixture address missing");
  origin = address.replace(/\/$/, "");
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

type Change = { currentPassword: string; newPassword: string; confirmPassword: string };

async function open(
  page: Page,
  options: { available?: boolean; fresh?: boolean; change?: (input: Change) => Promise<void> } = {},
) {
  const calls: Change[] = [];
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await mockFactoryFunctions(page, {
    access: {
      authentication: async () => ({
        fresh: options.fresh ?? true,
        companySignIn: false,
        email: "person@fixture.test",
      }),
      policy: async () => ({ companySignIn: false, sessionDays: 7 }),
      passwordChange: async () => ({ available: options.available ?? true }),
      changePassword: async (_actor, _session, input) => {
        calls.push(input);
        await options.change?.(input);
      },
    },
  });
  await page.goto(`${origin}/repository-mirrors.html`);
  await chooseSettingsPage(page, "Login & security", "Personal");
  return { calls, logs, region: page.getByRole("region", { name: "Change password" }) };
}

async function fill(region: ReturnType<Page["getByRole"]>, values: Partial<Change>) {
  if (values.currentPassword !== undefined)
    await region.getByLabel("Current password", { exact: true }).fill(values.currentPassword);
  if (values.newPassword !== undefined)
    await region.getByLabel("New password", { exact: true }).fill(values.newPassword);
  if (values.confirmPassword !== undefined)
    await region.getByLabel("Confirm new password", { exact: true }).fill(values.confirmPassword);
}

for (const width of [1440, 390]) {
  test(`password change explains each refusal, then succeeds by keyboard at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { calls, logs, region } = await open(page, {
      change: async (input) => {
        if (input.currentPassword !== current)
          throw new CommandError("invalid", "The current password is incorrect.");
      },
    });
    await expect(region.getByRole("heading", { name: "Change password" })).toBeVisible();
    for (const field of ["Current password", "New password", "Confirm new password"])
      await expect(region.getByLabel(field, { exact: true })).toHaveAttribute("type", "password");
    const submit = region.getByRole("button", { name: "Change password", exact: true });

    // Policy refusals are explicit and never reach the server.
    await fill(region, {
      currentPassword: current,
      newPassword: "short",
      confirmPassword: "short",
    });
    await submit.click();
    await expect(region.getByRole("alert")).toHaveText(/at least 12 characters/);
    await fill(region, { newPassword: next, confirmPassword: typo });
    await submit.click();
    await expect(region.getByRole("alert")).toHaveText(
      "The new password and its confirmation differ.",
    );
    await fill(region, {
      currentPassword: next,
      newPassword: next,
      confirmPassword: next,
    });
    await submit.click();
    await expect(region.getByRole("alert")).toHaveText(/differs from the current/);
    await fill(region, {
      currentPassword: "",
      newPassword: next,
      confirmPassword: next,
    });
    await submit.click();
    await expect(region.getByRole("alert")).toHaveText("Enter your current password.");
    expect(calls).toHaveLength(0);

    // The server's refusal of a wrong current password is shown as written.
    await fill(region, {
      currentPassword: "wrong-fixture-secret-0",
      newPassword: next,
      confirmPassword: next,
    });
    await submit.click();
    await expect(region.getByRole("alert")).toHaveText("The current password is incorrect.");
    expect(calls).toHaveLength(1);
    await page.screenshot({ path: `${evidence}/refused-${width}.png`, fullPage: true });

    // Keyboard only: Tab through the fields and press Enter in the last one.
    await region.getByLabel("Current password", { exact: true }).fill(current);
    await region.getByLabel("New password", { exact: true }).focus();
    await expect(region.getByLabel("New password", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(region.getByLabel("Confirm new password", { exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(region.getByRole("status")).toContainText(
      "Password changed. Other browser sessions were signed out.",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      currentPassword: current,
      newPassword: next,
      confirmPassword: next,
    });
    for (const field of ["Current password", "New password", "Confirm new password"])
      await expect(region.getByLabel(field, { exact: true })).toHaveValue("");
    await page.screenshot({ path: `${evidence}/changed-${width}.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);

    // No password reaches the document text, attributes or console.
    const html = await page.content();
    const text = await page.locator("body").innerText();
    for (const secret of [...secrets, "wrong-fixture-secret-0"]) {
      expect(html).not.toContain(secret);
      expect(text).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
  });
}

test.describe("touch password change", () => {
  test.use({ viewport: { width: 390, height: 1000 }, isMobile: true, hasTouch: true });
  test("is operable by touch and keeps 44px targets", async ({ page }) => {
    const { calls, region } = await open(page);
    await fill(region, {
      currentPassword: current,
      newPassword: next,
      confirmPassword: next,
    });
    const submit = region.getByRole("button", { name: "Change password", exact: true });
    expect((await submit.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await submit.tap();
    await expect(region.getByRole("status")).toContainText("Password changed.");
    expect(calls).toHaveLength(1);
  });
});

test("accounts without a Factory password are not offered a change", async ({ page }) => {
  await open(page, { available: false });
  await expect(page.getByRole("heading", { name: "Browser sessions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change password" })).toHaveCount(0);
  await expect(page.getByLabel("Current password")).toHaveCount(0);
});

test("a stale sign-in disables the change with its reason and never writes", async ({ page }) => {
  const { calls, region } = await open(page, { fresh: false });
  const submit = region.getByRole("button", { name: "Change password", exact: true });
  await expect(submit).toBeDisabled();
  await expect(
    region.getByText("Confirm your identity above before changing your password."),
  ).toBeVisible();
  await expect(submit).toHaveAccessibleDescription(/Confirm your identity above/);
  await fill(region, {
    currentPassword: current,
    newPassword: next,
    confirmPassword: next,
  });
  await region.getByLabel("Confirm new password", { exact: true }).press("Enter");
  expect(calls).toHaveLength(0);
});
