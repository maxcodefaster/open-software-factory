import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { ticketWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { openProjectMenu } from "../fixtures/project-menu";
import { requestFunction } from "../fixtures/server-functions";
import { teardownFactoryProject } from "../support/factory-fixture";

const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
const password = process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password";
const repositoryURL = "http://127.0.0.1:33030/factory-mutation/runtime-fixture.git";
const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const userID = "01994a7d-0000-7000-8000-000000000001";
let projectID: string | null = null;
let changeID: string | null = null;
let database: ReturnType<typeof createDatabase> | null = null;
let forgeToken = "";
let ownedBranch: { name: string; headSHA: string } | null = null;

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
}

test.beforeAll(async () => {
  forgeToken = (await readFile(".factory/forgejo-token", "utf8")).trim();
  await mkdir(".factory/screenshots", { recursive: true });
});

test.afterEach(async ({ context }, testInfo) => {
  try {
    if (database && projectID && testInfo.status !== testInfo.expectedStatus) {
      const attempts = await database.client`
        SELECT id, isolated_kind, generation, state, failure,
          kubernetes_namespace, kubernetes_pod_name
        FROM factory.runtime_attempt WHERE project_id = ${projectID}
        ORDER BY created_at
      `;
      const verifications = await database.client`
        SELECT id, commit_sha, state, runtime_attempt_id, action_run_id, runner_id, summary
        FROM factory.verification WHERE change_id = ${changeID}
      `;
      await testInfo.attach("delivery-state", {
        body: JSON.stringify(
          { projectID, attempts: Array.from(attempts), verifications: Array.from(verifications) },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
    if (changeID) {
      await serverCall(requestFunction(context.request, "cancelChange", [changeID]));
    }
    await teardownFactoryProject(context.request, projectID);
    if (ownedBranch) {
      const forge = createForgejoClient({
        apiURL: "http://127.0.0.1:33030/api/v1/",
        token: forgeToken,
      });
      const branch = await forge.getBranch(repository, ownedBranch.name);
      const pullRequest = await forge.getPullRequest(repository, "main", ownedBranch.name);
      if (pullRequest && !pullRequest.merged && pullRequest.state === "open") {
        if (pullRequest.headSha !== ownedBranch.headSHA)
          throw new Error("Fixture PR head changed; cleanup refused");
        const closed = await fetch(
          `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}`,
          {
            method: "PATCH",
            headers: { authorization: `Bearer ${forgeToken}`, "content-type": "application/json" },
            body: JSON.stringify({ state: "closed" }),
          },
        );
        if (!closed.ok) throw new Error(`Fixture PR cleanup returned ${closed.status}`);
      }
      if (branch) {
        if (branch.headSha !== ownedBranch.headSHA)
          throw new Error("Fixture branch head changed; cleanup refused");
        await forge.deleteBranch(repository, ownedBranch.name);
      }
    }
  } finally {
    await database?.client.end();
    database = null;
    projectID = null;
    changeID = null;
    ownedBranch = null;
  }
});

test("Forgejo Actions verifies, approves, merges, and replaces Staging", async ({
  page,
  context,
}, testInfo) => {
  testInfo.setTimeout(900_000);
  const forge = createForgejoClient({
    apiURL: "http://127.0.0.1:33030/api/v1/",
    token: forgeToken,
  });
  const base = await forge.getDefaultBranch(repository);
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const identity = changeIdentity(ticketID, approvalID);
  const workspace = ticketWorkspaceIdentity(identity.changeID);
  const historicalAttempt = runtimeIdentity(workspace.workspaceID, 1);
  ownedBranch = { name: identity.branchName, headSHA: base.headSha };
  await forge.ensureBranch(repository, identity.branchName, base.headSha);
  const source = await fetch(
    `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/contents/src/version.txt?ref=${encodeURIComponent(identity.branchName)}`,
    { headers: { authorization: `Bearer ${forgeToken}` } },
  );
  if (!source.ok) throw new Error(`Fixture source lookup returned ${source.status}`);
  const sourceFile = (await source.json()) as { sha: string };
  const deliveredVersion = `delivered-${crypto.randomUUID().slice(0, 8)}`;
  const updated = await fetch(
    `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/contents/src/version.txt`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${forgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        branch: identity.branchName,
        sha: sourceFile.sha,
        message: "Delivery fixture change",
        content: Buffer.from(`${deliveredVersion}\n`).toString("base64"),
      }),
    },
  );
  if (!updated.ok) throw new Error(`Fixture source update returned ${updated.status}`);
  const updateBody = (await updated.json()) as { commit: { sha: string } };
  const candidateSHA = updateBody.commit.sha;
  ownedBranch.headSHA = candidateSHA;

  const db = createDatabase(1);
  database = db;
  projectID = crypto.randomUUID();
  changeID = identity.changeID;
  const slug = `delivery-${crypto.randomUUID().slice(0, 8)}`;
  const canonicalContent = JSON.stringify({
    summary: "Deliver one exact verified fixture commit.",
    acceptanceCriteria: ["Forgejo Actions is green", "Staging serves the approved commit"],
    nonGoals: ["Build a release artifact"],
  });
  const digest = createHash("sha256").update(canonicalContent).digest("hex");
  await db.client.begin(async (transaction) => {
    await transaction`
      INSERT INTO factory.project(
        id, slug, name, repository_url, default_branch, devcontainer_path, created_by
      ) VALUES (
        ${projectID}, ${slug}, 'Delivery fixture', ${repositoryURL}, 'main',
        '.devcontainer/devcontainer.json', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.ticket(id, project_id, title, description, state, created_by)
      VALUES (
        ${ticketID}, ${projectID}, 'Deliver verified fixture',
        'Verify the exact branch commit and promote it to Staging.', 'in-progress', ${userID}
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
    await transaction`
      INSERT INTO factory.development_workspace(
        id, project_id, kind, ticket_id, change_id, source_branch, source_revision, created_by
      ) VALUES (
        ${workspace.workspaceID}, ${projectID}, 'ticket', ${ticketID}, ${identity.changeID},
        ${identity.branchName}, ${base.headSha}, ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.runtime_attempt(
        id, project_id, change_id, workspace_id, generation, revision, state, parent_connector_token_hash,
        child_connector_token_hash, create_intended_at, created_by
      ) VALUES (
        ${historicalAttempt.attemptID}, ${projectID}, ${identity.changeID},
        ${workspace.workspaceID}, 1, ${base.headSha}, 'stopped', ${"a".repeat(64)}, ${"b".repeat(64)}, now(), ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.change_commit_operation(
        id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
        commit_sha, observed_remote_sha, commit_message, idempotency_key, state,
        created_by, completed_at
      ) VALUES (
        ${crypto.randomUUID()}, ${identity.changeID}, ${historicalAttempt.attemptID}, 1,
        ${identity.branchName}, ${base.headSha}, ${candidateSHA}, ${candidateSHA},
        'Delivery fixture change', ${`delivery-fixture:${identity.changeID}`}, 'succeeded',
        ${userID}, now()
      )
    `;
  });

  await signIn(page);
  await serverCall(requestFunction(context.request, "ensureStaging", [projectID]));
  await expect
    .poll(
      async () => {
        const rows = await db.client<Array<{ state: string }>>`
          SELECT attempt.state FROM factory.staging_preview preview
          JOIN factory.runtime_attempt attempt ON attempt.id = preview.runtime_attempt_id
          WHERE preview.project_id = ${projectID}
        `;
        return rows[0]?.state;
      },
      { timeout: 240_000 },
    )
    .toBe("ready");
  const initialPreview = await db.client<Array<{ attemptID: string }>>`
    SELECT runtime_attempt_id AS "attemptID" FROM factory.staging_preview
    WHERE project_id = ${projectID}
  `;
  const initialStagingAttemptID = initialPreview[0]?.attemptID;
  if (!initialStagingAttemptID) throw new Error("Initial Staging was not recorded");

  await openProjectMenu(page);
  await page.getByRole("button").filter({ hasText: slug }).click();
  await page
    .getByRole("region", { name: "Ticket board" })
    .getByRole("button", { name: /Deliver verified fixture/ })
    .click();
  const metadata = page.locator(".ticket-metadata");
  await expect(metadata.getByText("succeeded", { exact: true })).toBeVisible({ timeout: 360_000 });
  const verification = await db.client<
    Array<{ commitSHA: string; actionRunID: string; runtimeAttemptID: string }>
  >`
    SELECT commit_sha AS "commitSHA", action_run_id AS "actionRunID",
      runtime_attempt_id AS "runtimeAttemptID"
    FROM factory.verification
    WHERE change_id = ${identity.changeID} AND state = 'succeeded'
  `;
  expect(verification[0]?.commitSHA).toBe(candidateSHA);
  expect(verification[0]?.actionRunID).toBeTruthy();
  const verificationRuntimeAttemptID = verification[0]?.runtimeAttemptID;
  if (!verificationRuntimeAttemptID) throw new Error("Verification returned no Runtime Attempt");
  const verificationAttempt = await db.client<Array<{ revision: string }>>`
    SELECT revision FROM factory.runtime_attempt WHERE id = ${verificationRuntimeAttemptID}
  `;
  expect(verificationAttempt[0]?.revision).toBe(candidateSHA);
  await page.screenshot({ path: ".factory/screenshots/delivery-verified.png", fullPage: true });

  await page.getByRole("button", { name: "Approve delivery" }).click();
  await expect
    .poll(
      async () => {
        const rows = await db.client<
          Array<{
            previewAttemptID: string;
            replacementAttemptID: string;
            replacementState: string;
          }>
        >`
          SELECT preview.runtime_attempt_id AS "previewAttemptID",
            promotion.replacement_runtime_attempt_id AS "replacementAttemptID",
            attempt.state AS "replacementState"
          FROM factory.promotion_operation promotion
          JOIN factory.staging_preview preview ON preview.project_id = promotion.project_id
          JOIN factory.runtime_attempt attempt
            ON attempt.id = promotion.replacement_runtime_attempt_id
          WHERE promotion.change_id = ${identity.changeID}
        `;
        const row = rows[0];
        if (!row || row.replacementState === "ready") return null;
        return row;
      },
      { timeout: 180_000 },
    )
    .toMatchObject({ previewAttemptID: initialStagingAttemptID });
  await expect(metadata.locator(".state-heading")).toHaveText("Delivered", { timeout: 360_000 });
  await expect(page.getByText("This approved revision was delivered.")).toBeVisible();
  await expect(metadata.getByText("Runtime", { exact: true })).toHaveCount(0);

  expect((await forge.getDefaultBranch(repository)).headSha).toBe(candidateSHA);
  expect(await forge.getBranch(repository, identity.branchName)).toBeNull();
  const promoted = await db.client<Array<{ revision: string; state: string; attemptID: string }>>`
    SELECT preview.revision, attempt.state,
      preview.runtime_attempt_id AS "attemptID"
    FROM factory.staging_preview preview
    JOIN factory.runtime_attempt attempt ON attempt.id = preview.runtime_attempt_id
    WHERE preview.project_id = ${projectID}
  `;
  expect(promoted[0]).toMatchObject({ revision: candidateSHA, state: "ready" });
  expect(promoted[0]?.attemptID).not.toBe(initialStagingAttemptID);

  const previewButton = page.getByRole("button", { name: "Preview", exact: true });
  await previewButton.click();
  const previewSwitcher = page.getByRole("menu", { name: "Preview instances" });
  if (await previewSwitcher.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await previewSwitcher.getByRole("menuitem").filter({ hasText: "ready" }).last().click();
  } else if (!(await page.getByRole("region", { name: "preview workspace" }).isVisible())) {
    await previewButton.click();
  }
  const preview = page.frameLocator('iframe[title="Factory Preview"]');
  await expect(preview.locator("#version")).toHaveText(deliveredVersion, { timeout: 120_000 });
  await page.screenshot({ path: ".factory/screenshots/delivery-promoted.png", fullPage: true });
});
