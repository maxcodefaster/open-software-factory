import { chromium } from "@playwright/test";

// One Wiki update through the UI. Factory calls the model only when the sources changed, so most
// runs finish in seconds. Waits for the newest generation to settle and fails on anything but success.

const base = process.env["FACTORY_SOAK_BASE"] ?? "http://127.0.0.1:58510";
const project = process.env["FACTORY_SOAK_PROJECT"];
const state = process.env["FACTORY_SOAK_STATE"];
const namespace = process.env["FACTORY_SOAK_NAMESPACE"];
const release = process.env["FACTORY_SOAK_RELEASE"];
if (!project || !state || !namespace || !release)
  throw new Error(
    "Set FACTORY_SOAK_PROJECT, FACTORY_SOAK_STATE, FACTORY_SOAK_NAMESPACE and FACTORY_SOAK_RELEASE",
  );

async function latestGeneration() {
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
      "-F",
      "|",
      "-c",
      "select id, state, coalesce(failure,'') from factory.knowledge_generation order by created_at desc limit 1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = (await new Response(child.stdout).text()).trim();
  const [id = "", generation = "", failure = ""] = text.split("|");
  return { id, state: generation, failure };
}

const before = await latestGeneration();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ storageState: state });
  const page = await context.newPage();
  await page.goto(`${base}/projects/${project}`);
  await page.getByRole("button", { name: "Wiki", exact: true }).click();
  await page.locator("[aria-label*=ctions i], [aria-label*=ore i]").first().click();
  await page.getByRole("menuitem", { name: "Update Project Wiki" }).click();
  const deadline = Date.now() + 25 * 60_000;
  for (;;) {
    await page.waitForTimeout(5_000);
    const now = await latestGeneration();
    if (now.id !== before.id && now.state === "succeeded") {
      console.log(JSON.stringify({ ok: true, generation: now.id }));
      break;
    }
    if (now.id !== before.id && ["failed", "uncertain", "cancelled"].includes(now.state))
      throw new Error(`Wiki generation ${now.state}: ${now.failure.slice(0, 300)}`);
    if (Date.now() > deadline) throw new Error("Wiki generation did not settle in 25 minutes");
  }
} finally {
  await browser.close();
}
