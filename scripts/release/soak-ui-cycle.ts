import { chromium } from "@playwright/test";

// One soak cycle in the browser: open the Development Preview of the signed-in person. A paused
// Sandbox resumes by itself, so a cycle after the idle pause also proves Resume. Prints one JSON
// line and exits non-zero on any console error, page error, failed response or missing Preview.

const base = process.env["FACTORY_SOAK_BASE"] ?? "http://127.0.0.1:58510";
const project = process.env["FACTORY_SOAK_PROJECT"];
const state = process.env["FACTORY_SOAK_STATE"];
if (!project || !state) throw new Error("Set FACTORY_SOAK_PROJECT and FACTORY_SOAK_STATE");

const problems: string[] = [];
const browser = await chromium.launch({ headless: true });
const started = Date.now();
try {
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  // The Project's own App runs in an isolated origin. Its attempts to reach the parent are blocked
  // by design, so that refusal is not a Factory error.
  page.on("pageerror", (error) => {
    if (/Blocked a frame with origin .*runtime\.localhost/.test(error.message)) return;
    problems.push(`pageerror ${error.message.slice(0, 200)}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console ${message.text().slice(0, 200)}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${base}/projects/${project}`);
  await page.getByRole("region", { name: "Ticket board" }).waitFor({ timeout: 60_000 });
  const chooser = page.locator('button[aria-label="Choose Preview instance"]').first();
  const development = page.getByRole("menuitem").filter({ hasText: "Development" }).first();
  // A Project offers its Development Preview only while a Development environment exists. The
  // first cycle on a fresh Project opens the IDE, which creates it.
  await chooser.click();
  if (!(await development.isVisible().catch(() => false))) {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    const deadline = Date.now() + 300_000;
    for (;;) {
      await page.waitForTimeout(10_000);
      await chooser.click();
      if (await development.isVisible().catch(() => false)) break;
      await page.keyboard.press("Escape");
      if (Date.now() > deadline) throw new Error("No Development Preview after opening the IDE");
    }
  }
  await development.click();
  const frame = page.locator('iframe[title="Factory Preview"]');
  await frame.waitFor({ timeout: 180_000 });
  const opened = Date.now() - started;
  await page.waitForTimeout(3_000);
  const failure = await page
    .getByText(/could not be restored|Start fresh|could not start/i)
    .count();
  if (failure) problems.push("The Preview shows a failure panel");
  const text = await page
    .frameLocator('iframe[title="Factory Preview"]')
    .locator("body")
    .innerText({ timeout: 30_000 })
    .catch(() => "");
  if (!text.trim()) problems.push("The Preview frame is empty");
  console.log(JSON.stringify({ ok: problems.length === 0, openedMS: opened, problems }));
} catch (cause) {
  problems.push(`cycle ${(cause as Error).message.slice(0, 300)}`);
  console.log(JSON.stringify({ ok: false, problems }));
} finally {
  await browser.close();
}
process.exit(problems.length ? 1 : 0);
