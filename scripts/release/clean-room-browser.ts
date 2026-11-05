// The browser half of the clean-room run. It drives the installed Factory as a person would and
// reports each step to the caller. Nothing here knows about Kubernetes.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";
import {
  type Check,
  type ConsoleEntry,
  consoleProblems,
  projectLimit,
  type ResponseEntry,
  redact,
  serverErrors,
  settingsLimit,
  wikiLimit,
} from "./clean-room-model";

export type JourneyInput = {
  origin: string;
  email: string;
  password: string;
  id: string;
  withSandbox: boolean;
  directory: string;
};

export type JourneyResult = {
  checks: Check[];
  limits: string[];
  screenshots: string[];
  ignoredUnauthenticated: number;
};

const settle = (page: Page, ms: number) => page.waitForTimeout(ms);

async function openSettingsModels(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const workspace = page
    .getByRole("region", { name: "Settings", exact: true })
    .and(page.locator(".settings-workspace"));
  await workspace.waitFor({ state: "visible", timeout: 60_000 });
  const navigation = workspace.getByRole("navigation", { name: "Settings navigation" });
  if (!(await navigation.isVisible()))
    await workspace.getByRole("button", { name: /choose settings page$/i }).click();
  const picker = navigation.getByRole("combobox", { name: "Settings scope", exact: true });
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  await picker.focus();
  await picker.selectOption("system");
  if (!(await navigation.isVisible()))
    await workspace.getByRole("button", { name: /choose settings page$/i }).click();
  await navigation
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Factory administration", exact: true }) })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await workspace
    .getByRole("status")
    .filter({ hasText: /^Opening settings…$/ })
    .waitFor({
      state: "detached",
      timeout: 30_000,
    });
  await settle(page, 3_000);
  const alerts = await workspace.getByRole("alert").allTextContents();
  if (alerts.length) throw new Error(`The Models page shows an alert: ${alerts.join(" | ")}`);
  return workspace;
}

