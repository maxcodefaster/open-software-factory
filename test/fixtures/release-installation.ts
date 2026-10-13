import { expect } from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as visible, type Page } from "@playwright/test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { installationDirectory, loadInstallation } from "../../scripts/factory/installation";

const stateInput = z
  .object({
    installation: z.string(),
    projectID: z.uuid().optional(),
    ticketID: z.uuid().optional(),
    dependentTicketID: z.uuid().optional(),
    rootEpicID: z.uuid().optional(),
    childEpicID: z.uuid().optional(),
    planningSkillID: z.uuid().optional(),
    buildSkillID: z.uuid().optional(),
    editedRevisionID: z.uuid().optional(),
    changeID: z.uuid().optional(),
    buildCommandID: z.uuid().optional(),
    inspectionCommandID: z.uuid().optional(),
    inspectionRetryCommandID: z.uuid().optional(),
    dependentChangeID: z.uuid().optional(),
    dependentCommandID: z.uuid().optional(),
    dependentRetryCommandID: z.uuid().optional(),
    verifiedSHA: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    deliveredSHA: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    completed: z.array(z.string()),
    timings: z.record(z.string(), z.number()),
  })
  .strict();
export type ReleaseState = z.infer<typeof stateInput>;

export async function releaseInstallation(name: string) {
  const root = resolve(import.meta.dir, "../..");
  const installation = await loadInstallation(root, name);
  if (installation.phase !== "active")
    throw new Error("Release journey requires an active disposable installation");
  const directory = installationDirectory(root, name);
  const evidence = resolve(root, ".factory/test-results/release-proof", name);
  await mkdir(evidence, { recursive: true });
  const stateFile = resolve(evidence, "journey.json");
  const stored = await readFile(stateFile, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  const state = stateInput.parse(
    stored ? JSON.parse(stored) : { installation: name, completed: [], timings: {} },
  );
  if (state.installation !== name)
    throw new Error("Release journey identity differs from installation");
  const base = `http://127.0.0.1:${installation.ports.factory}`;
  const repositoryURL = `http://127.0.0.1:${installation.ports.forgejo}/factory-mutation/runtime-fixture.git`;
  const secret = async (file: string) => (await readFile(resolve(directory, file), "utf8")).trim();
  const databasePassword = await secret("database-password");
  const original = process.env["DATABASE_URL"];
  let database: ReturnType<typeof createDatabase>;
  try {
    process.env["DATABASE_URL"] =
      `postgresql://factory:${databasePassword}@127.0.0.1:${installation.ports.postgres}/factory`;
    database = createDatabase(2);
  } finally {
    if (original === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = original;
  }
  const secrets = await Promise.all(
    ["admin-password", "database-password", "zero-password", "auth-secret", "forgejo-token"].map(
      secret,
    ),
  );
  const providerKey = process.env["FACTORY_MODEL_API_KEY"];
  if (providerKey) secrets.push(providerKey);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : {}),
  });
  const pageErrors = new Map<Page, string[]>();
  const slug = `release-${name}`;
  const credentials = (role: "admin" | "manager" | "developer" | "outsider") => ({
    email: `${role}-${name}@factory.local`,
    password:
      role === "admin"
        ? (secrets[0] ?? "")
        : role === "developer"
          ? "disposable-release-developer-password"
          : "disposable-release-account-password",
  });
  async function login(role: "admin" | "manager" | "developer" | "outsider") {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify(credentials(role)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Release ${role} sign-in failed with ${response.status}`);
    return response.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
  }
  async function request(cookie: string, path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
      redirect: "manual",
    });
    const text = await response.text();
    noSecrets(text);
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  }
  function noSecrets(text: string) {
    for (const value of secrets) expect(text.includes(value)).toBe(false);
  }
  function sanitize(text: string) {
    return secrets.reduce((value, secret) => value.replaceAll(secret, "<REDACTED>"), text);
  }
  async function command(cookie: string, path: string, method = "GET", body?: unknown) {
    const result = await request(cookie, path, method, body);
    if (result.status < 200 || result.status >= 300)
      throw new Error(`Release command ${path} failed with ${result.status}`);
    return result.body;
  }
  async function page(role: "admin" | "manager" | "developer") {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on("pageerror", (error) => errors.push((error.stack ?? error.message).slice(0, 4_000)));
    await page.goto(base);
    try {
      await page.getByLabel("Email").waitFor({ timeout: 5_000 });
    } catch {
      await page.screenshot({ path: resolve(evidence, `signin-${role}-failure.png`) });
      const safeErrors = errors.map((error) =>
        secrets.reduce((text, value) => text.replaceAll(value, "<REDACTED>"), error),
      );
      await writeFile(
        resolve(evidence, `signin-${role}-failure.json`),
        JSON.stringify({
          errors: safeErrors,
          body: (await page.locator("body").innerText()).slice(0, 2_000),
        }),
        { mode: 0o600 },
      );
      throw new Error(
        "Release login UI did not render; inspect its local screenshot and sanitized browser errors",
      );
    }
    await page.getByLabel("Email").fill(credentials(role).email);
    await page.getByLabel("Password").fill(credentials(role).password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await visible(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    expect(
      errors.map((error) =>
        secrets.reduce((text, value) => text.replaceAll(value, "<REDACTED>"), error),
      ),
    ).toEqual([]);
    return page;
  }
  async function selectProject(page: Page) {
    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button").filter({ hasText: slug }).click();
  }
  async function save(stage: string, elapsedMS: number) {
    state.completed = [...new Set([...state.completed, stage])];
    state.timings[stage] = Math.round(elapsedMS);
    await writeFile(`${stateFile}.next`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(`${stateFile}.next`, stateFile);
  }
  return {
    installation,
    state,
    database,
    browser,
    base,
    slug,
    repositoryURL,
    evidence,
    credentials,
    login,
    request,
    noSecrets,
    sanitize,
    command,
    page,
    selectProject,
    save,
    async record(name: string, value: unknown) {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid release evidence name");
      const text = `${JSON.stringify(value, null, 2)}\n`;
      noSecrets(text);
      await writeFile(resolve(evidence, `${name}.json`), text, { mode: 0o600 });
    },
    async capture(label: string) {
      const sanitize = (value: string) =>
        secrets.reduce((text, secret) => text.replaceAll(secret, "<REDACTED>"), value);
      for (const [index, [page, errors]] of [...pageErrors.entries()].entries()) {
        if (page.isClosed()) continue;
        await page.screenshot({ path: resolve(evidence, `${label}-page-${index}.png`) });
        await writeFile(
          resolve(evidence, `${label}-page-${index}.json`),
          JSON.stringify({
            body: sanitize((await page.locator("body").innerText()).slice(0, 6_000)),
            errors: errors.map(sanitize),
          }),
          { mode: 0o600 },
        );
      }
    },
    async close() {
      await browser.close();
      await database.client.end();
    },
  };
}
