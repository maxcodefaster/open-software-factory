import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { createDatabase, type DatabaseTransaction } from "#db/client";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { zeroSchema } from "#zero-schema";
import { zeroServerMutators } from "#zero-schema/server";
import { runtimeAttemptSchema } from "../../apps/factory/src/runtime/contracts";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { eventually } from "../fixtures/factory-process";
import { ownedMCPAuthorization, ownedMCPAuthProvider } from "../fixtures/mcp-authorization";
import { requestFunction } from "../fixtures/server-functions";

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
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
}

async function projectAttempts(request: APIRequestContext, projectID: string) {
  const body = await serverCall(requestFunction(request, "getRuntimeAttempts", [projectID]));
  return body.attempts;
}

export async function stopProjectRuntimes(request: APIRequestContext, projectID: string) {
  const attempts = await projectAttempts(request, projectID);
  const workspaces = attempts.filter(
    (attempt) =>
      attempt.workspaceId &&
      !terminalRuntimeStates.has(attempt.state) &&
      attempt.state !== "paused",
  );
  // Ordinary Workspace halt retains its Actor and canonical Source. Use the
  // existing authenticated lifecycle command, never isolated execution's Stop.
  if (workspaces.length) {
    const base = process.env["FACTORY_BROWSER_BASE_URL"] ?? "http://127.0.0.1:3000";
    const origin = new URL(base);
    const cookie = (await request.storageState()).cookies
      .filter((entry) => {
        const domain = entry.domain.replace(/^\./, "");
        const path = "/api/auth/oauth2/authorize";
        return (
          (entry.domain.startsWith(".")
            ? origin.hostname === domain || origin.hostname.endsWith(`.${domain}`)
            : origin.hostname === domain) &&
          (!entry.secure || origin.protocol === "https:") &&
          (entry.expires < 0 || entry.expires > Date.now() / 1000) &&
          (path === entry.path ||
            path.startsWith(entry.path.endsWith("/") ? entry.path : `${entry.path}/`))
        );
      })
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    if (!cookie) throw Error("Workspace Pause requires its authenticated fixture session");
    const grant = await ownedMCPAuthorization(base, cookie);
    const client = new Client({ name: "owned-project-cleanup", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/api/mcp", base), {
          authProvider: ownedMCPAuthProvider(grant),
        }),
      );
      for (const attempt of workspaces) {
        const response = await client.callTool(
          {
            name: "pauseWorkspace",
            arguments: { workspaceID: attempt.workspaceId, requestID: crypto.randomUUID() },
          },
          { timeout: nativeLifecycleWindowMS + 30_000 },
        );
        const text = response.content.find((part) => part.type === "text");
        if (response.isError || text?.type !== "text")
          throw Error("Workspace Pause is unconfirmed; retained Actor and Source were not deleted");
        expect(runtimeAttemptSchema.parse(JSON.parse(text.text))).toMatchObject({
          id: attempt.id,
          projectId: projectID,
          workspaceId: attempt.workspaceId,
          state: "paused",
          ...(attempt.native?.actorUID ? { native: { actorUID: attempt.native.actorUID } } : {}),
        });
      }
    } finally {
      await client.close();
    }
  }
  await Promise.all(
    attempts
      .filter((attempt) => !attempt.workspaceId && !terminalRuntimeStates.has(attempt.state))
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
          observed.every(
            (attempt) =>
              terminalRuntimeStates.has(attempt.state) ||
              (attempt.workspaceId && attempt.state === "paused"),
          )
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
    let acquiringLocks = false;
    const deleteOnce = async (transaction: DatabaseTransaction) => {
      const [scope] = await transaction<{ name: string }[]>`SELECT current_database() AS name`;
      if (!scope || !/^owned_[a-f0-9]{32}$/.test(scope.name))
        throw Error(
          "UI fixture deletion requires its explicitly owned disposable database; retained data was not changed",
        );
      // Attention and autosave use opposite membership/Ticket orders. Never wait
      // while holding a partial set of their locks; roll back before trying again.
      acquiringLocks = true;
      await transaction`SELECT user_id FROM factory.project_membership WHERE project_id=${projectID}
        ORDER BY user_id FOR UPDATE NOWAIT`;
      await transaction`SELECT id FROM factory.change WHERE project_id=${projectID}
        ORDER BY id FOR UPDATE NOWAIT`;
      await transaction`SELECT id FROM factory.ticket WHERE project_id=${projectID}
        ORDER BY id FOR UPDATE NOWAIT`;
      await transaction`SELECT id FROM factory.project WHERE id=${projectID} FOR UPDATE NOWAIT`;
      await transaction`SELECT attempt.id FROM factory.runtime_attempt attempt
        WHERE attempt.project_id=${projectID} FOR UPDATE NOWAIT`;
      await transaction`SELECT provision.owner_id FROM factory.substrate_provision provision
        JOIN factory.development_workspace workspace ON workspace.id=provision.owner_id
        WHERE provision.kind='workspace' AND workspace.project_id=${projectID} FOR UPDATE OF provision NOWAIT`;
      acquiringLocks = false;
      const [external] = await transaction`
        SELECT attempt.id FROM factory.runtime_attempt attempt
          WHERE attempt.project_id=${projectID} AND (attempt.create_attempted_at IS NOT NULL OR attempt.actor_uid IS NOT NULL)
        UNION ALL
        SELECT workspace.id FROM factory.development_workspace workspace
          JOIN factory.substrate_provision provision ON provision.owner_id=workspace.id AND provision.kind='workspace'
          WHERE workspace.project_id=${projectID}
        UNION ALL
        SELECT owner.owner_id FROM factory.substrate_provision owner
          WHERE owner.kind IN ('staging','publication') AND owner.project_id=${projectID}
        UNION ALL
        SELECT owner.owner_id FROM factory.substrate_provision owner
          JOIN factory.verification verification ON verification.id=owner.owner_id
          JOIN factory.change change ON change.id=verification.change_id
          WHERE owner.kind='verification' AND change.project_id=${projectID}
        UNION ALL
        SELECT source.workspace_id FROM factory.substrate_source source
          JOIN factory.development_workspace workspace ON workspace.id=source.workspace_id
          WHERE workspace.project_id=${projectID}
        LIMIT 1`;
      if (external)
        throw Error(
          "UI fixture has native execution or retained Source; no product history or Source was deleted",
        );
      await transaction`DELETE FROM factory.usage_operation WHERE project_id=${projectID}`;
      await transaction`SET LOCAL session_replication_role = 'replica'`;
      await transaction`DELETE FROM factory.technical_design_revision WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.audit_event
        WHERE (scope_type IN ('project','learning') AND scope_id=${projectID})
           OR (kind='usage.policy_command' AND scope_type='execution_policy' AND scope_id=${projectID})
           OR (kind='projects.setup_confirmation' AND payload->>'inspectionId' IN (SELECT id::text FROM factory.operation WHERE kind='project.setup_inspection' AND scope_type='project' AND scope_id=${projectID}))
           OR (kind='review.feedback_command' AND payload->>'changeId' IN (SELECT id::text FROM factory.change WHERE project_id=${projectID}))
           OR (kind='review.feedback_message' AND scope_type='review_feedback' AND scope_id IN (SELECT id::text FROM factory.review_feedback WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})))
           OR (kind='access.change_editing_decision' AND scope_type='change' AND scope_id IN (SELECT id::text FROM factory.change WHERE project_id=${projectID}))
           OR (kind IN ('tickets.responsibility_event','tickets.follow_up') AND scope_type='ticket' AND scope_id IN (SELECT id::text FROM factory.ticket WHERE project_id=${projectID}))
           OR (scope_type='workspace' AND scope_id IN (SELECT id::text FROM factory.development_workspace WHERE project_id=${projectID}))`;
      await transaction`DELETE FROM factory.operation
        WHERE kind='workspace.terminal_op' AND scope_type='operation' AND scope_id IN (
          SELECT id::text FROM factory.operation
          WHERE kind='workspace.command' AND scope_type='workspace'
            AND scope_id IN (SELECT id::text FROM factory.development_workspace WHERE project_id=${projectID}))`;
      await transaction`DELETE FROM factory.operation
        WHERE (scope_type='project' AND scope_id=${projectID})
           OR (kind='projects.setup_draft' AND result->>'projectID'=${projectID})
           OR (kind='forge.grant' AND payload->>'projectId'=${projectID})
           OR (kind='forge.branch' AND payload->>'projectId'=${projectID})
           OR (kind='environments.write' AND payload->>'projectID'=${projectID})
           OR (kind='attachments.draft' AND payload->>'projectId'=${projectID})
           OR (kind='delivery.promotion' AND payload->>'projectId'=${projectID})
           OR (scope_type='ticket' AND scope_id IN (SELECT id::text FROM factory.ticket WHERE project_id=${projectID}))
           OR (scope_type='agent_turn' AND scope_id IN (SELECT id::text FROM factory.agent_turn WHERE project_id=${projectID}))
           OR (scope_type='change' AND scope_id IN (SELECT id::text FROM factory.change WHERE project_id=${projectID}))
           OR (scope_type='runtime_attempt' AND scope_id IN (SELECT id::text FROM factory.runtime_attempt WHERE project_id=${projectID}))
           OR (kind='runtime.browser' AND scope_type='build_browser_session' AND scope_id IN (SELECT id::text FROM factory.build_browser_session WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})))
           OR (scope_type='workspace' AND scope_id IN (SELECT id::text FROM factory.development_workspace WHERE project_id=${projectID}))`;
      await transaction`DELETE FROM factory.execution_policy WHERE scope=${projectID}`;
      await transaction`DELETE FROM factory.change_writer WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})`;
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
      await transaction`DELETE FROM factory.candidate_review WHERE change_id IN (SELECT id FROM factory.change WHERE project_id=${projectID})`;
      await transaction`DELETE FROM factory.agent_turn WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.conversation_entry
        WHERE conversation_id IN (
          SELECT id FROM factory.ticket_conversation WHERE project_id = ${projectID}
        )
      `;
      await transaction`DELETE FROM factory.ticket_conversation WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.knowledge_revision
        WHERE page_id IN (SELECT id FROM factory.knowledge_page WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.knowledge_page WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.delivery_approval
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
      await transaction`DELETE FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.substrate_provision WHERE kind='workspace' AND owner_id IN (SELECT id FROM factory.development_workspace WHERE project_id = ${projectID})`;
      await transaction`DELETE FROM factory.development_workspace WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.change WHERE project_id = ${projectID}`;
      await transaction`
        DELETE FROM factory.requirement_approval
        WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.ticket_document_revision WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})`;
      await transaction`
        DELETE FROM factory.requirement_revision
        WHERE ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})
      `;
      await transaction`DELETE FROM factory.ticket_dependency WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.ticket WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.epic WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.model_settings WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.project_membership WHERE project_id = ${projectID}`;
      await transaction`DELETE FROM factory.project WHERE id = ${projectID}`;
    };
    await eventually(
      async () => {
        acquiringLocks = false;
        try {
          await database.client.begin(deleteOnce);
          return true;
        } catch (cause) {
          if (acquiringLocks && cause instanceof Error && "code" in cause && cause.code === "55P03")
            return false;
          throw cause;
        }
      },
      Boolean,
      "Owned Project cleanup is still blocked by in-flight reads or writes",
    );
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
  if ((await projectAttempts(request, projectID)).some((attempt) => attempt.workspaceId))
    throw Error(
      "Workspace Actor and Source are retained after Pause; explicit disposable Workspace teardown is unavailable. Project was not deleted",
    );
  await deleteFactoryProject(projectID);
}
