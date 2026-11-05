// Browser steps for upgrade-test.ts: the paths a person uses. Nothing here reads a Secret itself;
// the caller passes the administrator's password and this module only types it into the form.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const step = 45_000;

async function launch() {
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

async function signIn(page: Page, origin: string, email: string, password: string) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(email, { timeout: step });
  await page.getByLabel("Password").fill(password, { timeout: step });
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function screenshotOnFailure<T>(
  page: Page,
  evidence: string,
  name: string,
  run: () => Promise<T>,
) {
  try {
    return await run();
  } catch (cause) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, `${name}.png`) }).catch(() => undefined);
    throw new Error(
      `${name} failed in the browser: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`,
    );
  }
}

export type SeedUI = {
  origin: string;
  email: string;
  password: string;
  evidence: string;
  projectID: string;
  projectSlug: string;
  user: { name: string; email: string; password: string };
  ticketTitles: string[];
};

/** Signs in, creates an account, adds it to the Project and writes Tickets as ideas. */
export async function seedThroughBrowser(input: SeedUI) {
  const browser = await launch();
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 960 } })
    ).newPage();
    await screenshotOnFailure(page, input.evidence, "seed-sign-in", () =>
      signIn(page, input.origin, input.email, input.password),
    );
    await screenshotOnFailure(page, input.evidence, "seed-account", async () => {
      const switcher = page.getByRole("button", { name: /open project menu$/i });
      if (!(await switcher.isVisible()))
        await page.getByRole("button", { name: "Settings", exact: true }).click();
      await switcher.click();
      await page.getByRole("button").filter({ hasText: input.projectSlug }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      const settings = page
        .getByRole("region", { name: "Settings", exact: true })
        .and(page.locator(".settings-workspace"));
      const navigation = settings.getByRole("navigation", { name: "Settings navigation" });
      if (!(await navigation.isVisible()))
        await settings.getByRole("button", { name: /choose settings page$/i }).click();
      await navigation
        .getByRole("combobox", { name: "Settings scope", exact: true })
        .selectOption("system");
      if (!(await navigation.isVisible()))
        await settings.getByRole("button", { name: /choose settings page$/i }).click();
      await navigation
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "Factory administration", exact: true }) })
        .getByRole("button", { name: "People & access", exact: true })
        .click();
      await settings.getByRole("region", { name: "Managed accounts" }).waitFor({ timeout: step });
      await settings.getByText("Add account", { exact: true }).click();
      await settings.getByLabel("Name", { exact: true }).fill(input.user.name);
      await settings.getByLabel("Email", { exact: true }).fill(input.user.email);
      await settings.getByLabel("Initial password", { exact: false }).fill(input.user.password);
      await settings.getByRole("button", { name: "Create account", exact: true }).click();
      await settings
        .getByRole("status")
        .filter({ hasText: "Account created" })
        .waitFor({ timeout: step });
    });
    for (const [index, title] of input.ticketTitles.entries())
      await screenshotOnFailure(page, input.evidence, `seed-ticket-${index + 1}`, async () => {
        await page.goto(`${input.origin}/projects/${input.projectID}`, {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("button", { name: "New Ticket", exact: true }).click();
        await page.getByLabel("Ticket title", { exact: true }).fill(title);
        await page.getByRole("button", { name: "Create as idea", exact: true }).click();
        await page.getByText(title).first().waitFor({ state: "visible", timeout: step });
      });
  } finally {
    await browser.close();
  }
}

export type VerifyUI = {
  origin: string;
  email: string;
  password: string;
  evidence: string;
  label: string;
  projectID: string;
  projectName: string;
  tickets: Array<{ id: string; title: string }>;
  wiki: { pageID: string; text: string };
};

export type VerifyResult = {
  loaded: Array<{ name: string; ok: boolean; detail: string }>;
  consoleMessages: string[];
};

/** Signs in with the same password and opens the Project, each Ticket and the Wiki page. */
export async function verifyThroughBrowser(input: VerifyUI): Promise<VerifyResult> {
  const browser = await launch();
  const consoleMessages: string[] = [];
  const loaded: VerifyResult["loaded"] = [];
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 960 } })
    ).newPage();
    page.on("console", (message) => {
      if (message.type() === "error")
        consoleMessages.push(`console.error ${message.text().slice(0, 300)}`);
    });
    page.on("pageerror", (error) =>
      consoleMessages.push(`pageerror ${error.message.slice(0, 300)}`),
    );
    const open = async (name: string, path: string, text: string) => {
      try {
        await page.goto(`${input.origin}${path}`, { waitUntil: "domcontentloaded" });
        await page.getByText(text).first().waitFor({ state: "visible", timeout: 60_000 });
        loaded.push({ name, ok: true, detail: path });
      } catch (cause) {
        await mkdir(input.evidence, { recursive: true });
        await page
          .screenshot({ path: resolve(input.evidence, `${input.label}-${name}.png`) })
          .catch(() => undefined);
        loaded.push({
          name,
          ok: false,
          detail: `${path}: ${cause instanceof Error ? (cause.message.split("\n")[0] ?? "") : String(cause)}`,
        });
      }
    };
    try {
      await signIn(page, input.origin, input.email, input.password);
      loaded.push({
        name: "admin sign-in",
        ok: true,
        detail: "the generated password still works",
      });
    } catch (cause) {
      loaded.push({
        name: "admin sign-in",
        ok: false,
        detail: cause instanceof Error ? (cause.message.split("\n")[0] ?? "") : String(cause),
      });
      return { loaded, consoleMessages };
    }
    await open("project", `/projects/${input.projectID}`, input.projectName);
    for (const ticket of input.tickets)
      await open(
        `ticket ${ticket.title}`,
        `/projects/${input.projectID}/tickets/${ticket.id}`,
        ticket.title,
      );
    await open(
      "wiki page",
      `/projects/${input.projectID}/wiki/${input.wiki.pageID}`,
      input.wiki.text,
    );
    // Late errors from the last page, for example a dropped planning-cache connection.
    await page.waitForTimeout(2_000);
    return { loaded, consoleMessages };
  } finally {
    await browser.close();
  }
}