async function createStarter(page: Page, input: JourneyInput) {
  const switcher = page.getByRole("button", { name: /open project menu$/i });
  if (!(await switcher.isVisible()))
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await switcher.click();
  await page
    .locator(".project-menu")
    .getByRole("button", { name: /Create project|Continue setup/ })
    .click();
  const panel = page.getByRole("region", { name: "Project setup", exact: true });
  await panel.waitFor({ state: "visible", timeout: 30_000 });
  await panel.getByRole("button", { name: "Starter" }).click();
  await panel.getByLabel("Project name", { exact: true }).fill(`Clean room ${input.id}`);
  await panel.getByLabel("Repository name", { exact: true }).fill(`clean-room-${input.id}`);
  await settle(page, 1_000);
  await panel.getByRole("button", { name: "Create project", exact: true }).click();
  const open = panel.getByRole("button", { name: "Open project", exact: true });
  await open.waitFor({ state: "visible", timeout: 240_000 });
  await open.click();
  await page
    .getByRole("region", { name: "Ticket board" })
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function createTicket(page: Page, title: string) {
  await page.getByRole("button", { name: "New Ticket", exact: true }).click();
  await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(title);
  await page
    .getByRole("textbox", { name: "Ticket description", exact: true })
    .fill("Created by the clean-room install test.");
  await page.getByRole("button", { name: "Create as idea", exact: true }).click();
  const heading = page.getByRole("textbox", { name: "Ticket title", exact: true });
  await heading.waitFor({ state: "visible", timeout: 60_000 });
  const editor = page.getByRole("textbox", { name: "Ticket description", exact: true });
  await editor.fill("Edited by the clean-room install test.");
  await settle(page, 3_000);
  await page.reload();
  await page
    .getByRole("region", { name: "Ticket board" })
    .waitFor({ state: "visible", timeout: 60_000 });
  await page
    .getByText(title, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function editWiki(page: Page, marker: string): Promise<"edited" | "no-pages"> {
  await page.getByRole("button", { name: "Wiki", exact: true }).click();
  await settle(page, 3_000);
  const edit: Locator = page.getByLabel("Edit Wiki body", { exact: true });
  if (!(await edit.isVisible())) return "no-pages";
  await edit.click();
  const body = page.getByRole("textbox", { name: "Wiki body", exact: true });
  await body.press("ControlOrMeta+End");
  await body.press("Enter");
  await body.pressSequentially(marker);
  await settle(page, 4_000);
  await page.reload();
  await page
    .getByRole("region", { name: "Ticket board" })
    .waitFor({ state: "visible", timeout: 60_000 });
  await page
    .getByText(marker, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  return "edited";
}

export async function browserJourney(input: JourneyInput): Promise<JourneyResult> {
  await mkdir(input.directory, { recursive: true });
  const checks: Check[] = [];
  const limits: string[] = [];
  const screenshots: string[] = [];
  const consoleEntries: ConsoleEntry[] = [];
  const responses: ResponseEntry[] = [];
  const secrets = [input.password];
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let signedIn = false;

  const step = async (
    name: string,
    work: () => Promise<string | { skipped: string }>,
    precondition = true,
  ) => {
    const started = performance.now();
    const finish = (status: Check["status"], detail: string) =>
      checks.push({
        name,
        status,
        detail: redact(detail, secrets).slice(0, 600),
        durationMs: Math.round(performance.now() - started),
      });
    if (!precondition) return finish("failed", "An earlier browser step failed");
    try {
      const result = await work();
      if (typeof result === "string") finish("passed", result);
      else finish("skipped", result.skipped);
    } catch (cause) {
      finish("failed", cause instanceof Error ? cause.message : String(cause));
    }
  };
  const shot = async (page: Page, name: string) => {
    const path = join(input.directory, `${name}.png`);
    await page.screenshot({ path }).catch(() => undefined);
    screenshots.push(path);
  };

  try {
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  } catch (cause) {
    const detail = `Chromium did not start: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}. Run bunx playwright install chromium, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.`;
    for (const name of [
      "sign-in",
      "settings-models",
      "project-starter",
      "ticket",
      "wiki-edit",
      "browser-clean",
    ])
      checks.push({ name, status: "failed", detail, durationMs: 0 });
    return { checks, limits, screenshots, ignoredUnauthenticated: 0 };
  }
  try {
    const context = await browser.newContext({
      baseURL: input.origin,
      viewport: { width: 1440, height: 960 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("console", (message) =>
      consoleEntries.push({ type: message.type(), text: message.text() }),
    );
    page.on("pageerror", (error) => consoleEntries.push({ type: "error", text: error.message }));
    page.on("response", (response) =>
      responses.push({ status: response.status(), url: response.url() }),
    );

    await step("sign-in", async () => {
      await page.goto("/");
      await page.getByLabel("Email").fill(input.email);
      await page.getByLabel("Password").fill(input.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page
        .getByRole("button", { name: "Settings", exact: true })
        .waitFor({ state: "visible", timeout: 90_000 });
      signedIn = true;
      await shot(page, "01-signed-in");
      return `${input.email} signed in and the shell loaded`;
    });

    await step(
      "settings-models",
      async () => {
        await openSettingsModels(page);
        await shot(page, "02-settings-models");
        limits.push(settingsLimit);
        return "Factory settings Models page loaded without an alert";
      },
      signedIn,
    );

    if (!input.withSandbox) {
      limits.push(projectLimit);
      await step("project-starter", async () => ({ skipped: projectLimit }), signedIn);
      await step(
        "ticket",
        async () => ({ skipped: "Needs a Project. See project-starter." }),
        signedIn,
      );
    } else {
      let created = false;
      await step(
        "project-starter",
        async () => {
          await page.goto("/");
          await createStarter(page, input);
          created = true;
          await shot(page, "03-board");
          return `Starter Project clean-room-${input.id} created and its board opened`;
        },
        signedIn,
      );
      await step(
        "ticket",
        async () => {
          await createTicket(page, `Clean room ticket ${input.id}`);
          await shot(page, "04-ticket");
          return "Ticket created as an idea, edited and still on the board after a reload";
        },
        created,
      );
    }

    await step(
      "wiki-edit",
      async () => {
        if (!input.withSandbox) {
          limits.push(wikiLimit);
          return { skipped: `${wikiLimit} A Project is also needed.` };
        }
        const outcome = await editWiki(page, `Clean room edit ${input.id}`);
        if (outcome === "no-pages") {
          limits.push(wikiLimit);
          return { skipped: wikiLimit };
        }
        await shot(page, "05-wiki");
        return "Wiki page edited and the edit survived a reload";
      },
      signedIn,
    );

    await step("browser-clean", async () => {
      const problems = consoleProblems(consoleEntries);
      const failures = serverErrors(responses);
      if (problems.errors.length || failures.length)
        throw new Error(
          `${problems.errors.length} console errors, ${failures.length} responses with status 500 or more. ${[...problems.errors, ...failures].slice(0, 3).join(" | ")}`,
        );
      return `0 console errors and no 5xx in ${responses.length} responses (${problems.ignoredUnauthenticated} unauthenticated 401 probes ignored)`;
    });
    await context.close();
  } finally {
    await browser.close().catch(() => undefined);
  }
  return {
    checks,
    limits: [...new Set(limits)],
    screenshots,
    ignoredUnauthenticated: consoleProblems(consoleEntries).ignoredUnauthenticated,
  };
}
