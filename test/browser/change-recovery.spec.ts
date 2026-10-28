import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-test";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../packages/runtime-domain/src/identity";
import { ticketWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { requestFunction } from "../fixtures/server-functions";
import { teardownFactoryProject } from "../support/factory-fixture";

const execute = promisify(execFile);
const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
const password = process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password";
const repositoryURL = "http://127.0.0.1:33030/factory-mutation/runtime-fixture.git";
const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const userID = "01994a7d-0000-7000-8000-000000000001";
let createdProjectID: string | null = null;
let createdChangeIDs: string[] = [];

async function command(executable: string, arguments_: string[]) {
  const { stdout } = await execute(executable, arguments_, { cwd: process.cwd() });
  return stdout.trim();
}

test.afterEach(async ({ context }) => {
  for (const changeID of createdChangeIDs) {
    await serverCall(requestFunction(context.request, "cancelChange", [changeID]));
  }
  await teardownFactoryProject(context.request, createdProjectID);
  createdProjectID = null;
  createdChangeIDs = [];
});

test("Factory recovers pending branch, Staging, and Ticket Workspace intent", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(480_000);
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Ticket board" })).toBeVisible();

  const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
  const forge = createForgejoClient({ apiURL: "http://127.0.0.1:33030/api/v1/", token });
  const base = await forge.getDefaultBranch(repository);
  const authSecret = (await readFile(".factory/auth-secret", "utf8")).trim();
  const database = createDatabase(1);
  const projectID = crypto.randomUUID();
  createdProjectID = projectID;
  const slug = `change-recovery-${crypto.randomUUID().slice(0, 8)}`;

  await database.client`
    INSERT INTO factory.project(
      id, slug, name, repository_url, default_branch, devcontainer_path, created_by
    ) VALUES (
      ${projectID}, ${slug}, 'Change recovery fixture', ${repositoryURL}, 'main',
      '.devcontainer/devcontainer.json', ${userID}
    )
  `;
  await database.client`
    INSERT INTO factory.staging_preview(project_id, revision)
    VALUES (${projectID}, ${base.headSha})
  `;

  async function insertApprovedChange(ordinal: number, branchState: "executing" | "succeeded") {
    const ticketID = crypto.randomUUID();
    const revisionID = crypto.randomUUID();
    const approvalID = crypto.randomUUID();
    const canonicalContent = JSON.stringify({
      acceptanceCriteria: [`Recovery phase ${ordinal} reaches active`],
      nonGoals: [],
      summary: `Recover Change phase ${ordinal}`,
    });
    const digest = createHash("sha256").update(canonicalContent).digest("hex");
    const identity = changeIdentity(ticketID, approvalID);
    await database.client.begin(async (transaction) => {
      await transaction`
        INSERT INTO factory.ticket(id, project_id, title, state, created_by)
        VALUES (${ticketID}, ${projectID}, ${`Recovery Ticket ${ordinal}`}, 'in-progress', ${userID})
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
          ${base.headSha}, ${branchState === "executing" ? "branch-pending" : "starting"}::factory.change_state,
          ${userID}
        )
      `;
      await transaction`
        INSERT INTO factory.branch_create_operation(
          id, change_id, repository_owner, repository_name, branch_name, start_sha,
          idempotency_key, state, attempt_count, lease_owner, lease_expires_at,
          observed_head_sha, completed_at
        ) VALUES (
          ${identity.branchOperationID}, ${identity.changeID}, ${repository.owner}, ${repository.name},
          ${identity.branchName}, ${base.headSha}, ${`change:${identity.changeID}:create-branch`},
          ${branchState}::factory.branch_operation_state,
          ${branchState === "executing" ? 1 : 0},
          ${branchState === "executing" ? "lost-factory-process" : null},
          CASE WHEN ${branchState === "executing"} THEN now() + interval '30 seconds' ELSE NULL END,
          ${branchState === "succeeded" ? base.headSha : null},
          CASE WHEN ${branchState === "succeeded"} THEN now() ELSE NULL END
        )
      `;
    });
    createdChangeIDs.push(identity.changeID);
    return { ...identity, ticketID };
  }

  const branchRecovery = await insertApprovedChange(1, "executing");
  await command("bun", ["run", "factory:restart"]);
  await expect
    .poll(
      async () => {
        const response = await requestFunction(page.context().request, "getChanges", []);
        if (!response.ok) return "unavailable";
        const changes = (await serverCall(Promise.resolve(response))) as {
          changes: Array<{ id: string; state: string }>;
        };
        return changes.changes.find((change) => change.id === branchRecovery.changeID)?.state;
      },
      { timeout: 180_000 },
    )
    .toBe("active");
  expect((await forge.getBranch(repository, branchRecovery.branchName))?.headSha).toBe(
    base.headSha,
  );

  let attempts = await database.client<Array<{ id: string; namespace: string }>>`
    SELECT id, kubernetes_namespace AS namespace FROM factory.runtime_attempt
    WHERE change_id = ${branchRecovery.changeID}
  `;
  expect(attempts).toEqual([]);
  await serverCall(
    requestFunction(page.context().request, "cancelChange", [branchRecovery.changeID]),
  );
  await expect
    .poll(
      async () => {
        const rows = await database.client<Array<{ state: string }>>`
          SELECT state FROM factory.change WHERE id = ${branchRecovery.changeID}
        `;
        return rows[0]?.state;
      },
      { timeout: 180_000 },
    )
    .toBe("cancelled");
  const branchWorkspaces = await database.client<Array<{ id: string }>>`
    SELECT id FROM factory.development_workspace WHERE change_id = ${branchRecovery.changeID}
  `;
  expect(branchWorkspaces).toEqual([]);

  const runtimeRecovery = await insertApprovedChange(2, "succeeded");
  await forge.ensureBranch(repository, runtimeRecovery.branchName, base.headSha);
  await expect
    .poll(
      async () => {
        const rows = await database.client<Array<{ attemptID: string }>>`
          SELECT staging.runtime_attempt_id AS "attemptID"
          FROM factory.staging_preview staging
          WHERE staging.project_id = ${projectID}
        `;
        return rows[0]?.attemptID;
      },
      { timeout: 180_000 },
    )
    .toMatch(/^[0-9a-f-]{36}$/);
  const stagingBeforeRestart = await database.client<Array<{ attemptID: string; state: string }>>`
    SELECT staging.runtime_attempt_id AS "attemptID", attempt.state
    FROM factory.staging_preview staging
    JOIN factory.runtime_attempt attempt ON attempt.id = staging.runtime_attempt_id
    WHERE staging.project_id = ${projectID}
  `;
  expect(stagingBeforeRestart[0]?.attemptID).toMatch(/^[0-9a-f-]{36}$/);
  expect(["create-intended", "starting", "ready"]).toContain(stagingBeforeRestart[0]?.state);
  const workspace = ticketWorkspaceIdentity(runtimeRecovery.changeID);
  const runtime = runtimeIdentity(workspace.workspaceID, 1);
  const connectorTokens = runtimeConnectorTokens(authSecret, runtime.attemptID, 1);
  await database.client.begin(async (transaction) => {
    await transaction`
      INSERT INTO factory.development_workspace(
        id, project_id, kind, ticket_id, change_id, source_branch, source_revision, created_by
      ) VALUES (
        ${workspace.workspaceID}, ${projectID}, 'ticket', ${runtimeRecovery.ticketID},
        ${runtimeRecovery.changeID}, ${runtimeRecovery.branchName}, ${base.headSha}, ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.runtime_attempt(
        id, project_id, change_id, workspace_id, generation, revision, state, parent_connector_token_hash,
        child_connector_token_hash, create_intended_at, created_by
      ) VALUES (
        ${runtime.attemptID}, ${projectID}, ${runtimeRecovery.changeID}, ${workspace.workspaceID},
        1, ${base.headSha}, 'create-intended',
        ${createHash("sha256").update(connectorTokens.parent).digest("hex")},
        ${createHash("sha256").update(connectorTokens.child).digest("hex")}, now(), ${userID}
      )
    `;
    await transaction`
      UPDATE factory.change SET runtime_attempt_id = ${runtime.attemptID}
      WHERE id = ${runtimeRecovery.changeID}
    `;
  });
  const [location] = await database.client<Array<{ namespace: string; uid: string | null }>>`
    SELECT kubernetes_namespace AS namespace,kubernetes_uid AS uid
    FROM factory.runtime_attempt WHERE id=${runtime.attemptID}`;
  if (!location) throw new Error("Missing recovered Runtime Attempt");
  expect(location.uid).toBeNull();

  await command("bun", ["run", "factory:restart"]);
  await expect
    .poll(
      async () => {
        const rows = await database.client<Array<{ state: string }>>`
          SELECT state FROM factory.change WHERE id = ${runtimeRecovery.changeID}
        `;
        return rows[0]?.state;
      },
      { timeout: 300_000 },
    )
    .toBe("active");
  await expect
    .poll(
      async () => {
        const rows = await database.client<Array<{ attemptID: string; state: string }>>`
          SELECT staging.runtime_attempt_id AS "attemptID", attempt.state
          FROM factory.staging_preview staging
          JOIN factory.runtime_attempt attempt ON attempt.id = staging.runtime_attempt_id
          WHERE staging.project_id = ${projectID}
        `;
        return rows[0];
      },
      { timeout: 300_000 },
    )
    .toEqual({ attemptID: stagingBeforeRestart[0]?.attemptID, state: "ready" });
  attempts = await database.client<Array<{ id: string; namespace: string }>>`
    SELECT id, kubernetes_namespace AS namespace FROM factory.runtime_attempt
    WHERE change_id = ${runtimeRecovery.changeID}
  `;
  expect(attempts).toEqual([{ id: runtime.attemptID, namespace: location.namespace }]);
  const workerUID = await command("kubectl", [
    "--context",
    "orbstack",
    "get",
    "pod",
    "worker",
    "-n",
    location.namespace,
    "-o",
    "jsonpath={.metadata.uid}",
  ]);
  expect(workerUID).not.toBe("");

  await serverCall(
    requestFunction(page.context().request, "cancelChange", [runtimeRecovery.changeID]),
  );
  await expect
    .poll(
      async () => {
        const rows = await database.client<Array<{ state: string }>>`
          SELECT state FROM factory.change WHERE id = ${runtimeRecovery.changeID}
        `;
        return rows[0]?.state;
      },
      { timeout: 180_000 },
    )
    .toBe("cancelled");
  await expect
    .poll(
      () =>
        command("kubectl", [
          "--context",
          "orbstack",
          "get",
          "pod",
          "worker",
          "-n",
          location.namespace,
          "-o",
          "jsonpath={.metadata.uid}",
        ]),
      { timeout: 180_000 },
    )
    .toBe(workerUID);
  await database.client.end();
});
