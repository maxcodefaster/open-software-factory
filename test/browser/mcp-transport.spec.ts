import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer, type ViteDevServer } from "vite";
import type { z } from "zod";
import {
  mcpLibraryView,
  type mcpSaveInput,
} from "../../packages/conversation-domain/src/mcp-library";
import { skillLibraryView } from "../../packages/conversation-domain/src/skill-library";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";

const directory = ".factory/test-results/mcp-transport";
const cache = resolve(".factory/test-results/vite", `mcp-transport-${crypto.randomUUID()}`);
let server: ViteDevServer;
let origin: string;
test.setTimeout(90_000);
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["mcp-library.html", "project-inputs.html"] },
    plugins: [
      solid({
        ssr: false,
        serverFunctions: {
          devMiddleware: false,
          filter: { include: resolve("apps/factory/src/server-functions/**/*.{ts,tsx}") },
        },
      }),
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  await mkdir(directory, { recursive: true });
});
test.afterAll(async () => {
  await server?.close();
  await rm(cache, { recursive: true, force: true });
});

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`MCP library presents recommended cards without a duplicate introduction at ${viewport.width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const view = mcpLibraryView.parse({
      entries: [],
      choices: [],
      proposals: [],
      canManageProject: false,
      canManageSystem: false,
    });
    await mockFactoryFunctions(page, {
      mcp: { get: async () => view },
      skills: {
        library: async () =>
          skillLibraryView.parse({
            entries: [],
            sharedVersions: [],
            choices: [],
            proposals: [],
            canManageProject: false,
            canManageSystem: false,
          }),
      },
    });
    await page.goto(`${origin}/project-inputs.html`);
    await chooseSettingsPage(page, "MCP connections");
    const library = page.locator(".mcp-library");
    const headings = ["MCP connections"];
    await expect(library.getByRole("heading")).toHaveText(headings);
    if (viewport.width <= 760)
      await expect(page.getByRole("button", { name: "Choose settings page" })).toHaveText(
        "MCP connections",
      );
    await expect(library.getByRole("status")).toBeEmpty();
    const subtitle = library
      .locator(".skill-library-heading")
      .getByText("Connect external tools and context to Project work.", { exact: true });
    await expect(subtitle).toBeVisible();
    const titleBounds = await library
      .getByRole("heading", { name: "MCP connections" })
      .boundingBox();
    const subtitleBounds = await subtitle.boundingBox();
    if (!titleBounds || !subtitleBounds) throw new Error("Library title or subtitle is missing");
    expect(subtitleBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
    const windowFilters = await page.locator(".settings-workspace").evaluate((workspace) => {
      const filters: string[] = [];
      for (let element: Element | null = workspace; element; element = element.parentElement)
        filters.push(getComputedStyle(element).backdropFilter);
      return filters;
    });
    expect(windowFilters).toContainEqual(expect.stringMatching(/blur\([1-9]/));
    await expect(library).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".workspace-tabbar")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    const selectedColor = await page
      .locator(".settings-sidebar [aria-current='page']")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(page.locator(".workspace-tab.active")).toHaveCSS(
      "background-color",
      selectedColor,
    );
    await expect(page.locator(".workspace-tab.active")).toHaveCSS("box-shadow", /inset/);
    expect(
      await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches),
    ).toBe(false);
    await expect(library.locator(".skill-library-empty")).toHaveCount(0);
    await expect(library.getByText(/Provider-operated endpoints/)).toHaveCount(0);
    const recommendations = library.getByRole("region", { name: "Recommended MCP connections" });
    await expect(recommendations.getByRole("heading")).toHaveCount(0);
    await expect(recommendations.getByRole("button")).toHaveCount(2);
    for (const cover of await recommendations.locator(".mcp-cover").all()) {
      await expect(cover).toHaveJSProperty("naturalWidth", 768);
      await expect(cover).toHaveJSProperty("naturalHeight", 512);
    }
    const spacing = await library.evaluate((element) => {
      const header = element.querySelector(".skill-library-heading");
      const card = element.querySelector(".mcp-recommendations .skill-tile");
      if (!header || !card) throw new Error("Library header or recommended card is missing");
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        cardTop: card.getBoundingClientRect().top,
      };
    });
    expect(spacing.cardTop - spacing.headerBottom).toBeGreaterThanOrEqual(0);
    expect(spacing.cardTop - spacing.headerBottom).toBeLessThanOrEqual(32);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `${directory}/gallery-${viewport.width}.png`,
      fullPage: true,
    });
    await recommendations.getByRole("button", { name: "Set up Sentry", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Sentry");
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(library.getByRole("heading")).toHaveText(headings);
    await library.getByRole("searchbox", { name: "Search MCP connections" }).fill("missing source");
    await expect(library.getByRole("heading", { name: "No matching connections" })).toBeVisible();
    await library.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(library.getByRole("heading")).toHaveText(headings);
    view.entries.push({
      id: crypto.randomUUID(),
      scope: "personal",
      ownerId: crypto.randomUUID(),
      projectId: null,
      editable: true,
      connection: null,
      revisions: [
        {
          id: crypto.randomUUID(),
          revision: 1,
          digest: "c".repeat(64),
          content: {
            name: "Product context",
            description: "Synthetic source for this isolated layout proof.",
            endpoint: "https://source.example/mcp",
            authentication: "none",
            provider: "custom",
            roles: ["planning", "build"],
          },
        },
      ],
    });
    await page.reload();
    await chooseSettingsPage(page, "MCP connections");
    await expect(library.getByRole("button", { name: "Inspect Product context" })).toBeVisible();
    await expect(recommendations.getByRole("heading")).toHaveText("Recommended starting points");
    await expect(recommendations.locator(":scope > p")).toHaveCount(0);
    await page.screenshot({
      path: `${directory}/gallery-saved-${viewport.width}.png`,
      fullPage: true,
    });
    await chooseSettingsPage(page, "Skills");
    const skills = page.locator(".skill-library:not(.mcp-library)");
    await expect(skills).toBeVisible();
    await expect(skills).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    if (viewport.width === 1440) {
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
      });
      const window = page.locator(".workspace-window");
      await expect(window).toHaveCSS("backdrop-filter", "none");
      await expect(window).toHaveCSS("background-color", "rgb(250, 250, 247)");
      await session.detach();
    }
    expect(errors).toEqual([]);
  });
}

test("MCP native calls retain an unconfirmed definition and require explicit Connect, review and Disconnect", async ({
  page,
}) => {
  let view = mcpLibraryView.parse({
    entries: [],
    choices: [],
    proposals: [],
    canManageProject: false,
    canManageSystem: false,
  });
  const saves: z.input<typeof mcpSaveInput>[] = [];
  const commands: string[] = [],
    errors: string[] = [],
    retired: string[] = [];
  let lost = false;
  const tools = [
    {
      name: "read_issue",
      description: "Read an issue",
      inputSchema: { type: "object" as const },
      digest: "a".repeat(64),
      readOnlyHint: true,
    },
    {
      name: "delete_issue",
      description: "Do not approve",
      inputSchema: { type: "object" as const },
      digest: "b".repeat(64),
      readOnlyHint: false,
    },
  ];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/mcp")) retired.push(request.url());
  });
  await mockFactoryFunctions(
    page,
    {
      mcp: {
        async get(_actor, projectID) {
          expect(projectID).toBeUndefined();
          return view;
        },
        async save(_actor, input) {
          saves.push(structuredClone(input));
          if (saves.length === 1) {
            view.entries.push({
              id: input.libraryId,
              scope: "personal",
              ownerId: crypto.randomUUID(),
              projectId: null,
              editable: true,
              connection: null,
              revisions: [
                {
                  id: input.revisionId,
                  revision: 1,
                  digest: "c".repeat(64),
                  content: input.content,
                },
              ],
            });
            lost = true;
          } else expect(input).toEqual(saves[0]);
          return { saved: true };
        },
        async connect(_actor, id, input) {
          commands.push("connect");
          expect(input.revisionId).toBe(saves[0]?.revisionId);
          const entry = view.entries.find((item) => item.id === id)!;
          entry.connection = {
            id,
            revisionId: input.revisionId,
            state: "review",
            version: 1,
            tools,
            allowedTools: [],
            projectGrants: [],
            editable: true,
          };
          return { authorizationUrl: null };
        },
        async review(_actor, id, input) {
          commands.push("review");
          expect(input).toEqual({
            expectedVersion: 1,
            confirmReadOnlyAccess: true,
            tools: [{ name: "read_issue", digest: tools[0]!.digest }],
          });
          const connection = view.entries.find((entry) => entry.id === id)!.connection!;
          connection.state = "ready";
          connection.version++;
          connection.allowedTools = ["read_issue"];
          return { saved: true };
        },
        async disconnect(_actor, id) {
          commands.push("disconnect");
          const connection = view.entries.find((entry) => entry.id === id)!.connection!;
          connection.state = "revoked";
          connection.allowedTools = [];
          connection.version++;
          return { saved: true };
        },
      },
    },
    (name) => {
      if (name !== "saveMCPDefinition" || !lost) return false;
      lost = false;
      return true;
    },
  );
  await page.goto(`${origin}/mcp-library.html`);
  await expect(page.getByRole("button", { name: "Add MCP", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add MCP", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByLabel("Name", { exact: true }).fill("Owned source");
  await page.getByLabel("When to use", { exact: true }).fill("Read the approved issue context.");
  await page.getByLabel("MCP endpoint", { exact: true }).fill("https://source.example/mcp");
  await page.getByRole("combobox", { name: "Authentication", exact: true }).selectOption("none");
  await page.getByRole("button", { name: "Save definition", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Owned source");
  expect(saves).toHaveLength(1);
  expect(commands).toEqual([]);
  await page.getByRole("button", { name: "Save definition", exact: true }).click();
  const detail = page.getByRole("region", { name: "MCP details", exact: true });
  await expect(detail.getByRole("heading", { name: "Owned source", exact: true })).toBeVisible();
  expect(saves).toHaveLength(2);
  expect(saves[0]).toEqual(saves[1]);
  expect(view.entries).toHaveLength(1);
  expect(commands).toEqual([]);
  await detail.getByRole("button", { name: "Connect", exact: true }).click();
  const review = detail.getByRole("region", { name: "Read-only tool review", exact: true });
  await expect(review).toBeVisible();
  await review.getByRole("checkbox", { name: "read_issue", exact: true }).check();
  await expect(
    review.getByRole("checkbox", { name: "delete_issue", exact: true }),
  ).not.toBeChecked();
  await expect(
    review.getByRole("button", { name: "Approve read-only access", exact: true }),
  ).toBeDisabled();
  await review.getByRole("checkbox", { name: /I verified/ }).check();
  await review.getByRole("button", { name: "Approve read-only access", exact: true }).click();
  await expect(detail.getByText("Connected", { exact: true })).toBeVisible();
  await expect(review.getByRole("checkbox", { name: /I verified/ })).not.toBeChecked();
  await expect(detail.getByRole("button", { name: "Disconnect", exact: true })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "Reconnect", exact: true })).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  expect(commands).toEqual(["connect", "review"]);
  await detail.getByRole("heading", { name: "Owned source", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/connected-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await detail.getByRole("heading", { name: "Owned source", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/connected-narrow.png`, fullPage: true });
  await detail.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(detail).toContainText("Disconnected");
  expect(commands).toEqual(["connect", "review", "disconnect"]);
  expect(errors).toEqual([]);
  expect(retired).toEqual([]);
});
