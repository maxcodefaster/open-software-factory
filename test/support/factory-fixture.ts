import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { createDatabase } from "../../packages/db/src/client";
import { zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { requestFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

export async function createPlanningEpic(input: {
  database: ReturnType<typeof createDatabase>;
  userID: string;
  projectID: string;
  title: string;
  parentID?: string | null;
}) {
  const id = crypto.randomUUID();
  await zeroDrizzle(zeroSchema, input.database.db).transaction((tx) =>
    zeroServerMutators.epics.create.fn({
      tx,
      ctx: { userId: input.userID, systemManager: true },
      args: {
        id,
        projectId: input.projectID,
        title: input.title,
        description: "",
        parentId: input.parentID ?? null,
      },
    }),
  );
  return id;
}

const terminalRuntimeStates = new Set(["failed", "stopped"]);

export async function signIn(page: Page) {
  const email = process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local";
  const password = process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password";
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function projectAttempts(request: APIRequestContext, projectID: string) {
  const body = await serverCall(requestFunction(request, "getRuntimeAttempts", [projectID]));
  return body.attempts;
}

export async function stopProjectRuntimes(request: APIRequestContext, projectID: string) {
  const attempts = await projectAttempts(request, projectID);
  await Promise.all(
    attempts
      .filter((attempt) => !terminalRuntimeStates.has(attempt.state))
      .map(async (attempt) => {
        await serverCall(requestFunction(request, "stopRuntimeAttempt", [attempt.id]));
      }),
  );
  if (!attempts.length) return;
  await expect
    .poll(
      async () => {
        const observed = await projectAttempts(request, projectID);
        return (
          attempts.every((attempt) => observed.some((current) => current.id === attempt.id)) &&
          observed.every((attempt) => terminalRuntimeStates.has(attempt.state))
        );
      },
      { timeout: 180_000 },
    )
    .toBe(true);
}

export async function deleteFactoryProject(
  projectID: string,
  ownedDatabase?: ReturnType<typeof createDatabase>,
) {
  const database = ownedDatabase ?? createDatabase(1);
  try {
    await database.client.begin(async (transaction) => {
      await transaction`DELETE FROM factory.usage_operation WHERE project_id=${projectID}`;
      await transaction`SET LOCAL session_replication_role = 'replica'`;
      await transaction`DELETE FROM factory.project_setup_confirmation WHERE inspection_id IN (SELECT id FROM factory.project_setup_inspection WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.project_setup_inspection WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.project_setup_readiness WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.project_setup_draft WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.project_repository_intent WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.execution_policy_command WHERE scope=${projectID}`;
      await transaction`DELETE FROM factory.execution_policy WHERE scope=${projectID}`;
      await transaction`DELETE FROM factory.runtime_compute_wait WHERE attempt_id IN (SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.forge_grant_intent WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.forge_branch_intent WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.change_writer WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.change_editing_request WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.change_editing_decision WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})`;
      await transaction`UPDATE factory.ticket_conversation SET active_coding_context_id=NULL WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.conversation_context WHERE conversation_id IN
        (SELECT id FROM factory.ticket_conversation WHERE project_id=${projectID})`;
      await transaction`
        DELETE FROM factory.build_browser_session
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`
        DELETE FROM factory.change_agent_turn_intent
        WHERE turn_id IN (SELECT id FROM factory.agent_turn WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.agent_turn_skill WHERE turn_id IN (SELECT id FROM factory.agent_turn WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.candidate_review WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.coding_pause WHERE turn_id IN (SELECT id FROM factory.agent_turn WHERE project_id=${projectID}) OR resumed_by_turn_id IN (SELECT id FROM factory.agent_turn WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.agent_turn WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.epic_confirmation WHERE project_id=${projectID}`;
      await transaction`
        DELETE FROM factory.conversation_entry
        WHERE conversation_id IN (
          SELECT id FROM factory.ticket_conversation WHERE project_id = ${projectID}
        )
      `;
      await transaction`DELETE FROM factory.ticket_conversation WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.knowledge_page_alias WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.knowledge_revision
        WHERE page_id IN (SELECT id FROM factory.knowledge_page WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.knowledge_page WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.knowledge_generation WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.wiki_source_update WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.environment_write WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.project_environment WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.project_image_preparation WHERE project_id=${projectID}`;
      await transaction`DELETE FROM factory.promotion_operation WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.merge_operation
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`
        DELETE FROM factory.delivery_approval
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`
        DELETE FROM factory.pull_request_operation
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`
        DELETE FROM factory.change_agent_session
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`
        DELETE FROM factory.change_commit_operation
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`
        DELETE FROM factory.verification
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.staging_preview WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.runtime_artifact_intent WHERE runtime_attempt_id IN (SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.runtime_environment_intent WHERE runtime_attempt_id IN (SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.workspace_source WHERE workspace_id IN (SELECT id FROM factory.development_workspace WHERE project_id = ${projectID})`;
      await transaction`DELETE FROM factory.development_workspace WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.branch_create_operation
        WHERE change_id IN (SELECT id FROM factory.change WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.change WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.requirement_approval
        WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.ticket_follow_up WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})`;
      await transaction`DELETE FROM factory.ticket_document_revision WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})`;
      await transaction`
        DELETE FROM factory.requirement_revision
        WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.ticket_dependency WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.requirements_entry_intent WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})`;
      await transaction`DELETE FROM factory.ticket WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.epic WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.personal_model_settings WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.project_model_settings WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.personal_skill_settings WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.project_skill_settings WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.project_membership WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.project WHERE id = ${projectID}`;
    });
  } finally {
    if (!ownedDatabase) await database.client.end({ timeout: 3 });
  }
}

export async function teardownFactoryProject(
  request: APIRequestContext,
  projectID: string | null | undefined,
) {
  if (!projectID) return;
  await stopProjectRuntimes(request, projectID);
  await deleteFactoryProject(projectID);
}
