import { chromium, type Page } from "@playwright/test";

// One complete Ticket journey with the real model: idea, AI interview, product spec, design,
// implementation, independent review and delivery to Staging. Fails when any step stalls or ends
// in a failure that Retry cannot clear. Model rate limits get a few waits and retries.

const base = process.env["FACTORY_SOAK_BASE"] ?? "http://127.0.0.1:58510";
const project = process.env["FACTORY_SOAK_PROJECT"];
const state = process.env["FACTORY_SOAK_STATE"];
const namespace = process.env["FACTORY_SOAK_NAMESPACE"];
const release = process.env["FACTORY_SOAK_RELEASE"];
if (!project || !state || !namespace || !release)
  throw new Error(
    "Set FACTORY_SOAK_PROJECT, FACTORY_SOAK_STATE, FACTORY_SOAK_NAMESPACE and FACTORY_SOAK_RELEASE",
  );
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const title = process.env["FACTORY_SOAK_TITLE"] ?? `Soak note ${stamp}`;
const existing = Boolean(process.env["FACTORY_SOAK_TITLE"]);

let ticketID = "";
let ticketURL = "";

async function ticketState() {
  const child = Bun.spawn(
    [
      "kubectl",
      "--context",
      process.env["FACTORY_SOAK_CONTEXT"] ?? "orbstack",
      "-n",
      namespace as string,
      "exec",
      `${release}-postgres-0`,
      "--",
      "psql",
      "-U",
      "factory",
      "-d",
      "factory",
      "-At",
      "-c",
      ticketID
        ? `select state from factory.ticket where id='${ticketID}'`
        : `select state from factory.ticket where title='${title}' order by created_at desc limit 1`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return (await new Response(child.stdout).text()).trim();
}

async function openTicket(page: Page) {
  if (ticketURL) {
    await page.goto(ticketURL);
    await page.waitForTimeout(3_000);
    return;
  }
  await page.goto(`${base}/projects/${project}`);
  await page.getByRole("region", { name: "Ticket board" }).waitFor({ timeout: 60_000 });
  await page.getByRole("button").filter({ hasText: title }).first().click();
  await page.waitForTimeout(3_000);
  // The AI may rename the Ticket, so follow its address from here on.
  const match = /\/tickets\/([0-9a-f-]{36})/.exec(page.url());
  if (match) {
    ticketID = match[1] as string;
    ticketURL = page.url();
  }
}

const browser = await chromium.launch({ headless: true });
const log = (...parts: unknown[]) =>
  console.error(new Date().toISOString().slice(11, 19), ...parts);
try {
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  if (!existing) {
    await page.goto(`${base}/projects/${project}`);
    await page.getByRole("button", { name: /new ticket/i }).click();
    await page.getByRole("textbox", { name: "Ticket title", exact: true }).fill(title);
    await page
      .getByRole("textbox", { name: "Ticket description", exact: true })
      .fill(
        "Add one line to the end of docs/soak-log.md that says the soak check ran, with this ticket title. Create the file when it does not exist. Change nothing else.",
      );
    await page.getByRole("button", { name: /write requirements/i }).click();
    await page.waitForTimeout(5_000);
  }
  await openTicket(page);
  const ask = page.getByRole("button", { name: "Ask AI to clarify" });
  if (await ask.isVisible().catch(() => false)) await ask.click();
  const deadline = Date.now() + 90 * 60_000;
  let implemented = false;
  let retries = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(6_000);
    const finished = await ticketState();
    if (finished === "done") {
      console.log(JSON.stringify({ ok: true, title }));
      process.exit(0);
    }
    const resume = page.getByRole("button", { name: "Continue clarification" });
    if ((await resume.isVisible().catch(() => false)) && !(await page.getByRole("radio").count())) {
      await resume.click();
      await page.waitForTimeout(1_500);
    }
    if (await page.getByRole("radio").count()) {
      await page.getByRole("radio").first().check();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      continue;
    }
    const planning = page.getByRole("button", { name: "Continue technical planning" });
    if (await planning.isVisible().catch(() => false)) {
      await planning.click();
      log("continue technical planning");
      await page.waitForTimeout(10_000);
      continue;
    }
    const confirm = page.getByRole("button", { name: "Confirm product spec" });
    if ((await confirm.isVisible().catch(() => false)) && (await confirm.isEnabled())) {
      await confirm.click();
      continue;
    }
    const implement = page.getByRole("button", { name: "Implement", exact: true });
    if (!implemented && (await implement.isEnabled().catch(() => false))) {
      await implement.click();
      implemented = true;
      log("implement");
      continue;
    }
    const retry = page.getByRole("button", { name: /^Retry( review)?$/ }).first();
    if (implemented && (await retry.isVisible().catch(() => false))) {
      if (++retries > 4) throw new Error("The journey needed more than four retries");
      log("retry", await retry.innerText());
      await page.waitForTimeout(90_000);
      await retry.click();
      continue;
    }
    const deliver = page.getByRole("button", { name: /^Deliver/ }).first();
    if (implemented && (await deliver.isVisible().catch(() => false))) {
      await deliver.click();
      log("deliver");
      await page.waitForTimeout(5_000);
    }
    // The page can drop its selection after a reload; reopen the Ticket by its address.
    if (ticketID && !page.url().includes(ticketID)) await openTicket(page);
  }
  throw new Error("The Ticket journey did not finish in 90 minutes");
} finally {
  await browser.close();
}
