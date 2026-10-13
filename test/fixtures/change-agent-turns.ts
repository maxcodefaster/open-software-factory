import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import type { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { factoryProcess } from "./factory-process";

const { FACTORY_AGENT_MODEL_ID } = process.env;
export const buildModelID = FACTORY_AGENT_MODEL_ID ?? "factory-coding-model";

// Actual controller, published OpenCode client and PostgreSQL. External acceptance is injected.
export async function fixture(
  canonical = canonicalRequirementContent({
    summary: "Owned Build regression",
    acceptanceCriteria: ["A bounded local check passes"],
    nonGoals: [],
  }),
  baseSHA = "a".repeat(40),
  externalDatabase?: ReturnType<typeof createDatabase>,
  connectorToken?: string,
) {
  const host = externalDatabase ? undefined : await factoryProcess();
  const database = externalDatabase ?? host!.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const changeID = crypto.randomUUID();
  const attemptID = crypto.randomUUID();
  const workspaceID = crypto.randomUUID();
  const suffix = projectID.replaceAll("-", "").slice(0, 12);
  const connectorHash = connectorToken
    ? createHash("sha256").update(connectorToken).digest("hex")
    : undefined;
  await database.client
    .begin(async (sql) => {
      if (host) {
        await sql`INSERT INTO auth."user"(id, name, email, email_verified) VALUES (${host.id}, 'Owned fixture administrator', ${`fixture-admin-${host.id}@factory.local`}, true)`;
        await sql`INSERT INTO factory.administrator(user_id) VALUES (${host.id})`;
        const empty = JSON.stringify({ required: [], optional: [], selected: [] });
        await sql`INSERT INTO factory.system_skill_settings(singleton, version, planning, build, updated_by) VALUES (true, 1, ${empty}::jsonb, ${empty}::jsonb, ${host.id})`;
      }
      await sql`INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${userID}, 'Owned Build Admission', ${`build-turn-${suffix}@factory.local`}, true)`;
      await sql`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`build-turn-${suffix}`}, 'Owned Build Admission',
        'https://example.invalid/owned-build.git', 'main', '.devcontainer/devcontainer.json', ${userID})`;
      await sql`INSERT INTO factory.project_membership(project_id, user_id, role, updated_by)
        VALUES (${projectID}, ${userID}, 'developer', ${userID})`;
      await sql`INSERT INTO factory.ticket(id, project_id, title, created_by)
      VALUES (${ticketID}, ${projectID}, 'Owned Build regression', ${userID})`;
      await sql`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${revisionID}, ${ticketID}, 1, ${canonical}, ${createHash("sha256").update(canonical).digest("hex")}, ${userID})`;
      await sql`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by)
      VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID})`;
      await sql`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
        VALUES (${changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${`factory/change-${suffix}`}, ${baseSHA}, 'active', ${userID})`;
      await sql`INSERT INTO factory.development_workspace(id, project_id, kind, ticket_id, change_id,
      source_branch, source_revision, kubernetes_namespace, volume_name, created_by)
      VALUES (${workspaceID}, ${projectID}, 'ticket', ${ticketID}, ${changeID}, ${`factory/change-${suffix}`},
        ${baseSHA}, ${`factory-workspace-${suffix}`}, 'never-created', ${userID})`;
      await sql`INSERT INTO factory.runtime_attempt(id, project_id, change_id, workspace_id, generation, revision, state,
      kubernetes_namespace, kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
        VALUES (${attemptID}, ${projectID}, ${changeID}, ${workspaceID}, 1, ${baseSHA}, 'ready',
        ${`owned-build-${suffix}`}, 'never-created', ${connectorHash ?? "b".repeat(64)}, ${connectorHash ?? "c".repeat(64)}, now(), ${userID})`;
      await sql`UPDATE factory.change SET runtime_attempt_id = ${attemptID} WHERE id = ${changeID}`;
      await sql`INSERT INTO factory.change_agent_session(change_id, runtime_attempt_id, opencode_session_id, state, created_by)
      VALUES (${changeID}, ${attemptID}, ${`ses_owned_${suffix}`}, 'committed', ${userID})`;
    })
    .catch(async (cause: unknown) => {
      await database.client.end();
      await host?.dispose();
      throw cause;
    });
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let acceptedPrompts = 0;
  let loseResponse = true;
  let statusReads = 0;
  let finished = false;
  let interruptRequests = 0;
  const commitCalls: string[] = [];
  const payloads: unknown[] = [];
  const cancelledInputs = new Set<string>();
  let installedSkills: string[] = [];
  const hub = new RuntimeHub(async () => {});
  hub.connected = () => true;
  hub.request = async (_attempt, _channel, request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/info") return Response.json({ data: { version: "2.0.27" } });
    if (path === "/api/skill")
      return Response.json({
        data: installedSkills.map((id) => ({
          id,
          name: id,
          path: `/opt/factory/admitted-skills/${id}/SKILL.md`,
          content: "",
        })),
      });
    if (path === "/api/shell") return Response.json({ data: [] });
    if (path.endsWith("/log"))
      return new Response(
        `data: ${JSON.stringify({ type: "log.synced", aggregateID: `ses_owned_${suffix}`, seq: 1 })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    if (path === "/api/session") return Response.json({ data: [], cursor: {} });
    if (path.endsWith("/interrupt")) {
      interruptRequests += 1;
      return Response.json({ interrupted: true });
    }
    if (path.endsWith("/agent")) return new Response(null, { status: 204 });
    if (path.endsWith("/prompt")) {
      acceptedPrompts += 1;
      const body = (await request.json()) as {
        id: string;
        text: string;
        skills?: { id: string }[];
        metadata?: Record<string, unknown>;
      };
      payloads.push(body);
      requested.resolve();
      await release.promise;
      if (loseResponse) throw new Error("Injected response loss after acceptance");
      return Response.json({
        data: {
          id: body.id,
          sessionID: `ses_owned_${suffix}`,
          type: "user",
          time: { created: 1 },
          delivery: "queue",
          payload: {
            text: body.text,
            ...(body.skills ? { skills: body.skills } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        },
      });
    }
    if (request.method === "DELETE" && path.includes("/inbox/")) {
      cancelledInputs.add(decodeURIComponent(path.split("/").at(-1)!));
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/inbox")) {
      const body = payloads.at(-1) as
        | { id: string; text: string; skills?: { id: string }[] }
        | undefined;
      return Response.json({
        data:
          !finished && body && !cancelledInputs.has(body.id)
            ? [
                {
                  id: body.id,
                  sessionID: `ses_owned_${suffix}`,
                  type: "user",
                  time: { created: 1 },
                  delivery: "queue",
                  payload: { text: body.text, ...(body.skills ? { skills: body.skills } : {}) },
                },
              ]
            : [],
      });
    }
    if (path === "/api/model")
      return Response.json({
        data: [
          {
            providerID: "factory",
            id: buildModelID,
          },
        ],
      });
    if (path.endsWith(`/ses_owned_${suffix}`))
      return Response.json({
        data: {
          id: `ses_owned_${suffix}`,
          location: { directory: "/workspace/project" },
          model: {
            providerID: "factory",
            id: buildModelID,
          },
        },
      });
    if (path.endsWith("/active")) {
      statusReads += 1;
      return Response.json({ data: {} });
    }
    if (path.endsWith("/message") && finished) {
      const prompt = payloads[0] as { id: string; text: string } | undefined;
      return Response.json({
        data: [
          {
            id: `${prompt?.id}_assistant`,
            type: "assistant",
            time: { created: 2, completed: 3 },
            finish: "stop",
            content: installedSkills.map((id) => ({
              type: "tool",
              id: `load_${id}`,
              name: "skill",
              state: {
                status: "completed",
                input: { id },
                content: [{ type: "text", text: "Exact skill loaded" }],
              },
              time: { created: 2, completed: 3 },
            })),
          },
          { id: prompt?.id, type: "user", time: { created: 1 }, text: prompt?.text },
        ],
      });
    }
    if (path.endsWith("/message"))
      return Response.json({
        data: [
          {
            id: `msg_owned_boundary_${suffix}`,
            type: "agent-selected",
            agent: "build",
            time: { created: 0 },
          },
        ],
      });
    return Response.json({ data: [] });
  };
  hub.parentOperation = async (_attempt, operation, beforeSend) => {
    let sent = !beforeSend;
    await beforeSend?.(() => {
      sent = true;
    });
    if (!sent) throw new Error("Owned parent frame was not admitted");
    const { operationId: operationID, action } = operation;
    if (!operationID || !action) throw new Error("Owned commit operation identity required");
    if (action === "skills-install") {
      const manifest = JSON.parse(String(operation["data"])) as { files: { path: string }[] };
      installedSkills = [...new Set(manifest.files.map((file) => file.path.split("/")[0] ?? ""))];
      return { commitSHA: "", remoteSHA: "" };
    }
    const records = await database.client<Array<{ state: string; operationState: string }>>`
      SELECT turn.state, operation.state AS "operationState" FROM factory.agent_turn turn
        JOIN factory.change_commit_operation operation ON operation.id = turn.id
        WHERE turn.id = ${operationID}`;
    expect(records[0]?.state).toBe("completed");
    commitCalls.push(action);
    return { commitSHA: "d".repeat(40), remoteSHA: "d".repeat(40) };
  };
  const controllers = new Set<ReturnType<typeof createAgentController>>();
  const controller = (startPersisted: () => Promise<null> = async () => null) => {
    const writers = createChangeWriterController({
      database,
      agentUsername: "owned-control",
      runtime: { stop: async () => {}, get: async () => ({ state: "stopped" }) },
      stopAgent: async () => {},
      protect: async () => {},
    });
    const active = createAgentController(database, hub, { startPersisted }, undefined, writers);
    controllers.add(active);
    return active;
  };
  return {
    database,
    userID,
    projectID,
    ticketID,
    revisionID,
    changeID,
    attemptID,
    sessionID: `ses_owned_${suffix}`,
    controller,
    payloads,
    hub,
    writers: createChangeWriterController({
      database,
      agentUsername: "owned-control",
      runtime: { stop: async () => {}, get: async () => ({ state: "stopped" }) },
      stopAgent: async () => {},
      protect: async () => {},
    }),
    acceptResponse: () => {
      loseResponse = false;
    },
    statusReads: () => statusReads,
    finish: () => {
      finished = true;
      loseResponse = false;
    },
    commitCalls,
    requested: requested.promise,
    release: () => release.resolve(),
    requests: () => acceptedPrompts,
    interrupts: () => interruptRequests,
    async turn(commandID: string) {
      const rows = await database.client<
        Array<{ id: string; state: string; input: unknown; summary: string | null }>
      >`
        SELECT id, state, input, outcome_summary AS summary FROM factory.agent_turn WHERE command_id = ${commandID}`;
      return rows[0];
    },
    async dispose() {
      release.resolve();
      try {
        let stopFailure: unknown;
        try {
          await controller().stop(changeID);
        } catch (cause) {
          stopFailure = cause;
        }
        const joined = await Promise.allSettled(
          [...controllers].map((controller) => controller.shutdown()),
        );
        const failed = joined.find((result) => result.status === "rejected");
        // Do not remove records while an unjoined observer may still use them.
        if (failed?.status === "rejected") throw failed.reason;
        await database.client.begin(async (sql) => {
          // The live reconciler may still be preparing grants for this owned user.
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`forge-account:${userID}`},0))`;
          const safe = await sql<
            Array<{ id: string }>
          >`SELECT project.id FROM factory.project project
            WHERE project.id = ${projectID} AND project.created_by = ${userID} AND project.slug = ${`build-turn-${suffix}`}
              AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id = project.id
                AND (kubernetes_uid IS NOT NULL OR kubernetes_namespace_uid IS NOT NULL)) FOR UPDATE`;
          if (!safe[0]) throw new Error("Owned non-created Build fixture cleanup refused");
          await sql`DELETE FROM factory.usage_operation WHERE project_id=${projectID} AND user_id=${userID}`;
          await sql`DELETE FROM factory.change_agent_session WHERE change_id = ${changeID}`;
          await sql`DELETE FROM factory.agent_turn WHERE project_id = ${projectID}`;
          await sql`SET LOCAL session_replication_role = replica`;
          await sql`DELETE FROM factory.change_writer WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.change_commit_operation WHERE change_id = ${changeID}`;
          await sql`DELETE FROM factory.runtime_artifact_intent WHERE runtime_attempt_id=${attemptID}`;
          await sql`DELETE FROM factory.runtime_attempt WHERE id = ${attemptID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.development_workspace WHERE id = ${workspaceID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.change WHERE id = ${changeID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.requirement_approval WHERE id = ${approvalID} AND approved_by = ${userID}`;
          await sql`DELETE FROM factory.requirement_revision WHERE ticket_id = ${ticketID} AND created_by = ${userID}`;
          await sql`DELETE FROM factory.ticket_conversation WHERE project_id = ${projectID}`;
          await sql`SET LOCAL session_replication_role = origin`;
          await sql`DELETE FROM factory.ticket WHERE id = ${ticketID} AND project_id = ${projectID}`;
          // Tests may temporarily promote this owned user to System Manager,
          // which creates grants outside its fixture Project too.
          await sql`DELETE FROM factory.forge_grant_intent WHERE project_id=${projectID} OR user_id=${userID}`;
          await sql`DELETE FROM factory.forge_branch_intent WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.project WHERE id = ${projectID} AND created_by = ${userID}`;
          await sql`DELETE FROM factory.forge_account_intent WHERE user_id=${userID}`;
          await sql`DELETE FROM auth."user" WHERE id = ${userID} AND email = ${`build-turn-${suffix}@factory.local`}`;
        });
        if (stopFailure) throw stopFailure;
      } finally {
        await database.client.end();
        await host?.dispose();
      }
    },
  };
}
