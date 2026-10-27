import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { z } from "zod";
import { CommandError } from "../../apps/factory/src/command-error";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import type {
  MCPLibraryView,
  MCPRole,
  mcpSaveInput,
} from "../../packages/conversation-domain/src/mcp-library";
import type { monitoringSave } from "../../packages/conversation-domain/src/monitoring";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import {
  browserFunction,
  factoryFunctionMatches,
  mockFactoryFunctions,
} from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { fixtureValue } from "../fixtures/value";

test("Project Inputs separate automatic preparation, source access, explicit Autofix and one-time keys", async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/skill-browser-host.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const fixture = await new Promise<z.infer<typeof ready>>((resolve, reject) => {
    createInterface({ input: host.stdout }).on("line", (line) => {
      if (line.startsWith('{"fixtureBase"')) {
        try {
          resolve(ready.parse(JSON.parse(line)));
        } catch (cause) {
          reject(cause);
        }
      }
    });
    host.once("exit", () => reject(new Error(`Owned browser host exited: ${stderr.slice(-2000)}`)));
  });
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = fixture.databaseURL;
  const database = createDatabase(1);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  const projectId = crypto.randomUUID();
  const projectName = `Monitoring proof ${projectId.slice(0, 8)}`;
  const evidence = ".factory/test-results/inputs/ui";
  const errors: string[] = [];
  page.on("pageerror", (cause) => errors.push(cause.message));
  const monitoring = page.getByRole("region", { name: "Project inputs", exact: true });
  const editor = monitoring.getByRole("form", { name: "Input configuration" });
  const mcpUI = page.locator(".mcp-library");
  const consent = editor.getByRole("checkbox", { name: /^I authorize Factory/ });
  const save = editor.getByRole("button", { name: /^(Create input|Save & enable)$/ });
  const definitionCreated = Promise.withResolvers<z.input<typeof mcpSaveInput>>();
  await mockFactoryFunctions(page, {
    mcp: {
      async save(_actor, input) {
        const result = await serverCall(browserFunction(page, "saveMCPDefinition", [input]));
        definitionCreated.resolve(input);
        return result;
      },
    },
  });
  const peer = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const peerPage = await peer.newPage();
  peerPage.on("pageerror", (cause) => errors.push(cause.message));
  async function signIn(current: Page, email: string, password: string) {
    await current.goto(fixture.fixtureBase);
    await current.getByLabel("Email", { exact: true }).fill(email);
    await current.getByLabel("Password", { exact: true }).fill(password);
    await current.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(current.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  }
  async function open(current: Page) {
    await openProjectMenu(current);
    await current.getByRole("button", { name: new RegExp(projectName) }).click();
    await current.getByRole("button", { name: "Settings", exact: true }).click();
    await current.getByRole("button", { name: "Open settings", exact: true }).click();
    await chooseSettingsPage(current, "Inputs");
  }
  async function noOverflow() {
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    for (const element of [page.locator(".settings-content"), monitoring])
      expect(
        await element.evaluate((node) => node.scrollWidth - node.clientWidth),
      ).toBeLessThanOrEqual(1);
  }
  try {
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, `owned-${fixture.id}@factory.local`, "owned-process-password-not-a-secret");
    const [admin] = await database.client<
      { id: string }[]
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!admin) throw new Error("Owned monitoring administrator is missing");
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectId},${`monitoring-ui-${projectId}`},${projectName},'https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${admin.id})`;
    await open(page);
    await expect(monitoring.getByText("Give external requests a place to land")).toBeVisible();
    await monitoring.getByRole("button", { name: "Add input", exact: true }).click();
    await editor.getByLabel("Name", { exact: true }).fill("Product feedback");
    await expect(editor.getByLabel("Task", { exact: true })).toHaveValue(
      /Understand incoming requests/,
    );
    await expect(save).toBeEnabled();
    await expect(editor.getByRole("combobox")).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/creator-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await page.screenshot({ path: `${evidence}/creator-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Settings navigation" });
    // A personal draft is never silently converted into a shared monitoring connection.
    await navigation.getByRole("button", { name: "MCP connections", exact: true }).click();
    await page.getByRole("button", { name: "Add MCP", exact: true }).click();
    await mcpUI.getByLabel("Name", { exact: true }).fill("Keep my personal draft");
    await navigation.getByRole("button", { name: "Inputs", exact: true }).click();
    await monitoring.getByRole("button", { name: "Add input", exact: true }).click();
    await editor.getByRole("button", { name: "Add source", exact: true }).click();
    await editor.getByRole("button", { name: "Connect a service", exact: true }).click();
    const setup = page.getByRole("region", { name: "Input connection setup", exact: true });
    await expect(setup).toContainText(projectName);
    await page.getByRole("button", { name: "Resume draft", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("draft outside this Project setup");
    await expect(page.getByRole("button", { name: "Save definition", exact: true })).toBeDisabled();
    await navigation.getByRole("button", { name: "MCP connections", exact: true }).click();
    await expect(mcpUI.getByLabel("Name", { exact: true })).toHaveValue("Keep my personal draft");
    await expect(page.getByRole("combobox", { name: "Save in", exact: true })).toHaveValue(
      "personal",
    );
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await navigation.getByRole("button", { name: "Inputs", exact: true }).click();
    await editor.getByRole("button", { name: "Connect a service", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose a source" })).toBeVisible();
    await page.screenshot({ path: `${evidence}/source-picker-desktop.png`, fullPage: true });
    await page.getByRole("button", { name: "Other service", exact: true }).click();
    await expect(page.getByLabel("MCP endpoint", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Save in", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await setup.getByRole("button", { name: "Back to inputs", exact: true }).click();
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Connect a service", exact: true }).click();
    await page.getByRole("button", { name: "Set up Sentry", exact: true }).click();
    await expect(mcpUI.getByLabel("Name", { exact: true })).toHaveValue("Sentry");
    await expect(page.getByRole("combobox", { name: "Save in", exact: true })).toBeHidden();
    await expect(page.getByLabel("MCP endpoint", { exact: true })).toBeHidden();
    await mcpUI.getByLabel("Name", { exact: true }).fill("Project Sentry");
    await page.screenshot({ path: `${evidence}/source-settings-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "Save connection", exact: true }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${evidence}/source-settings-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByText("Connection settings", { exact: true }).click();
    await expect(page.getByLabel("MCP endpoint", { exact: true })).toHaveValue(
      "https://mcp.sentry.dev/mcp",
    );
    await page
      .getByLabel("When to use", { exact: true })
      .fill("Read this Project's error details.");
    await expect(page.getByLabel("MCP endpoint", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Authentication", exact: true })).toHaveValue(
      "oauth",
    );
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    const savedDefinition = await definitionCreated.promise;
    expect(savedDefinition).toMatchObject({
      scope: "project",
      projectId,
      content: { name: "Project Sentry", provider: "sentry", roles: ["planning", "build"] },
    });
    const contextualSourceId = savedDefinition.libraryId;
    const detail = page.getByRole("region", { name: "MCP details", exact: true });
    const useSource = detail.getByRole("button", { name: "Use for Input", exact: true });
    await expect(useSource).toBeDisabled();
    await expect(detail.getByRole("region", { name: "MCP availability" })).toBeHidden();
    // Only provider authorization/discovery is synthetic. Definitions, human read-only
    // approval, eligibility and the return to the webhook use the actual Factory API.
    const discovered = [
      {
        name: "read_issue",
        description: "Read the owned synthetic incident",
        inputSchema: { type: "object", properties: {} },
        digest: "c".repeat(64),
        readOnlyHint: true,
      },
      {
        name: "delete_issue",
        description: "Synthetic write tool. Do not approve.",
        inputSchema: { type: "object", properties: {} },
        digest: "d".repeat(64),
        readOnlyHint: false,
      },
    ];
    const stopConnectMock = await mockFactoryFunctions(page, {
      mcp: {
        async connect(_actor, id, input) {
          expect(id).toBe(contextualSourceId);
          expect(input.revisionId).toBe(savedDefinition.revisionId);
          await database.client`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,tools,authorized_by)
        VALUES(${contextualSourceId},${savedDefinition.revisionId},'authorizing',1,${crypto.randomUUID()},${JSON.stringify(discovered)}::jsonb,${admin.id})`;
          return { authorizationUrl: "https://authorization.example/owned-ui-proof" };
        },
      },
    });
    await detail.getByRole("button", { name: "Connect", exact: true }).click();
    const signInLink = detail.getByRole("link", { name: "Continue sign-in" });
    await expect(signInLink).toBeVisible();
    await expect(
      page.locator(".mcp-library").getByRole("status").filter({ hasText: "Loading connections" }),
    ).toHaveCount(0);
    await signInLink.focus();
    await expect(signInLink).toBeFocused();
    await expect(
      page.locator(".mcp-library").getByRole("status").filter({ hasText: "Loading connections" }),
    ).toHaveCount(0);
    await expect(useSource).toBeDisabled();
    await database.client`UPDATE factory.mcp_connection SET state='review',version=2 WHERE id=${contextualSourceId}`;
    const access = detail.getByRole("region", { name: "Read-only tool review", exact: true });
    await expect(access).toBeVisible();
    await expect(detail.getByRole("link", { name: "Continue sign-in" })).toBeHidden();
    await access.getByRole("checkbox", { name: "read_issue", exact: true }).check();
    await expect(
      access.getByRole("checkbox", { name: "delete_issue", exact: true }),
    ).not.toBeChecked();
    await expect(access.getByRole("button", { name: "Approve read-only access" })).toBeDisabled();
    await access.getByRole("checkbox", { name: /I verified/ }).check();
    await access.getByRole("button", { name: "Approve read-only access" }).click();
    await expect(useSource).toBeEnabled();
    await useSource.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/source-approved-desktop.png`, fullPage: true });
    await useSource.focus();
    await page.keyboard.press("Enter");
    await expect(editor.getByRole("heading", { name: "New input", exact: true })).toBeFocused();
    await expect(
      editor.getByRole("button", { name: "Remove Project Sentry", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${evidence}/source-returned-desktop.png`, fullPage: true });
    await editor.getByLabel("Name", { exact: true }).fill("Source-enriched feedback");
    await expect(save).toBeEnabled();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await navigation.getByRole("button", { name: "MCP connections", exact: true }).click();
    const libraryActions = page.locator('summary[aria-label="MCP library actions"]');
    await expect(libraryActions).toBeVisible();
    await libraryActions.click();
    await expect(page.getByRole("button", { name: "Manage", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await navigation.getByRole("button", { name: "Inputs", exact: true }).click();
    await stopConnectMock();
    const sourceView = await serverCall(browserFunction(page, "getMCPLibrary", [projectId]));
    expect(sourceView.choices).toHaveLength(0);
    expect(
      sourceView.entries.find((entry) => entry.id === contextualSourceId)?.connection?.allowedTools,
    ).toEqual(["read_issue"]);
    // Remove synthetic discovery from the later eligibility matrix, not the definition.
    await database.client`UPDATE factory.mcp_connection SET state='revoked',version=4 WHERE id=${contextualSourceId}`;
    await page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "Inputs", exact: true })
      .click();

    // Only discovery/approval state is synthetic in this UI fixture. It never calls a provider
    // or sends an executable alert. SDK/controller and live lanes cover those boundaries.
    const tool = {
      name: "read_issue",
      description: "Read the owned synthetic incident",
      inputSchema: { type: "object", properties: {} },
      digest: "b".repeat(64),
      readOnlyHint: true,
    };
    const allowed = [{ name: tool.name, digest: tool.digest }];
    const sourceId = crypto.randomUUID();
    for (const source of [
      {
        id: sourceId,
        scope: "project",
        roles: ["planning", "build"],
        name: "Reviewed Project source",
      },
      {
        id: crypto.randomUUID(),
        scope: "personal",
        roles: ["planning", "build"],
        name: "Private source",
      },
      {
        id: crypto.randomUUID(),
        scope: "system",
        roles: ["planning", "build"],
        name: "Factory source without grant",
      },
      {
        id: crypto.randomUUID(),
        scope: "project",
        roles: ["planning"],
        name: "Planning-only source",
      },
    ] satisfies Array<{
      id: string;
      scope: MCPLibraryView["entries"][number]["scope"];
      roles: MCPRole[];
      name: string;
    }>) {
      const revisionId = crypto.randomUUID();
      expect(
        await browserFunction(page, "saveMCPDefinition", [
          {
            libraryId: source.id,
            revisionId,
            expectedRevision: 0,
            scope: source.scope,
            ...(source.scope === "project" ? { projectId } : {}),
            content: {
              name: source.name,
              description: "Synthetic source for UI permission checks.",
              endpoint: "https://source.example/mcp",
              provider: "custom",
              authentication: "none",
              roles: source.roles,
            },
          },
        ]),
      ).toMatchObject({ ok: true });
      await database.client`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,tools,allowed_tools,authorized_by)
        VALUES(${source.id},${revisionId},'ready',1,${crypto.randomUUID()},${JSON.stringify([tool])}::jsonb,${JSON.stringify(allowed)}::jsonb,${admin.id})`;
    }
    await monitoring.getByRole("button", { name: "Add input", exact: true }).click();
    await expect(editor.getByRole("heading", { name: "New input", exact: true })).toBeFocused();
    await editor.getByRole("button", { name: "Add source", exact: true }).click();
    await expect(editor.getByRole("checkbox", { name: /Reviewed Project source/ })).toBeVisible();
    await expect(editor.getByText("Private source", { exact: true })).toHaveCount(0);
    await expect(editor.getByText("Factory source without grant", { exact: true })).toHaveCount(0);
    await expect(editor.getByText("Planning-only source", { exact: true })).toHaveCount(0);
    await editor.getByRole("checkbox", { name: /Reviewed Project source/ }).check();
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Invoice errors");
    expect(
      await editor
        .locator("label")
        .first()
        .evaluate((element) => getComputedStyle(element).textTransform),
    ).toBe("none");
    await editor.getByText("Automatic implementation", { exact: true }).click();
    await editor.getByRole("checkbox", { name: "Enable application Autofix and Delivery" }).check();
    await expect(save).toBeDisabled();
    await consent.check();
    await expect(save).toBeEnabled();
    await editor.getByRole("button", { name: "Connect a service", exact: true }).click();
    await page
      .getByRole("button", { name: "Inspect Reviewed Project source", exact: true })
      .click();
    await page.getByRole("button", { name: "Use for Input", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
      "Invoice errors",
    );
    await expect(consent).not.toBeChecked();
    await consent.check();
    // A refreshed source approval invalidates the previous consent, even in an open draft.
    await database.client`UPDATE factory.mcp_connection SET version=2 WHERE id=${sourceId}`;
    await expect(consent).not.toBeChecked();
    await expect(save).toBeDisabled();
    await consent.check();
    await noOverflow();
    await page.screenshot({ path: `${evidence}/delegation-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await consent.scrollIntoViewIfNeeded();
    await noOverflow();
    await page.screenshot({ path: `${evidence}/delegation-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });

    const commands: z.input<typeof monitoringSave>[] = [];
    let loseAcknowledgement = true;
    const stopSaveMock = await mockFactoryFunctions(
      page,
      {
        inputs: {
          async save(_actor, project, input) {
            commands.push(input);
            return serverCall(browserFunction(page, "saveProjectInput", [project, input]));
          },
        },
      },
      (name) => {
        if (name !== "saveProjectInput" || !loseAcknowledgement) return false;
        loseAcknowledgement = false;
        return true;
      },
    );
    await save.click();
    await expect(monitoring.getByRole("button", { name: "Retry same command" })).toBeVisible();
    await expect(save).toBeDisabled();
    await monitoring.getByRole("button", { name: "Retry same command" }).click();
    const secret = monitoring.getByRole("region", { name: "New webhook URL" });
    await expect(secret).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    const [counts] = await database.client<{ hooks: number; policies: number; commands: number }[]>`
      SELECT (SELECT count(*)::int FROM factory.monitoring_hook) AS hooks,
        (SELECT count(*)::int FROM factory.monitoring_policy) AS policies,
        (SELECT count(*)::int FROM factory.monitoring_command) AS commands`;
    expect(counts).toEqual({ hooks: 1, policies: 1, commands: 1 });
    const url = await secret.getByLabel("Webhook URL", { exact: true }).inputValue();
    await expect(secret.getByLabel("Webhook URL", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await secret.getByRole("button", { name: "Reveal URL" }).click();
    await expect(secret.getByLabel("Webhook URL", { exact: true })).toHaveAttribute("type", "text");
    await secret.getByRole("button", { name: "Hide URL" }).click();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.fixtureBase });
    await secret.getByRole("button", { name: "Copy URL" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.screenshot({ path: `${evidence}/created-desktop.png`, fullPage: true });
    await page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "MCP connections", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Settings navigation" })
      .getByRole("button", { name: "Inputs", exact: true })
      .click();
    await expect(secret).toBeHidden();
    await expect(monitoring.locator(":scope > .input-message[role='status']")).toHaveCount(0);

    const hook = monitoring.getByRole("article", { name: "Invoice errors input", exact: true });
    async function openActions() {
      if (
        !(await hook.locator(".input-row-menu").evaluate((node: HTMLDetailsElement) => node.open))
      )
        await hook.getByLabel("Actions for Invoice errors").click();
    }
    await openActions();
    await hook.getByRole("button", { name: "Disable input", exact: true }).focus();
    // An unchanged projection invalidation must not replace a focused control.
    const read = page.waitForResponse(
      async (response) => await factoryFunctionMatches(response.url(), "getProjectInputs"),
    );
    await database.client`SELECT factory.touch_read_version(${projectId},'inputs',${projectId})`;
    await read;
    await expect(hook.getByRole("button", { name: "Disable input", exact: true })).toBeFocused();
    await hook.getByRole("button", { name: "Disable input", exact: true }).click();
    await expect(hook).toContainText("Disabled");
    expect((await page.request.post(url, { data: { title: "Must not run" } })).status()).toBe(404);
    await openActions();
    await hook.getByRole("button", { name: "Edit input", exact: true }).click();
    await expect(consent).not.toBeChecked();
    await consent.check();
    await save.click();
    await expect(hook).toContainText("Enabled");
    await openActions();
    await hook.getByRole("button", { name: "Rotate key…" }).click();
    await expect(monitoring).toContainText("The old URL will stop working");
    await monitoring.getByRole("button", { name: "Cancel rotation" }).click();
    await expect(monitoring.getByRole("button", { name: "Rotate key and disable" })).toBeHidden();
    await openActions();
    await hook.getByRole("button", { name: "Rotate key…" }).click();
    await monitoring.getByRole("button", { name: "Rotate key and disable" }).click();
    await expect(secret).toBeVisible();
    const rotated = await secret.getByLabel("Webhook URL", { exact: true }).inputValue();
    expect(rotated).not.toBe(url);
    expect((await page.request.post(rotated, { data: { title: "Must not run" } })).status()).toBe(
      404,
    );
    await secret.getByRole("button", { name: "Back to inputs" }).click();
    await expect(secret).toBeHidden();

    const [storedHook] = await database.client<{ id: string; policyId: string; version: number }[]>`
      SELECT id,policy_id AS "policyId",version::int AS version FROM factory.monitoring_hook`;
    if (!storedHook) throw new Error("Owned monitoring webhook is missing");
    for (const incident of [
      {
        title: "Invoice alert without a matching stack",
        state: "insufficient-context",
        reason: "The shared source could not identify this incident.",
        occurrences: 9,
      },
      {
        title: "Interrupted diagnosis",
        state: "uncertain",
        reason: "Outcome unknown. No automatic model retry.",
        occurrences: 1,
      },
    ]) {
      await database.client`INSERT INTO factory.monitoring_incident(id,hook_id,project_id,policy_id,hook_version,fingerprint,payload_digest,title,context,state,reason,occurrences)
        VALUES(${crypto.randomUUID()},${storedHook.id},${projectId},${storedHook.policyId},${storedHook.version},
          ${crypto.randomUUID().replaceAll("-", "").repeat(2)},${"a".repeat(64)},${incident.title},'Synthetic UI status only',
          ${incident.state},${incident.reason},${incident.occurrences})`;
    }
    const incidents = monitoring.getByRole("region", { name: "Recent input activity" });
    await expect(incidents).toContainText("9 deliveries");
    await expect(incidents).toContainText("More context needed");
    await expect(incidents).toContainText("Outcome unknown");
    await incidents.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/incidents-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await incidents.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/incidents-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });

    const peerEmail = `manager-${projectId}@factory.local`;
    const password = "owned-monitoring-manager-password";
    expect(
      (
        await browserFunction(page, "createAccount", [
          { name: "Monitoring manager", email: peerEmail, password },
        ])
      ).ok,
    ).toBe(true);
    expect(
      (
        await browserFunction(page, "saveProjectMember", [
          projectId,
          { email: peerEmail, role: "product-contributor", manageProject: true },
        ])
      ).ok,
    ).toBe(true);
    await signIn(peerPage, peerEmail, password);
    await open(peerPage);
    const peerMonitoring = peerPage.getByRole("region", {
      name: "Project inputs",
      exact: true,
    });
    await expect(
      peerMonitoring.getByRole("button", { name: "Add input", exact: true }),
    ).toBeVisible();
    await expect(peerPage.getByText("Factory administration", { exact: true })).toHaveCount(0);
    const denied = await browserFunction(peerPage, "saveProjectInput", [
      projectId,
      fixtureValue(commands[0], "commands[0]"),
    ]);
    expect(denied).toMatchObject({ ok: false, status: 403 });
    await database.client`UPDATE factory.project_membership SET manage_project=false WHERE project_id=${projectId}`;
    await expect(
      peerMonitoring.getByRole("button", { name: "Add input", exact: true }),
    ).toHaveCount(0);
    await peerPage.screenshot({ path: `${evidence}/read-only-desktop.png`, fullPage: true });

    await stopSaveMock();
    let failReads = true;
    await mockFactoryFunctions(page, {
      inputs: {
        async get(_actor, project) {
          if (failReads)
            throw new CommandError("unavailable", "Owned temporary monitoring read failure.");
          return serverCall(browserFunction(page, "getProjectInputs", [project]));
        },
      },
    });
    await page.reload();
    await open(page);
    await expect(monitoring.getByRole("alert")).toContainText(
      "Owned temporary monitoring read failure.",
    );
    await expect(monitoring.getByRole("button", { name: "Retry loading inputs" })).toBeVisible();
    failReads = false;
    await monitoring.getByRole("button", { name: "Retry loading inputs" }).click();
    await expect(monitoring.getByRole("alert")).toBeHidden();
    await expect(hook).toBeVisible();
    const [work] = await database.client<{ turns: number; usage: number; tickets: number }[]>`
      SELECT (SELECT count(*)::int FROM factory.agent_turn) AS turns,
        (SELECT count(*)::int FROM factory.usage_operation) AS usage,
        (SELECT count(*)::int FROM factory.ticket) AS tickets`;
    expect(work).toEqual({ turns: 0, usage: 0, tickets: 0 });
    const touch = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      storageState: await page.context().storageState(),
    });
    try {
      const touchPage = await touch.newPage();
      touchPage.on("pageerror", (cause) => errors.push(cause.message));
      await touchPage.goto(fixture.fixtureBase);
      await open(touchPage);
      const touchMonitoring = touchPage.getByRole("region", {
        name: "Project inputs",
        exact: true,
      });
      await touchMonitoring.getByLabel("Actions for Invoice errors").click();
      const rotate = touchMonitoring.getByRole("button", { name: "Rotate key…" });
      await expect(rotate).toBeVisible();
      await rotate.scrollIntoViewIfNeeded();
      const size = await rotate.boundingBox();
      if (!size) throw new Error("Touch rotation control is not rendered");
      expect(size.height).toBeGreaterThanOrEqual(44);
      expect(
        await touchPage.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await touchPage.screenshot({ path: `${evidence}/touch-mobile.png`, fullPage: true });
    } finally {
      await touch.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await peer.close();
    await database.client.end();
    const stopped = new Promise<void>((resolve) => host.once("exit", () => resolve()));
    host.kill("SIGTERM");
    await stopped;
  }
});
