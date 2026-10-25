import { requestFunction } from "../fixtures/server-functions";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  canonicalRequirementContent,
  requirementDigest,
} from "../../packages/requirement-domain/src/requirement";
import { openProjectMenu } from "../fixtures/project-menu";
import { deleteFactoryProject, signIn, stopProjectRuntimes } from "../support/factory-fixture";

const execute = promisify(execFile);
let evidenceDirectory = "";
const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const userID = "01994a7d-0000-7000-8000-000000000001";
const title = "Prove configured Build inference";
if (existsSync(".env")) loadEnvFile(".env");
const {
  FACTORY_MODEL_BASE_URL,
  FACTORY_MODEL_API_KEY,
  FACTORY_AGENT_MODEL_ID,
  FACTORY_PROJECT_AGENT_MODEL,
} = process.env;
const configuredModel = Boolean(
  FACTORY_MODEL_BASE_URL &&
    FACTORY_MODEL_API_KEY &&
    FACTORY_AGENT_MODEL_ID &&
    FACTORY_PROJECT_AGENT_MODEL,
);
let projectID = "";
let projectSlug = "";
let ticketID = "";
let database: ReturnType<typeof createDatabase> | undefined;

test.use({
  viewport: { width: 1440, height: 900 },
  contextOptions: { reducedMotion: "reduce" },
  trace: "off",
});
test.skip(!configuredModel, "This gate requires genuine configured Project and Build models");

test.beforeEach(async () => {
  database = createDatabase(1);
  projectID = crypto.randomUUID();
  projectSlug = `turn-live-${projectID.slice(0, 8)}`;
  evidenceDirectory = `.factory/test-results/agent-turn-live/${projectSlug}`;
  await mkdir(evidenceDirectory, { recursive: true });
  ticketID = crypto.randomUUID();
  const content = canonicalRequirementContent({
    summary: `Set src/version.txt to ${projectSlug}. Keep the existing application intact.`,
    acceptanceCriteria: [
      `src/version.txt contains exactly ${projectSlug} followed by a newline.`,
      "node --check src/server.mjs passes.",
    ],
    nonGoals: ["Change dependencies, runtime configuration, or other files."],
  });
  await database.client.begin(async (transaction) => {
    await transaction`
      INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${projectSlug}, '11A live baseline',
        'http://127.0.0.1:33030/factory-mutation/runtime-fixture.git', 'main',
        '.devcontainer/devcontainer.json', ${userID})
    `;
    await transaction`
      INSERT INTO factory.knowledge_page(id, project_id, slug, title, current_body, generated_body,
        source_commit_sha, citations, created_by)
      VALUES (${crypto.randomUUID()}, ${projectID}, 'version-guide', 'Version guide',
        'The runtime fixture version is a single line in src/version.txt. Check src/server.mjs with node --check.',
        'The runtime fixture version is a single line in src/version.txt. Check src/server.mjs with node --check.',
        ${"a".repeat(40)}, '[]'::jsonb, ${userID})
    `;
    await transaction`
      INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
      VALUES (${ticketID}, ${projectID}, ${title}, 'A bounded live-model acceptance change.', 'ready', ${userID})
    `;
    await transaction`
      INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${crypto.randomUUID()}, ${ticketID}, 1, ${content}, ${requirementDigest(content)}, ${userID})
    `;
  });
});

test.afterEach(async ({ context, page }, testInfo) => {
  if (!database || !projectID) return;
  const turns = await database.client<{ id: string; kind: string; state: string; model: string }[]>`
    SELECT id, input->>'kind' AS kind, state::text, authority->>'modelId' AS model
    FROM factory.agent_turn WHERE project_id = ${projectID} ORDER BY created_at
  `;
  await writeFile(
    `${evidenceDirectory}/run-outcome.json`,
    `${JSON.stringify(
      {
        projectID,
        projectSlug,
        status: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        turns: turns.map(({ id, kind, state, model }) => ({ id, kind, state, model })),
      },
      null,
      2,
    )}\n`,
  );
  if (testInfo.status !== testInfo.expectedStatus) {
    await page
      .screenshot({ path: `${evidenceDirectory}/interrupted-baseline.png` })
      .catch(() => undefined);
  }
  const owned = await database.client<{ slug: string }[]>`
    SELECT slug FROM factory.project WHERE id = ${projectID}
  `;
  expect(owned.map(({ slug }) => slug)).toEqual([projectSlug]);
  const changes = await database.client<{ id: string; branch: string }[]>`
    SELECT id, branch_name AS branch FROM factory.change WHERE project_id = ${projectID}
  `;
  for (const change of changes) {
    const stopped = await requestFunction(context.request, "stopCoding", [change.id]);
    expect(stopped.ok).toBe(true);
    const cancelled = await requestFunction(context.request, "cancelChange", [change.id]);
    expect(cancelled.ok).toBe(true);
  }
  await stopProjectRuntimes(context.request, projectID);
  // Cancellation must remove owned compute/storage before its recovery identities are deleted.
  await expect
    .poll(
      async () => {
        const result = await execute(
          "kubectl",
          [
            "--context",
            "orbstack",
            "get",
            "namespaces",
            "-l",
            `factory.dev/project=${projectID}`,
            "-o",
            "json",
          ],
          { timeout: 15_000 },
        );
        const namespaces = JSON.parse(result.stdout) as { items: unknown[] };
        return namespaces.items.length;
      },
      { timeout: 180_000 },
    )
    .toBe(0);
  await deleteFactoryProject(projectID);
  const forge = createForgejoClient({
    apiURL: "http://127.0.0.1:33030/api/v1/",
    token: (await readFile(".factory/forgejo-token", "utf8")).trim(),
  });
  for (const change of changes) await forge.deleteBranch(repository, change.branch);
  await database.client.end();
  database = undefined;
  projectID = "";
});

