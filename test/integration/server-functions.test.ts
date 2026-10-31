import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect as browserExpect, chromium } from "@playwright/test";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { factoryProcess } from "../fixtures/factory-process";
import {
  decodeFactoryResponse as decodeResponse,
  factoryFunctionMatches,
  factoryFunctionRequest,
} from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { fixtureValue } from "../fixtures/value";

test("production Server Functions use real sessions, durable exact saves and no HTTP usage routes", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors: string[] = [];
  let runner: ReturnType<typeof Bun.spawn> | undefined;
  const assets: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/assets/") && path.endsWith(".js")) assets.push(path);
  });
  try {
    await owned.startPlanningCache();
    const process = await owned.start();
    const cookie = await owned.signIn();
    await context.addCookies(
      cookie.split("; ").map((value) => {
        const split = value.indexOf("=");
        return { name: value.slice(0, split), value: value.slice(split + 1), url: owned.base };
      }),
    );
    await page.goto(owned.base);
    expect(assets.some((path) => path.includes("/document-engine-"))).toBe(false);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await chooseSettingsPage(page, "Monitoring", "Factory administration");
    const usage = page.getByRole("region", { name: "Usage & limits", exact: true });
    await browserExpect(usage.getByLabel("Monthly Coding allowance")).toHaveValue("");
    await usage.getByLabel("Monthly Coding allowance").fill("7");
    const saveRequest = page.waitForRequest(
      async (request) => await factoryFunctionMatches(request.url(), "saveUsage"),
    );
    await usage.getByRole("button", { name: "Save limits", exact: true }).click();
    const save = await saveRequest;
    await browserExpect(usage.getByText("Saved. Existing work is retained.")).toBeVisible();
    const originalHeaders = await save.allHeaders();
    const headers = {
      "content-type": fixtureValue(
        save.headers()["content-type"],
        'save.headers()["content-type"]',
      ),
      "x-server-function-format": fixtureValue(
        originalHeaders["x-server-function-format"],
        'originalHeaders["x-server-function-format"]',
      ),
      origin: owned.base,
      cookie,
    };
    const repeat = () =>
      fetch(save.url(), {
        method: "POST",
        headers,
        body: fixtureValue(save.postData(), "save.postData()"),
      });
    // Exact replay acknowledges the same persisted intent, without another version increment.
    const replay = await repeat();
    expect(replay.status).toBe(200);
    expect(await decodeResponse(replay)).toMatchObject({ ok: true });
    const invalid = await fetch(
      await factoryFunctionRequest(
        owned.base,
        "getEnvironment",
        ["not-a-project-id", "development"],
        { origin: owned.base, cookie },
      ),
    );
    expect(await decodeResponse(invalid)).toMatchObject({ ok: false, status: 400 });
    const oldDeployment = await fetch(`${owned.base}/_server/data/removed-old-deployment`, {
      method: "POST",
      headers: { origin: owned.base, cookie },
    });
    expect(oldDeployment.status).toBe(404);
    expect(oldDeployment.headers.get("x-server-function-unknown")).toBe("true");
    const [saved] = await database.client<Array<{ version: number; amount: number }>>`
      SELECT version::int AS version,(policy->>'codingUSD')::int AS amount
      FROM factory.execution_policy WHERE scope='factory'`;
    expect(saved).toEqual({ version: 1, amount: 7 });
    expect(
      (await database.client`SELECT command_id FROM factory.execution_policy_command`).length,
    ).toBe(1);
    expect(
      (
        await fetch(save.url(), {
          method: "POST",
          headers: { ...headers, origin: "https://foreign.invalid" },
          body: fixtureValue(save.postData(), "save.postData()"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(save.url(), {
          method: "POST",
          headers: { origin: owned.base },
          body: fixtureValue(save.postData(), "save.postData()"),
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${owned.base}/api/admin/usage`, { headers: { cookie } })).status).toBe(
      404,
    );
    const directory = ".factory/test-results/server-functions";
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/usage-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${directory}/usage-narrow.png`, fullPage: true });
    // Host-created CommandError must survive the compiled-handler boundary.
    await database.client`UPDATE auth.session SET authenticated_at=now()-interval '1 day'`;
    await usage.getByLabel("Monthly Coding allowance").fill("8");
    await usage.getByRole("button", { name: "Save limits", exact: true }).click();
    await browserExpect(usage.getByRole("alert")).toContainText("Sign in again");
    expect(
      (
        await database.client`SELECT version::int AS version FROM factory.execution_policy WHERE scope='factory'`
      )[0]?.["version"],
    ).toBe(1);
    await database.client`UPDATE auth.session SET authenticated_at=now()`;
    await owned.kill(process);
    await owned.start();
    expect(await decodeResponse(await repeat())).toMatchObject({ ok: true });
    expect(
      (await database.client`SELECT command_id FROM factory.execution_policy_command`).length,
    ).toBe(1);
    expect(errors).toEqual([]);
    expect(assets.some((path) => path.includes("/document-engine-"))).toBe(false);
    const clientDirectory = resolve(factoryBuildDirectory(), "client");
    for await (const path of new Bun.Glob("assets/*.js").scan(clientDirectory)) {
      const source = await Bun.file(resolve(clientDirectory, path)).text();
      expect(source.includes("Missing authenticated Factory request context")).toBe(false);
      expect(source.includes("SELECT id,kubernetes_namespace AS namespace")).toBe(false);
    }
    await writeFile(
      `${directory}/production-proof.json`,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          initialAndSettingsJS: assets,
          editorEngineLoaded: assets.some((path) => path.includes("/document-engine-")),
          realSession: true,
          exactSaveReplayed: true,
          restartRetainedIntent: true,
          foreignOriginDenied: true,
          anonymousDenied: true,
          staleAuthenticationDenied: true,
          legacyUsageEndpointRemoved: true,
          browserErrors: errors,
        },
        null,
        2,
      ),
    );
    await context.close();
    // Reuse the maintained UI regression against this owned installation, never the user's.
    const projectID = crypto.randomUUID();
    const administrator = "01994a7d-0000-7000-8000-000000000001";
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`factory-starter-${owned.id.slice(0, 8)}`},'factory-starter',
        'https://example.invalid/owned-browser.git','main','.devcontainer/devcontainer.json',${administrator})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${administrator},'developer',true,${administrator})`;
    const childRunner = Bun.spawn(
      [
        globalThis.process.execPath,
        "--no-env-file",
        "node_modules/@playwright/test/cli.js",
        "test",
        "test/browser/usage-settings.spec.ts",
        "test/browser/document-loading.spec.ts",
        "test/browser/model-settings.spec.ts",
        "test/browser/project-environment.spec.ts",
        "test/browser/model-inheritance.spec.ts",
        "test/browser/model-availability.spec.ts",
        "test/browser/agent-configuration.spec.ts",
        "test/browser/project-access.spec.ts",
        "test/browser/project-setup-navigation.spec.ts",
        "test/browser/project-setup-observation.spec.ts",
        "--reporter=line",
      ],
      {
        env: {
          ...globalThis.process.env,
          FACTORY_BROWSER_LANE: "ui",
          FACTORY_BROWSER_BASE_URL: owned.base,
          DATABASE_URL: owned.databaseURL,
          FACTORY_ADMIN_EMAIL: `owned-${owned.id}@factory.local`,
          FACTORY_ADMIN_PASSWORD: "owned-process-password-not-a-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    runner = childRunner;
    await writeFile(`${directory}/browser-fixtures.log`, "");
    const log = Bun.file(`${directory}/browser-fixtures.log`).writer();
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) log.write(chunk);
    };
    const [, , status] = await Promise.all([
      drain(childRunner.stdout),
      drain(childRunner.stderr),
      childRunner.exited,
    ]);
    await log.end();
    expect(status).toBe(0);
    expect((await database.client`SELECT id FROM factory.runtime_attempt`).length).toBe(0);
    expect((await database.client`SELECT id FROM factory.development_workspace`).length).toBe(0);
    expect((await database.client`SELECT id FROM factory.agent_turn`).length).toBe(0);
  } finally {
    if (runner?.exitCode === null) runner.kill("SIGTERM");
    await runner?.exited;
    await browser.close();
    await database.client.end();
    await owned.dispose();
  }
}, 300_000);
