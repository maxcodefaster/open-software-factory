import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer } from "vite";
import { CommandError } from "../../apps/factory/src/command-error";
import { observeBrowserErrors } from "../fixtures/browser-errors";
import { invalidateFixtureRead } from "../fixtures/read-invalidation";
import { mcpLibraryView } from "../../packages/conversation-domain/src/mcp-library";
import { monitoringSave, monitoringView } from "../../packages/conversation-domain/src/monitoring";
import { factoryFunctionMatches, mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";
import { factoryFixtureStart } from "../fixtures/start-plugins";
import { fixtureValue } from "../fixtures/value";

// Real settings components with native compiled function I/O. Controller/live proofs own
// authentication, durable policies, source transport and actual inference.
test("Inputs settings work on desktop and phone without a mode selector", async ({ page }) => {
  test.setTimeout(90_000);
  const project = "10000000-0000-4000-8000-000000000001";
  const user = "10000000-0000-4000-8000-000000000002";
  const source = "10000000-0000-4000-8000-000000000003";
  const revision = "10000000-0000-4000-8000-000000000004";
  const evidence = ".factory/test-results/inputs-polish/component-ui";
  const errors = observeBrowserErrors(page);
  const cache = resolve(".factory/test-results/vite", `input-ui-${crypto.randomUUID()}`);
  const frontend = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["project-inputs.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await frontend.listen();
  const origin = frontend.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!origin) throw new Error("Inputs component server did not expose a local URL.");
  const view = monitoringView.parse({
    canManage: true,
    canDelegate: true,
    canDisable: true,
    hooks: [],
    incidents: [],
  });
  const sources = mcpLibraryView.parse({
    canManageSystem: true,
    canManageProject: true,
    choices: [],
    proposals: [],
    entries: [
      {
        id: source,
        scope: "project",
        ownerId: null,
        projectId: project,
        editable: true,
        revisions: [
          {
            id: revision,
            revision: 1,
            digest: "a".repeat(64),
            content: {
              name: "Sentry",
              description: "Synthetic read-only error context",
              provider: "sentry",
              endpoint: "https://source.example/mcp",
              authentication: "none",
              roles: ["planning", "build"],
            },
          },
        ],
        connection: {
          id: source,
          revisionId: revision,
          state: "ready",
          version: 1,
          allowedTools: ["read_issue"],
          tools: [
            {
              name: "read_issue",
              description: "Read an issue",
              inputSchema: { type: "object" },
              digest: "b".repeat(64),
              readOnlyHint: true,
            },
          ],
          projectGrants: [],
          editable: true,
        },
      },
    ],
  });
  const commands: unknown[] = [];
  let loseConfirmation = true;
  let lost = false;
  let modelCommands = 0;
  await mockFactoryFunctions(
    page,
    {
      delivery: {
        settings: async () => ({
          policyId: null,
          enabled: false,
          delegatedBy: null,
          canManage: false,
          canDelegate: false,
        }),
      },
      mcp: { get: async () => sources },
      inputs: {
        get: async () => view,
        async save(_actor, _project, value) {
          const input = monitoringSave.parse(value);
          commands.push(input);
          if (!view.hooks.some((hook) => hook.id === input.id))
            view.hooks.push({
              ...input,
              version: 1,
              delegatedBy: user,
              policyId: crypto.randomUUID(),
              sourceIds: input.connectionIds,
              delegationCurrent: true,
            });
          if (loseConfirmation) {
            loseConfirmation = false;
            lost = true;
          }
          return { url: `${origin}/hooks/inputs/${input.id}/owned-private-key` };
        },
        async rotate() {
          fixtureValue(view.hooks[0], "view.hooks[0]").enabled = false;
          fixtureValue(view.hooks[0], "view.hooks[0]").version++;
          return {
            url: `${origin}/hooks/inputs/${fixtureValue(view.hooks[0], "view.hooks[0]").id}/rotated-private-key`,
          };
        },
      },
    },
    (name) => {
      if (name !== "saveProjectInput" || !lost) return false;
      lost = false;
      return true;
    },
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (/\/(conversation|changes|agent-turns)(\/|$)/.test(path)) modelCommands++;
    return route.fulfill({
      status: 503,
      json: { error: "Outside this isolated Inputs component proof." },
    });
  });
  const inputs = page.getByRole("region", { name: "Project inputs", exact: true });
  const navigation = page.getByRole("navigation", { name: "Settings navigation" });
  const editor = inputs.getByRole("form", { name: "Input configuration" });
  try {
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${origin}/project-inputs.html`);
    await navigation.getByRole("button", { name: "Inputs", exact: true }).click();
    await expect(inputs.getByText("Give external requests a place to land")).toBeVisible();
    await expect(navigation.locator("h3")).toHaveText([
      "Project · Invoice workspace",
      "Libraries",
      "Personal",
      "Factory administration",
    ]);
    const sizes = await navigation
      .getByRole("button")
      .evaluateAll((buttons) => [
        ...new Set(buttons.map((button) => getComputedStyle(button).fontSize)),
      ]);
    expect(sizes).toHaveLength(1);
    await inputs.getByRole("button", { name: "Add input", exact: true }).click();
    await editor.getByLabel("Name", { exact: true }).fill("Product feedback");
    await expect(editor.getByLabel("Task", { exact: true })).toHaveValue(
      /Understand incoming requests/,
    );
    await expect(editor.getByRole("combobox")).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Create input", exact: true })).toBeEnabled();
    await expect(editor.getByRole("button", { name: "Create input", exact: true })).toHaveCSS(
      "background-color",
      "rgb(63, 94, 99)",
    );
    await page.screenshot({ path: `${evidence}/creator-desktop.png`, fullPage: true });
    await editor.getByRole("button", { name: "Add source", exact: true }).click();
    await editor.getByRole("button", { name: "Connect a service", exact: true }).click();
    await expect(navigation.getByRole("button", { name: "Inputs", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.getByRole("button", { name: "Inspect Sentry", exact: true }).click();
    await page.getByRole("button", { name: "Use for Input", exact: true }).click();
    await expect(editor.getByRole("button", { name: "Remove Sentry", exact: true })).toBeVisible();
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Product feedback");
    await expect(editor.getByRole("group", { name: "Available shared sources" })).toBeHidden();
    await page.screenshot({ path: `${evidence}/source-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Choose settings page" })).toHaveText("Inputs");
    await chooseSettingsPage(page, "MCP connections");
    await expect(page.getByRole("heading", { name: "MCP connections", exact: true })).toBeVisible();
    await chooseSettingsPage(page, "Inputs");
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Product feedback");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${evidence}/creator-mobile.png`, fullPage: true });
    await editor.getByRole("button", { name: "Create input", exact: true }).click();
    await inputs.getByRole("button", { name: "Retry same command", exact: true }).click();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    expect(view.hooks).toHaveLength(1);
    const secret = inputs.getByRole("region", { name: "New webhook URL" });
    await expect(secret.getByLabel("Webhook URL")).toHaveAttribute("type", "password");
    await expect(secret.getByRole("heading")).toBeFocused();
    await secret.getByRole("button", { name: "Reveal URL", exact: true }).click();
    await expect(secret.getByLabel("Webhook URL")).toHaveAttribute("type", "text");
    await secret.getByRole("button", { name: "Hide URL", exact: true }).click();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await secret.getByRole("button", { name: "Copy URL", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      await secret.getByLabel("Webhook URL").inputValue(),
    );
    await page.screenshot({ path: `${evidence}/webhook-mobile.png`, fullPage: true });
    await secret.getByRole("button", { name: "Back to inputs", exact: true }).click();
    view.incidents.push({
      id: crypto.randomUUID(),
      hookId: fixtureValue(view.hooks[0], "view.hooks[0]").id,
      title: "Make invoice exports easier to find",
      state: "prepared",
      occurrences: 4,
      reason: null,
      ticketId: null,
      receivedAt: "2026-10-23T10:00:00Z",
      lastSeenAt: "2026-10-23T10:02:00Z",
    });
    await invalidateFixtureRead(page, "inputs");
    await expect(inputs.getByRole("region", { name: "Recent input activity" })).toContainText(
      "Ticket prepared",
    );
    await page.screenshot({ path: `${evidence}/overview-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${evidence}/overview-desktop.png`, fullPage: true });
    const eventDetails = inputs.locator(".input-event");
    const eventSummary = eventDetails.locator(":scope > summary");
    await eventSummary.click();
    await eventSummary.focus();
    fixtureValue(view.incidents[0], "view.incidents[0]").occurrences = 5;
    fixtureValue(view.incidents[0], "view.incidents[0]").reason =
      "Prepared from the incoming request and connected source.";
    await invalidateFixtureRead(page, "inputs");
    await expect(eventDetails).toContainText("5 deliveries");
    await expect(eventDetails).toHaveAttribute("open", "");
    await expect(eventSummary).toBeFocused();
    const row = inputs.getByRole("article", { name: "Product feedback input", exact: true });
    await row.getByText("Task & webhook details", { exact: true }).click();
    await row.getByLabel("Actions for Product feedback").click();
    const edit = row.getByRole("button", { name: "Edit input", exact: true });
    await edit.focus();
    fixtureValue(view.hooks[0], "view.hooks[0]").version++;
    fixtureValue(view.hooks[0], "view.hooks[0]").enabled = false;
    await invalidateFixtureRead(page, "inputs");
    await expect(row).toContainText("Disabled");
    await expect(edit).toBeFocused();
    await expect(row.locator(".input-row-details")).toHaveAttribute("open", "");
    await expect(row.locator(".input-row-menu")).toHaveAttribute("open", "");
    await page.screenshot({ path: `${evidence}/polling-expanded-desktop.png`, fullPage: true });
    await row.getByLabel("Actions for Product feedback").click();
    await inputs.getByLabel("Actions for Product feedback").click();
    await inputs.getByRole("button", { name: "Rotate key…" }).click();
    await inputs.getByRole("button", { name: "Rotate key and disable" }).click();
    await expect(secret).toContainText("Your Input is disabled");
    await page.screenshot({ path: `${evidence}/rotation-desktop.png`, fullPage: true });
    expect(modelCommands).toBe(0);
    view.canManage = view.canDelegate = view.canDisable = false;
    await page.goto(`${origin}/project-inputs.html?role=viewer`);
    await navigation.getByRole("button", { name: "Inputs", exact: true }).click();
    await expect(navigation.getByText("Factory administration", { exact: true })).toHaveCount(0);
    await expect(inputs.getByRole("button", { name: "Add input", exact: true })).toHaveCount(0);
    await expect(inputs.getByLabel("Actions for Product feedback")).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/read-only-desktop.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await frontend.close();
    await rm(cache, { recursive: true, force: true });
  }
});

test("Inputs keep menus, long requests, errors and delegation usable at every size", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const _project = "10000000-0000-4000-8000-000000000001";
  const cache = resolve(".factory/test-results/vite", `input-states-${crypto.randomUUID()}`);
  const frontend = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["project-inputs.html"] },
    plugins: [factoryFixtureStart(), solid({ ssr: false })],
    server: { host: "127.0.0.1", port: 0 },
  });
  await frontend.listen();
  const origin = frontend.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!origin) throw new Error("Inputs component server did not expose a local URL.");
  const evidence = ".factory/test-results/inputs-polish/states";
  await mkdir(evidence, { recursive: true });
  try {
    for (const device of [
      { name: "desktop", width: 1440, height: 1000, touch: false },
      { name: "narrow", width: 320, height: 780, touch: false },
      { name: "touch", width: 390, height: 844, touch: true },
    ]) {
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        hasTouch: device.touch,
        isMobile: device.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        const errors = observeBrowserErrors(page);
        const writes: string[] = [];
        const hook = {
          id: crypto.randomUUID(),
          name: "Product feedback",
          version: 1,
          enabled: true,
          instructions:
            "Check invoice exports against Project knowledge. Prepare a Ticket with testable acceptance criteria and explain any missing context.",
          connectionIds: [],
          sourceIds: [],
          delegation: "prepare-ticket",
          delegatedBy: crypto.randomUUID(),
          policyId: crypto.randomUUID(),
          delegationCurrent: true,
        };
        const view = monitoringView.parse({
          canManage: true,
          canDelegate: true,
          canDisable: true,
          hooks: [
            hook,
            {
              ...hook,
              id: crypto.randomUUID(),
              name: "European customer feedback for invoice exports and account permissions",
              enabled: false,
              delegation: "application-fix-and-delivery",
            },
            {
              ...hook,
              id: crypto.randomUUID(),
              name: "Application alerts",
              delegationCurrent: false,
            },
          ],
          incidents: [
            {
              id: crypto.randomUUID(),
              hookId: hook.id,
              title:
                "Exporting invoices for a previous billing period fails when the account has no matching invoices",
              state: "insufficient-context",
              occurrences: 9,
              reason: "The sender did not include the account or the billing period.",
              ticketId: null,
              receivedAt: "2026-10-23T10:00:00Z",
              lastSeenAt: "2026-10-23T10:02:00Z",
            },
            {
              id: crypto.randomUUID(),
              hookId: hook.id,
              title: "Interrupted request",
              state: "uncertain",
              occurrences: 1,
              reason: "The provider's result could not be confirmed.",
              ticketId: null,
              receivedAt: "2026-10-23T10:00:00Z",
              lastSeenAt: "2026-10-23T10:03:00Z",
            },
          ],
        });
        let failRead = true;
        await mockFactoryFunctions(page, {
          delivery: {
            settings: async () => ({
              policyId: null,
              enabled: false,
              delegatedBy: null,
              canManage: false,
              canDelegate: false,
            }),
          },
          mcp: {
            get: async () =>
              mcpLibraryView.parse({
                canManageSystem: true,
                canManageProject: true,
                choices: [],
                proposals: [],
                entries: [],
              }),
          },
          inputs: {
            async get() {
              if (failRead)
                throw new CommandError("unavailable", "Inputs are temporarily unavailable.");
              return view;
            },
            async save() {
              writes.push("save");
              throw new Error("Unexpected Input save");
            },
            async disable() {
              writes.push("disable");
              throw new Error("Unexpected Input disable");
            },
            async rotate() {
              writes.push("rotate");
              throw new Error("Unexpected Input rotation");
            },
          },
        });
        await context.route("**/api/**", (route) => {
          const request = route.request();
          if (request.method() !== "GET") writes.push(request.url());
          return route.fulfill({ status: 503, json: { error: "Outside this component proof." } });
        });
        await page.goto(`${origin}/project-inputs.html`);
        await chooseSettingsPage(page, "Inputs");
        const inputs = page.getByRole("region", { name: "Project inputs", exact: true });
        await expect(inputs.getByRole("alert")).toHaveText(/temporarily unavailable/);
        await page.screenshot({ path: `${evidence}/error-${device.name}.png` });
        failRead = false;
        await inputs.getByRole("button", { name: "Retry loading inputs" }).click();
        await expect(inputs.getByRole("alert")).toBeHidden();
        const row = inputs.getByRole("article", { name: "Product feedback input", exact: true });
        await expect(row).toContainText("Human approval to implement");
        await expect(inputs).toContainText("Autofix & Delivery delegated");
        await expect(inputs).toContainText("Source access or authority changed.");
        const noOverflow = async () => {
          for (const element of [page.locator("html"), page.locator(".settings-content"), inputs]) {
            const size = await element.evaluate((node) => {
              const edge = node.getBoundingClientRect().right;
              return {
                overflow: node.scrollWidth - node.clientWidth,
                elements: [...node.querySelectorAll("*")]
                  .filter((child) => child.getBoundingClientRect().right > edge + 1)
                  .slice(0, 10)
                  .map((child) => ({
                    tag: child.tagName,
                    class: child.className,
                    width: child.getBoundingClientRect().width,
                    minWidth: getComputedStyle(child).minWidth,
                    boxSizing: getComputedStyle(child).boxSizing,
                  })),
              };
            });
            if (size.overflow > 1)
              await page.screenshot({
                path: `${evidence}/overflow-${device.name}.png`,
                fullPage: true,
              });
            expect(size.overflow, JSON.stringify(size)).toBeLessThanOrEqual(1);
          }
        };
        await noOverflow();
        expect(
          await inputs.locator(".input-overview-heading").evaluate((bar) => {
            const action = bar.querySelector('[data-primary="true"]')?.getBoundingClientRect();
            return action ? bar.getBoundingClientRect().right - action.right : Infinity;
          }),
        ).toBeLessThanOrEqual(1);
        await page.screenshot({ path: `${evidence}/overview-${device.name}.png` });
        const list = inputs.getByRole("region", { name: "Configured inputs" });
        const height = await list.evaluate((node) => node.getBoundingClientRect().height);
        const opener = row.getByLabel("Actions for Product feedback");
        await opener.click();
        const disable = row.getByRole("button", { name: "Disable input", exact: true });
        await disable.focus();
        const refreshed = page.waitForResponse(
          async (response) => await factoryFunctionMatches(response.url(), "getProjectInputs"),
        );
        await invalidateFixtureRead(page, "inputs");
        await refreshed;
        await expect(disable).toBeFocused();
        await page.keyboard.press("Escape");
        await opener.focus();
        await page.keyboard.press("ArrowDown");
        const edit = row.getByRole("button", { name: "Edit input", exact: true });
        await expect(edit).toBeFocused();
        expect(await list.evaluate((node) => node.getBoundingClientRect().height)).toBe(height);
        await page.keyboard.press("End");
        await expect(row.getByRole("button", { name: "Rotate key…" })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(opener).toBeFocused();
        await expect(edit).toBeHidden();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("End");
        await page.keyboard.press("Tab");
        await expect(edit).toBeHidden();
        await opener.click();
        const menu = row.locator(".input-row-menu > div");
        await expect(menu).toBeInViewport();
        if (device.touch) {
          const sizes = await menu
            .getByRole("button")
            .evaluateAll((buttons) =>
              buttons.map((button) => button.getBoundingClientRect().height),
            );
          expect(sizes.every((size) => size >= 44)).toBe(true);
        }
        await page.screenshot({ path: `${evidence}/menu-${device.name}.png` });
        await inputs.getByRole("heading", { name: "Recent requests" }).click();
        await expect(edit).toBeHidden();
        await opener.click();
        await row.getByRole("button", { name: "Rotate key…" }).click();
        await expect(menu).toBeHidden();
        await expect(row.getByRole("button", { name: "Rotate key and disable" })).toBeVisible();
        await expect(
          row.getByRole("heading", { name: "Rotate key for Product feedback?" }),
        ).toBeFocused();
        await page.screenshot({ path: `${evidence}/confirm-${device.name}.png` });
        await row.getByRole("button", { name: "Cancel rotation" }).click();
        await expect(opener).toBeFocused();
        await row.locator(".input-row-details > summary").click();
        await expect(row.locator(".input-row-details details")).toHaveCount(0);
        await noOverflow();
        await page.screenshot({ path: `${evidence}/details-${device.name}.png` });
        await row.locator(".input-row-details > summary").click();
        const events = inputs.locator(".input-event");
        await events.nth(1).locator("summary").click();
        await expect(events.nth(1)).toContainText("No automatic model retry was started.");
        await page.screenshot({ path: `${evidence}/requests-${device.name}.png` });
        await inputs.getByRole("button", { name: "Add input", exact: true }).click();
        const editor = inputs.getByRole("form", { name: "Input configuration" });
        await expect(editor.getByRole("heading", { name: "New input" })).toBeFocused();
        await editor.getByLabel("Name", { exact: true }).fill("Invoice alerts");
        await editor.getByText("Automatic implementation", { exact: true }).click();
        const autofix = editor.getByRole("checkbox", {
          name: "Enable application Autofix and Delivery",
        });
        await autofix.check();
        await expect(editor).toContainText("Connect a read-only source before enabling Autofix.");
        await expect(editor.getByRole("button", { name: "Create input" })).toBeDisabled();
        await editor.getByRole("button", { name: "Add source", exact: true }).click();
        await expect(editor.getByRole("group", { name: "Available shared sources" })).toContainText(
          "No connected shared sources yet.",
        );
        await noOverflow();
        await editor.getByRole("button", { name: "Create input" }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${evidence}/delegation-${device.name}.png` });
        await autofix.uncheck();
        await expect(editor.getByRole("button", { name: "Create input" })).toBeEnabled();
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(inputs.getByRole("button", { name: "Add input" })).toBeFocused();
        view.canManage = view.canDelegate = view.canDisable = false;
        await invalidateFixtureRead(page, "inputs");
        await expect(inputs.getByRole("button", { name: "Add input" })).toHaveCount(0);
        await expect(inputs.locator(".input-row-menu")).toHaveCount(0);
        await noOverflow();
        expect(writes).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await frontend.close();
    await rm(cache, { recursive: true, force: true });
  }
});