test("runs genuine Project and Build turns beside the embedded IDE and Preview", async ({
  page,
}) => {
  test.setTimeout(720_000);
  if (!database) throw new Error("Missing live fixture database");
  const fixtureDatabase = database;
  await signIn(page);
  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: projectSlug }).click();
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button", { name: new RegExp(title) })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  const panel = page.getByRole("complementary", { name: "Agent panel" });
  await panel
    .getByLabel("Message conversation")
    .fill(
      "Where is this Project's version stored and how is its server syntax checked? Cite the Version guide.",
    );
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.locator(".agent-message.assistant").last()).toBeVisible({ timeout: 120_000 });
  await expect(
    panel.getByRole("button", { name: /Source \d+: Version guide/ }).first(),
  ).toBeVisible();
  const compute = await fixtureDatabase.client<{ workspaces: number; attempts: number }[]>`
    SELECT (SELECT count(*)::integer FROM factory.development_workspace WHERE project_id = ${projectID}) AS workspaces,
      (SELECT count(*)::integer FROM factory.runtime_attempt WHERE project_id = ${projectID}) AS attempts
  `;
  expect(compute.map(({ workspaces, attempts }) => ({ workspaces, attempts }))).toEqual([
    { workspaces: 0, attempts: 0 },
  ]);
  await page.screenshot({ path: `${evidenceDirectory}/project-agent.png` });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Start Change", exact: true }).click();
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Start implementation" })).toBeEnabled();
  await panel.getByRole("button", { name: "Start implementation" }).click();
  await expect
    .poll(
      async () => {
        const rows = await fixtureDatabase.client<{ state: string }[]>`
      SELECT state::text FROM factory.agent_turn WHERE project_id = ${projectID} AND change_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `;
        return rows[0]?.state;
      },
      { timeout: 360_000 },
    )
    .toBe("completed");
  await expect(panel.locator(".agent-state")).toHaveText("Submitted for verification", {
    timeout: 15_000,
  });
  await expect(panel.locator(".agent-message.assistant").last()).toBeVisible();
  await page.screenshot({ path: `${evidenceDirectory}/build-agent.png` });
  await page.getByRole("button", { name: "IDE", exact: true }).click();
  const workspaceOption = page.getByRole("menuitem", { name: new RegExp(title) });
  if (await workspaceOption.isVisible()) await workspaceOption.click();
  const ide = page.locator('iframe[title="Factory IDE"]').contentFrame();
  await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 300_000 });
  await expect(ide.locator(".theia-preload")).toHaveCount(0);
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  const terminal = ide.locator(".factory-terminal-host:not([hidden])");
  await expect(terminal).toHaveAttribute("data-connection-state", "connected");
  await terminal.locator(".xterm").click();
  await page.keyboard.type("cat src/version.txt");
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText(projectSlug);
  await page.screenshot({ path: `${evidenceDirectory}/agent-ide-terminal.png` });
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Run" }).click();
  const run = ide.locator(".factory-runtime-widget");
  await run.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator('iframe[title="Factory Preview"]').contentFrame();
  await expect(preview.getByRole("heading", { name: "Runtime fixture ready" })).toBeVisible({
    timeout: 120_000,
  });
  await page.screenshot({ path: `${evidenceDirectory}/agent-preview.png` });
  const turns = await fixtureDatabase.client<
    { id: string; kind: string; state: string; model: string }[]
  >`
    SELECT id, input->>'kind' AS kind, state::text, authority->>'modelId' AS model
    FROM factory.agent_turn WHERE project_id = ${projectID} ORDER BY created_at
  `;
  const summary = turns.map(({ id, kind, state, model }) => ({ id, kind, state, model }));
  expect(summary).toEqual([
    {
      id: expect.any(String),
      kind: "project-message",
      state: "completed",
      model: FACTORY_PROJECT_AGENT_MODEL,
    },
    {
      id: expect.any(String),
      kind: "change-start",
      state: "completed",
      model: FACTORY_AGENT_MODEL_ID,
    },
  ]);
  await writeFile(
    `${evidenceDirectory}/turns.json`,
    `${JSON.stringify({ projectID, projectSlug, planningCompute: compute.map(({ workspaces, attempts }) => ({ workspaces, attempts })), turns: summary }, null, 2)}\n`,
  );
});
