import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import type { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { factoryProcess } from "./factory-process";
import type { AgentTurnTransaction } from "../../apps/factory/src/agent/turn-store";

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
  approvalSetup?: (
    sql: AgentTurnTransaction,
    context: { userID: string; projectID: string; ticketID: string },
  ) => Promise<{ incidentID: string; policyID: string }>,
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
      const basis = await approvalSetup?.(sql, { userID, projectID, ticketID });
      await sql`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by,
        monitoring_incident_id,monitoring_policy_id)
      VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID},${basis?.incidentID ?? null},${basis?.policyID ?? null})`;
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
      await sql`INSERT INTO factory.change_agent_session(change_id, runtime_attempt_id, opencode_session_id, state, native_session_confirmed_at, created_by)
      VALUES (${changeID}, ${attemptID}, ${`ses_owned_${suffix}`}, 'committed', now(), ${userID})`;
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
  let completionText = [
    "```factory-build-result",
    JSON.stringify({
      status: "ready",
      summary: "Owned fixture implementation and checks completed.",
      criteria: (JSON.parse(canonical) as { acceptanceCriteria: string[] }).acceptanceCriteria.map(
        (_criterion, index) => ({
          criterion: index + 1,
          evidence: "Controlled fixture acceptance.",
        }),
      ),
      checks: [{ command: "owned-fixture-check", passed: true }],
      remaining: [],
    }),
    "```",
  ].join("\n");
  let interruptRequests = 0;
  const commitCalls: string[] = [];
  const payloads: unknown[] = [];
  const cancelledInputs = new Set<string>();
  let installedSkills: string[] = [];
  const nativeInstructions = new Map<string, unknown>();
  const hub = new RuntimeHub(async () => {});
  const activityStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const publishActivity = () => {
    const frame = new TextEncoder().encode(
      `data: ${JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: "server.connected", data: {} })}\n\n`,
    );
    for (const stream of activityStreams) stream.enqueue(frame);
  };
  hub.connected = () => true;
  hub.request = async (_attempt, _channel, request) => {
    const path = new URL(request.url).pathname;
    if (path.includes("/instructions/entries")) {
      if (request.method === "GET")
        return Response.json({
          data: [...nativeInstructions].map(([key, value]) => ({ key, value })),
        });
      const key = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      if (request.method === "PUT") {
        const body = (await request.json()) as { value: unknown };
        nativeInstructions.set(key, body.value);
      } else if (request.method === "DELETE") nativeInstructions.delete(key);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/experimental/mcp/factory_browser" && request.method === "PUT")
      return new Response(null, { status: 204 });
    if (path === "/api/mcp")
      return Response.json({
        data: [{ name: "factory_browser", status: { status: "connected" } }],
      });
    if (path === "/api/event")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            activityStreams.add(controller);
            publishActivity();
            request.signal.addEventListener(
              "abort",
              () => {
                activityStreams.delete(controller);
                controller.close();
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
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
        `data: ${JSON.stringify({ type: "log.synced", aggregateID: path.split("/").at(-2), seq: 1 })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    if (path === "/api/session") {
      if (request.method === "POST") return Response.json({ data: await request.json() });
      return Response.json({ data: [], cursor: {} });
    }
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
          sessionID: path.split("/").at(-2),
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
                  sessionID: path.split("/").at(-2),
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
    if (
      path.endsWith(`/ses_owned_${suffix}`) ||
      /^\/api\/session\/ses_factory_review_[a-f0-9]+$/.test(path)
    )
      return Response.json({
        data: {
          id: path.split("/").at(-1),
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
      const prompt = payloads.at(-1) as { id: string; text: string } | undefined;
      return Response.json({
        data: [
          {
            id: `${prompt?.id}_assistant`,
            type: "assistant",
            time: { created: 2, completed: 3 },
            finish: "stop",
            content: [
              ...installedSkills.map((id) => ({
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
              { type: "text", text: completionText },
            ],
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
    connect(max: number) {
      if (!host) throw new Error("This fixture does not own a database connection factory");
      return host.connect(max);
    },
    userID,
    projectID,
    ticketID,
    revisionID,
    changeID,
    attemptID,
    sessionID: `ses_owned_${suffix}`,
    controller,
    payloads,
    completionText,
    hub,
    publishActivity,
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
    finish: (text?: string) => {
      finished = true;
      loseResponse = false;
      if (text !== undefined) completionText = text;
      publishActivity();
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
          await sql`DELETE FROM factory.execution_policy_command
            WHERE scope=${`checks-resume:${changeID}`} AND actor_id=${userID}`;
          await sql`DELETE FROM factory.usage_operation WHERE project_id=${projectID} AND user_id=${userID}`;
          await sql`SET LOCAL session_replication_role = replica`;
          await sql`DELETE FROM factory.change_editing_request WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.change_editing_decision WHERE change_id=${changeID}`;
          await sql`UPDATE factory.ticket_conversation SET active_coding_context_id=NULL WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.conversation_context WHERE conversation_id IN
            (SELECT id FROM factory.ticket_conversation WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.monitoring_evidence WHERE incident_id IN
            (SELECT id FROM factory.monitoring_incident WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.monitoring_incident WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.monitoring_command WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.monitoring_policy WHERE hook_id IN
            (SELECT id FROM factory.monitoring_hook WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.monitoring_hook WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.review_feedback_message WHERE feedback_id IN
            (SELECT id FROM factory.review_feedback WHERE change_id=${changeID})`;
          await sql`DELETE FROM factory.review_feedback_command WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.review_feedback WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.review_media WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.review_scenario WHERE review_id IN
            (SELECT id FROM factory.candidate_review WHERE change_id=${changeID})`;
          await sql`DELETE FROM factory.promotion_operation WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.merge_operation WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.delivery_approval WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.pull_request_operation WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.change_agent_session WHERE change_id = ${changeID}`;
          await sql`DELETE FROM factory.candidate_review WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.verification WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.mcp_observation WHERE turn_id IN
            (SELECT id FROM factory.agent_turn WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.agent_turn_mcp WHERE turn_id IN
            (SELECT id FROM factory.agent_turn WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.attachment_turn_context WHERE turn_id IN
            (SELECT id FROM factory.agent_turn WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.attachment_reference WHERE attachment_id IN
            (SELECT id FROM factory.attachment WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.attachment WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.attachment_draft WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.mcp_connection WHERE id IN
            (SELECT id FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID})`;
          await sql`DELETE FROM factory.mcp_revision WHERE library_id IN
            (SELECT id FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID})`;
          await sql`DELETE FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID}`;
          await sql`DELETE FROM factory.mcp_access_decision WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.mcp_project_grant WHERE project_id=${projectID}`;
          await sql`SET LOCAL session_replication_role = origin`;
          await sql`DELETE FROM factory.agent_turn WHERE project_id = ${projectID}`;
          await sql`SET LOCAL session_replication_role = replica`;
          await sql`DELETE FROM factory.change_writer WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.change_commit_operation WHERE change_id = ${changeID}`;
          // Recovery may create another immutable attempt in this exact owned
          // Project. The guard above rejects every actually created runtime.
          await sql`DELETE FROM factory.runtime_artifact_intent WHERE runtime_attempt_id IN
            (SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
          await sql`DELETE FROM factory.development_workspace WHERE id = ${workspaceID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.change WHERE id = ${changeID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.requirement_approval WHERE id = ${approvalID} AND approved_by = ${userID}`;
          await sql`DELETE FROM factory.requirement_revision WHERE ticket_id = ${ticketID} AND created_by = ${userID}`;
          await sql`DELETE FROM factory.conversation_entry WHERE conversation_id IN
            (SELECT id FROM factory.ticket_conversation WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.ticket_conversation WHERE project_id = ${projectID}`;
          await sql`SET LOCAL session_replication_role = origin`;
          await sql`DELETE FROM factory.ticket WHERE id = ${ticketID} AND project_id = ${projectID}`;
          // Tests may temporarily promote this owned user to System Manager,
          // which creates grants outside its fixture Project too.
          await sql`DELETE FROM factory.forge_grant_intent WHERE project_id=${projectID} OR user_id=${userID}`;
          await sql`DELETE FROM factory.forge_branch_intent WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.project WHERE id = ${projectID} AND created_by = ${userID}`;
          await sql`DELETE FROM factory.forge_account_intent WHERE user_id=${userID}`;
          // Published installation guidance retains its author until the owned database
          // is disposed. Do not rewrite provenance or delete shared guidance to remove a user.
          await sql`DELETE FROM auth."user" WHERE id = ${userID} AND email = ${`build-turn-${suffix}@factory.local`}
            AND NOT EXISTS(SELECT 1 FROM factory.skill_revision WHERE created_by=${userID})
            AND NOT EXISTS(SELECT 1 FROM factory.skill_publication WHERE updated_by=${userID})
            AND NOT EXISTS(SELECT 1 FROM factory.system_skill_settings WHERE updated_by=${userID})`;
        });
        if (stopFailure) throw stopFailure;
      } finally {
        await database.client.end();
        await host?.dispose();
      }
    },
  };
}
