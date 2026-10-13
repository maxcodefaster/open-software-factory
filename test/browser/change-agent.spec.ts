import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { teardownFactoryProject } from "../support/factory-fixture";

const execute = promisify(execFile);
const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
const password = process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password";
const repositoryURL = "http://127.0.0.1:33030/factory-mutation/runtime-fixture.git";
const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const userID = "01994a7d-0000-7000-8000-000000000001";
const modelPort = 43_000 + (process.pid % 1_000);
const modelURL = `http://127.0.0.1:${modelPort}`;
let modelProcess: ChildProcess | undefined;
let fixtureDatabase: ReturnType<typeof createDatabase> | undefined;
let createdChangeID: string | null = null;
let createdProjectID: string | null = null;
const previousModelBaseURL = process.env["FACTORY_MODEL_BASE_URL"];
const previousModelAPIKey = process.env["FACTORY_MODEL_API_KEY"];

async function restartFactory() {
  await execute("bun", ["run", "factory:restart"], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 180_000,
  });
}

async function modelControl(path: string, init?: RequestInit) {
  const response = await fetch(`${modelURL}${path}`, init);
  if (!response.ok) throw new Error(`Fake model ${path} returned ${response.status}`);
  return response;
}

test.beforeAll(async () => {
  modelProcess = spawn("bun", ["test/support/fake-openai-model.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, FACTORY_FAKE_MODEL_PORT: String(modelPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await expect
    .poll(
      async () => {
        const response = await fetch(`${modelURL}/control/stats`).catch(() => null);
        return response?.ok ?? false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  process.env["FACTORY_MODEL_BASE_URL"] = `${modelURL}/v1`;
  process.env["FACTORY_MODEL_API_KEY"] = "factory-test-key";
  await restartFactory();
});

test.afterAll(async () => {
  if (previousModelBaseURL === undefined) delete process.env["FACTORY_MODEL_BASE_URL"];
  else process.env["FACTORY_MODEL_BASE_URL"] = previousModelBaseURL;
  if (previousModelAPIKey === undefined) delete process.env["FACTORY_MODEL_API_KEY"];
  else process.env["FACTORY_MODEL_API_KEY"] = previousModelAPIKey;
  await restartFactory().catch(() => undefined);
  modelProcess?.kill("SIGTERM");
});

test.afterEach(async ({ context }) => {
  if (createdChangeID) {
    await context.request.post(`/api/changes/${createdChangeID}/cancel`, {
      headers: { origin: "http://127.0.0.1:3000" },
    });
  }
  await teardownFactoryProject(context.request, createdProjectID);
  createdChangeID = null;
  createdProjectID = null;
  await fixtureDatabase?.client.end();
  fixtureDatabase = undefined;
  await modelControl("/control/reset", { method: "POST" });
});

test("OpenCode stops, resumes the retained Ticket Workspace, checks, and pushes", async ({
  page,
  context,
}, testInfo) => {
  testInfo.setTimeout(720_000);
  const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
  const forge = createForgejoClient({ apiURL: "http://127.0.0.1:33030/api/v1/", token });
  const base = await forge.getDefaultBranch(repository);
  const database = createDatabase(1);
  fixtureDatabase = database;
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const identity = changeIdentity(ticketID, approvalID);
  const slug = `agent-fixture-${crypto.randomUUID().slice(0, 8)}`;
  const canonicalContent = JSON.stringify({
    acceptanceCriteria: [
      "The version endpoint reports agent",
      "The source passes its syntax check",
    ],
    nonGoals: ["Create a pull request"],
    summary: "Update the runtime fixture version and verify the server source.",
  });
  const digest = createHash("sha256").update(canonicalContent).digest("hex");
  await forge.ensureBranch(repository, identity.branchName, base.headSha);
  await database.client.begin(async (transaction) => {
    await transaction`
      INSERT INTO factory.project(
        id, slug, name, repository_url, default_branch, devcontainer_path, created_by
      ) VALUES (
        ${projectID}, ${slug}, 'Change Agent fixture', ${repositoryURL}, 'main',
        '.devcontainer/devcontainer.json', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
      VALUES (
        ${ticketID}, ${projectID}, 'Update fixture version',
        'Change src/version.txt to agent and check src/server.mjs.', 'in-progress', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.requirement_revision(
        id, ticket_id, ordinal, canonical_content, content_digest, created_by
      ) VALUES (${revisionID}, ${ticketID}, 1, ${canonicalContent}, ${digest}, ${userID})
    `;
    await transaction`
      INSERT INTO factory.requirement_approval(
        id, ticket_id, requirement_revision_id, approved_by
      ) VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID})
    `;
    await transaction`
      INSERT INTO factory.change(
        id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
        state, created_by
      ) VALUES (
        ${identity.changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${identity.branchName},
        ${base.headSha}, 'active', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.branch_create_operation(
        id, change_id, repository_owner, repository_name, branch_name, start_sha,
        idempotency_key, state, observed_head_sha, completed_at
      ) VALUES (
        ${identity.branchOperationID}, ${identity.changeID}, ${repository.owner}, ${repository.name},
        ${identity.branchName}, ${base.headSha}, ${`change:${identity.changeID}:create-branch`},
        'succeeded', ${base.headSha}, now()
      )
    `;
  });
  createdProjectID = projectID;
  createdChangeID = identity.changeID;

  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await page.getByRole("button", { name: "Open project menu" }).click();
  await expect(page.getByText(slug, { exact: true })).toBeVisible();
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button", { name: /Update fixture version/ })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(page.getByRole("button", { name: "Start implementation" })).toBeEnabled();
  await page.getByRole("button", { name: "Start implementation" }).click();

  await expect
    .poll(
      async () => {
        const stats = (await (await modelControl("/control/stats")).json()) as {
          agentRequests: number;
        };
        return stats.agentRequests;
      },
      { timeout: 300_000 },
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".agent-state")).toHaveText("working");

  const attemptsBeforeStop = await context.request.get("/api/runtime-attempts");
  const firstAttempts = (await attemptsBeforeStop.json()) as {
    attempts: Array<{ id: string; projectId: string; state: string }>;
  };
  const firstAttempt = firstAttempts.attempts.find(
    (attempt) => attempt.projectId === projectID && attempt.state === "ready",
  );
  if (!firstAttempt) throw new Error("The first Ticket Sandbox was not ready");
  const sessionsBefore = await database.client<Array<{ sessionID: string }>>`
    SELECT opencode_session_id AS "sessionID" FROM factory.change_agent_session
    WHERE change_id = ${identity.changeID}
  `;
  const retainedSessionID = sessionsBefore[0]?.sessionID;
  expect(retainedSessionID).toMatch(/^ses_/);

  await page.getByRole("button", { name: "Stop OpenCode" }).click();
  await expect(page.locator(".agent-state")).toHaveText("stopped");
  await modelControl("/control/release", { method: "POST" });
  await page.waitForTimeout(3_000);
  expect((await forge.getBranch(repository, identity.branchName))?.headSha).toBe(base.headSha);

  await restartFactory();
  await page.reload();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
  await page.getByRole("button", { name: "Open project menu" }).click();
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button", { name: /Update fixture version/ })
    .click();
  await page.getByRole("button", { name: "Toggle Agent panel" }).click();
  await expect(page.locator(".agent-state")).toHaveText("stopped");

  await context.request.post(`/api/runtime-attempts/${firstAttempt.id}/stop`, {
    headers: { origin: "http://127.0.0.1:3000" },
  });
  await expect
    .poll(
      async () => {
        const response = await context.request.get("/api/runtime-attempts");
        const body = (await response.json()) as {
          attempts: Array<{ id: string; state: string }>;
        };
        return body.attempts.find((attempt) => attempt.id === firstAttempt.id)?.state;
      },
      { timeout: 180_000 },
    )
    .toBe("stopped");

  await page
    .getByLabel("Message conversation")
    .fill("Continue in the retained session and finish.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".agent-state")).toHaveText("starting");
  await expect(page.locator(".agent-state")).toHaveText("committed", { timeout: 360_000 });
  await expect(
    page.locator(".agent-activity.completed").filter({ hasText: "Updated src/version.txt" }),
  ).toBeVisible();
  await expect(
    page.locator(".agent-activity.completed").filter({ hasText: "node --check src/server.mjs" }),
  ).toBeVisible();
  await expect(page.getByText(/local syntax check passed/i)).toBeVisible();
  await expect(page.getByText("Build complete", { exact: true })).toBeVisible();

  const attemptsAfterResume = await context.request.get("/api/runtime-attempts");
  const resumedAttempts = (await attemptsAfterResume.json()) as {
    attempts: Array<{ id: string; projectId: string; state: string }>;
  };
  const resumedAttempt = resumedAttempts.attempts.find(
    (attempt) =>
      attempt.projectId === projectID &&
      attempt.id !== firstAttempt.id &&
      attempt.state === "ready",
  );
  if (!resumedAttempt) throw new Error("The resumed Ticket Sandbox was not ready");
  const sessionsAfter = await database.client<Array<{ sessionID: string }>>`
    SELECT opencode_session_id AS "sessionID" FROM factory.change_agent_session
    WHERE change_id = ${identity.changeID}
  `;
  expect(sessionsAfter[0]?.sessionID).toBe(retainedSessionID);

  const branch = await forge.getBranch(repository, identity.branchName);
  expect(branch?.headSha).toMatch(/^[0-9a-f]{40}$/);
  expect(branch?.headSha).not.toBe(base.headSha);
  const agentView = (await (
    await context.request.get(`/api/changes/${identity.changeID}/agent`)
  ).json()) as { commitSHA: string };
  expect(agentView.commitSHA).toBe(branch?.headSha);
  const contentResponse = await fetch(
    `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/contents/src/version.txt?ref=${encodeURIComponent(identity.branchName)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(contentResponse.ok).toBe(true);
  const content = (await contentResponse.json()) as { content: string };
  expect(Buffer.from(content.content, "base64").toString()).toBe("agent\n");

  await page.getByRole("button", { name: "Minimize Agent panel" }).click();
  let ideVerified = false;
  for (let attempt = 0; attempt < 3 && !ideVerified; attempt += 1) {
    await expect
      .poll(
        async () => {
          const response = await context.request.get("/api/runtime-attempts");
          const body = (await response.json()) as {
            attempts: Array<{ id: string; state: string }>;
          };
          return body.attempts.find((runtime) => runtime.id === resumedAttempt.id)?.state;
        },
        { timeout: 120_000 },
      )
      .toBe("ready");
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    const ideMenu = page.getByRole("menu", { name: "IDE instances" });
    if (await ideMenu.isVisible().catch(() => false)) {
      await ideMenu.getByRole("menuitem", { name: /Update fixture version/ }).click();
    }
    const ide = page.frameLocator('iframe[title="Factory IDE"]');
    try {
      await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 120_000 });
      const sourceFolder = ide.getByText("src", { exact: true }).first();
      await expect(sourceFolder).toBeVisible({ timeout: 120_000 });
      await sourceFolder.click();
      const versionFile = ide.getByText("version.txt", { exact: true }).first();
      for (let expansion = 0; expansion < 6; expansion += 1) {
        if (await versionFile.isVisible().catch(() => false)) break;
        await sourceFolder.press("ArrowRight");
        await page.waitForTimeout(5_000);
      }
      await expect(versionFile).toBeVisible({ timeout: 30_000 });
      await versionFile.click();
      await expect(
        ide.locator(".monaco-editor:visible .view-lines").filter({ hasText: "agent" }).first(),
      ).toBeVisible({ timeout: 30_000 });
      ideVerified = true;
    } catch (cause) {
      if (attempt === 2) throw cause;
      await page.getByRole("button", { name: "Desktop", exact: true }).click();
    }
  }
  expect(ideVerified).toBe(true);
});
