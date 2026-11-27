import { expect } from "bun:test";
import { createHash } from "node:crypto";
import type { createDatabase, DatabaseTransaction } from "#db/client";
import { canonicalRequirementContent } from "#requirement-domain/requirement";
import { runtimeIdentity } from "#runtime-domain/identity";
import { ticketWorkspaceIdentity } from "#workspace-domain/workspace";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import upstream from "../../upstream.json";
import { factoryProcess } from "./factory-process";
import { fixtureValue } from "./value";

const { FACTORY_AGENT_MODEL_ID } = process.env;
export const buildModelID = FACTORY_AGENT_MODEL_ID ?? "factory-coding-model";

// Owned transport fixtures opt out of starter defaults through canonical Project choices.
export async function disableStarterSkillsIn(
  sql: DatabaseTransaction,
  userID: string,
  projectID: string,
  database: ReturnType<typeof createDatabase>,
) {
  const skills = createSkillController(database);
  const view = await skills.getLibraryIn(sql, userID, projectID);
  for (const choice of view.choices.filter(
    (item) => item.scope === "system" && item.state === "enable",
  ))
    await sql`INSERT INTO factory.operation(
        id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'skills.choice','project',${projectID},
        ${`skills.choice:${choice.libraryId}:project:${projectID}:00000000-0000-0000-0000-000000000000:${choice.role}`},
        'disable',
        ${JSON.stringify({ libraryId: choice.libraryId, scope: "project", contextId: projectID, userId: "00000000-0000-0000-0000-000000000000", role: choice.role, state: "disable", revisionId: choice.revisionId, version: 1 })}::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING`;
}

// Actual controller, published OpenCode client and PostgreSQL. External acceptance is injected.
export async function fixture(
  canonical = canonicalRequirementContent({
    summary: "Owned Build regression",
    acceptanceCriteria: ["A bounded local check passes"],
    nonGoals: [],
  }),
  baseSHA = "a".repeat(40),
  externalDatabase?: ReturnType<typeof createDatabase>,
  connector?: string | { runtime: "deferred-native" },
  approvalSetup?: (
    sql: DatabaseTransaction,
    context: { userID: string; projectID: string; ticketID: string },
  ) => Promise<{ incidentID: string; policyID: string }>,
  environmentSetup?: (
    sql: DatabaseTransaction,
    context: { userID: string; projectID: string },
  ) => Promise<void>,
) {
  const host = externalDatabase ? undefined : await factoryProcess();
  const database = externalDatabase ?? fixtureValue(host, "host").connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const changeID = crypto.randomUUID();
  const workspaceID = ticketWorkspaceIdentity(changeID).workspaceID;
  const attemptID = runtimeIdentity(workspaceID, 1).attemptID;
  const suffix = projectID.replaceAll("-", "").slice(0, 12);
  const deferredRuntime = typeof connector === "object";
  const sessionID = deferredRuntime
    ? `ses_factory_${changeID.replaceAll("-", "")}`
    : `ses_owned_${suffix}`;
  const connectorHash =
    typeof connector === "string"
      ? createHash("sha256").update(connector).digest("hex")
      : undefined;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    FACTORY_FORGEJO_API_URL: "https://owned-build.factory.invalid/api/v1/",
    FACTORY_FORGEJO_PUBLIC_URL: "https://owned-build.factory.invalid",
  })) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  function restoreEnvironment() {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await database.client
    .begin(async (sql) => {
      if (host) {
        await sql`INSERT INTO auth."user"(id, name, email, email_verified) VALUES (${host.id}, 'Owned fixture administrator', ${`fixture-admin-${host.id}@factory.local`}, true)`;
        await sql`INSERT INTO factory.administrator(user_id) VALUES (${host.id})`;
      }
      await sql`INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${userID}, 'Owned Build Admission', ${`build-turn-${suffix}@factory.local`}, true)`;
      await sql`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, actor_template_path, created_by)
      VALUES (${projectID}, ${`build-turn-${suffix}`}, 'Owned Build Admission',
        'https://owned-build.factory.invalid/owned/owned-build.git', 'main', '.factory/actor-template.json', ${userID})`;
      await sql`INSERT INTO factory.project_membership(project_id, user_id, role, updated_by)
        VALUES (${projectID}, ${userID}, 'developer', ${userID})`;
      if (host) await disableStarterSkillsIn(sql, userID, projectID, database);
      await sql`INSERT INTO factory.ticket(id, project_id, title, created_by)
      VALUES (${ticketID}, ${projectID}, 'Owned Build regression', ${userID})`;
      await sql`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${revisionID}, ${ticketID}, 1, ${canonical}, ${createHash("sha256").update(canonical).digest("hex")}, ${userID})`;
      const basis = await approvalSetup?.(sql, { userID, projectID, ticketID });
      await environmentSetup?.(sql, { userID, projectID });
      await sql`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by,
        monitoring_incident_id,monitoring_policy_id)
      VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID},${basis?.incidentID ?? null},${basis?.policyID ?? null})`;
      await sql`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
        VALUES (${changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${`factory/change-${suffix}`}, ${baseSHA}, 'active', ${userID})`;
      await sql`INSERT INTO factory.development_workspace(id, project_id, kind, ticket_id, change_id,
      source_branch, source_revision, created_by)
      VALUES (${workspaceID}, ${projectID}, 'ticket', ${ticketID}, ${changeID}, ${`factory/change-${suffix}`},
        ${baseSHA}, ${userID})`;
      if (deferredRuntime) {
        await sql`INSERT INTO factory.operation(
          id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,result,created_by,completed_at)
          VALUES(${crypto.randomUUID()},'delivery.branch_create','change',${changeID},
            ${`delivery.branch_create:change:${changeID}:create-branch`},NULL,'succeeded',
            ${JSON.stringify({
              changeId: changeID,
              repositoryOwner: "owned",
              repositoryName: "owned-build",
              branchName: `factory/change-${suffix}`,
              startSha: baseSHA,
              attemptCount: 1,
              leaseGeneration: 1,
              reconcileAfter: null,
            })}::jsonb,
            ${JSON.stringify({ observedHeadSha: baseSHA })}::jsonb,${userID},now())`;
        return;
      }
      // Controlled ready state only. No native Create has been dispatched.
      await sql`INSERT INTO factory.runtime_attempt(id, project_id, change_id, workspace_id, generation, revision, state, parent_connector_token_hash, create_intended_at, created_by, atespace, actor_name, binding_intent)
        VALUES (${attemptID}, ${projectID}, ${changeID}, ${workspaceID}, 1, ${baseSHA}, 'create-intended', ${connectorHash ?? "b".repeat(64)}, now(), ${userID}, ${`fa-${attemptID.replaceAll("-", "")}`}, ${`runtime-${attemptID.replaceAll("-", "")}`}, '{"connectorURL":"wss://owned-build.factory.invalid/internal/runtime-connect","egressHosts":[]}')`;
      await freezeRuntimeEnvironment(sql, attemptID);
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id = ${attemptID} WHERE id = ${changeID}`;
      await sql`INSERT INTO factory.change_agent_session(change_id, runtime_attempt_id, opencode_session_id, state, native_session_confirmed_at, created_by)
      VALUES (${changeID}, ${attemptID}, ${sessionID}, 'committed', now(), ${userID})`;
    })
    .catch(async (cause: unknown) => {
      try {
        await database.client.end();
        await host?.dispose();
      } finally {
        restoreEnvironment();
      }
      throw cause;
    });
  let requested = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  let payloadStart = 0;
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
  const nativeMCPServers = new Set<string>();
  const nativeSessions = new Set([sessionID]);
  const nativePermissions = new Map<
    string,
    Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
  >();
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
    if (
      ["/api/experimental/mcp/factory_browser", "/api/experimental/mcp/factory_sources"].includes(
        path,
      ) &&
      request.method === "PUT"
    ) {
      nativeMCPServers.add(path.slice(path.lastIndexOf("/") + 1));
      return new Response(null, { status: 204 });
    }
    // OpenCode's native discovery protocol, not Factory's retired UI API.
    if (path === "/api/mcp")
      return Response.json({
        data: [...nativeMCPServers].map((name) => ({
          name,
          status: { status: "connected" },
        })),
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
    if (path === "/api/info") return Response.json({ version: upstream.openCode.version });
    if (path === "/api/location")
      return Response.json({
        directory: "/workspace/project",
        project: {
          id: "owned-controlled-project",
          directory: "/workspace/project",
          canonical: "/workspace/project",
        },
      });
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
      if (request.method === "POST") {
        const body = await request.json();
        nativeSessions.add(body.id);
        if (body.permissions) nativePermissions.set(body.id, structuredClone(body.permissions));
        return Response.json({ data: body });
      }
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
      cancelledInputs.add(
        decodeURIComponent(fixtureValue(path.split("/").at(-1), 'path.split("/").at(-1)')),
      );
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/inbox")) {
      const body = (payloads.length > payloadStart ? payloads.at(-1) : undefined) as
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
    const nativeID = path.match(/^\/api\/session\/([^/]+)$/)?.[1];
    if (nativeID && nativeSessions.has(nativeID)) {
      if (request.method === "PATCH") {
        const body = await request.json();
        if (body.permissions) nativePermissions.set(nativeID, structuredClone(body.permissions));
        return new Response(null, { status: 204 });
      }
      return Response.json({
        data: {
          id: nativeID,
          ...(nativePermissions.has(nativeID)
            ? { permissions: structuredClone(nativePermissions.get(nativeID)) }
            : {}),
          location: { directory: "/workspace/project" },
          model: {
            providerID: "factory",
            id: buildModelID,
          },
        },
      });
    }
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
  // This controller fixture substitutes its external Source peer just as it
  // substitutes OpenCode. It is not a native Source fencing qualification.
  const fenceSource = async () => {};
  async function shutdown() {
    release.resolve();
    const joined = await Promise.allSettled(
      [...controllers].map((controller) => controller.shutdown()),
    );
    const failed = joined.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  const controller = (startPersisted: () => Promise<null> = async () => null) => {
    const writers = createChangeWriterController({
      database,
      agentUsername: "owned-control",
      runtime: { stop: async () => {}, get: async () => ({ state: "stopped" }) },
      stopAgent: async () => {},
      protect: async () => {},
      fenceSource,
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
    workspaceID,
    sessionID,
    controller,
    payloads,
    completionText,
    hub,
    publishActivity,
    restoreEnvironment,
    shutdown,
    // Reset only the controlled peer's transient input state between complete
    // scenarios. Product turns, Sessions, runtime identities and usage remain.
    async nextInput() {
      const active =
        await database.client`SELECT id FROM factory.agent_turn WHERE change_id=${changeID}
        AND state IN ('pending','dispatching','running','uncertain') LIMIT 1`;
      if (active.length) throw Error("Controlled peer cannot reset an unsettled input");
      requested = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();
      payloadStart = payloads.length;
      finished = false;
      loseResponse = true;
    },
    writers: createChangeWriterController({
      database,
      agentUsername: "owned-control",
      runtime: { stop: async () => {}, get: async () => ({ state: "stopped" }) },
      stopAgent: async () => {},
      protect: async () => {},
      fenceSource,
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
    get requested() {
      return requested.promise;
    },
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
        // Do not remove records while an unjoined observer may still use them.
        await shutdown();
        await database.client.begin(async (sql) => {
          // The live reconciler may still be preparing grants for this owned user.
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`forge-account:${userID}`},0))`;
          const safe = await sql<
            Array<{ id: string }>
          >`SELECT project.id FROM factory.project project
            WHERE project.id = ${projectID} AND project.created_by = ${userID} AND project.slug = ${`build-turn-${suffix}`}
              AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt attempt
                WHERE attempt.project_id=project.id
                  AND (attempt.create_attempted_at IS NOT NULL OR attempt.actor_uid IS NOT NULL))
              AND NOT EXISTS(SELECT 1 FROM factory.development_workspace workspace
                JOIN factory.substrate_provision provision ON provision.owner_id=workspace.id AND provision.kind='workspace'
                WHERE workspace.project_id=project.id AND (provision.resources#>>'{atespace,attemptedAt}' IS NOT NULL
                  OR provision.resources#>>'{policy,attemptedAt}' IS NOT NULL
                  OR provision.resources#>>'{template,attemptedAt}' IS NOT NULL)) FOR UPDATE`;
          if (!safe[0]) throw new Error("Owned non-created Build fixture cleanup refused");
          await sql`DELETE FROM factory.usage_operation WHERE project_id=${projectID} AND user_id=${userID}`;
          await sql`SET LOCAL session_replication_role = replica`;
          await sql`DELETE FROM factory.audit_event
            WHERE kind='usage.policy_command' AND scope_type='execution_policy'
              AND scope_id=${`checks-resume:${changeID}`} AND actor_id=${userID}`;
          await sql`DELETE FROM factory.operation
            WHERE (kind IN ('project.delivery_queue','project.delivery_policy','delivery.staging_preview','environments.environment') AND scope_type='project' AND scope_id=${projectID})
               OR (kind='tickets.implementation_order' AND payload->>'projectId'=${projectID})
               OR (kind='access.change_editing_request' AND scope_type='change' AND scope_id=${changeID})
               OR (kind='review.scenario' AND scope_type='candidate_review' AND scope_id IN
                    (SELECT id::text FROM factory.candidate_review WHERE change_id=${changeID}))`;
          await sql`DELETE FROM factory.audit_event
            WHERE (kind='access.change_editing_decision' AND scope_type='change' AND scope_id=${changeID})
               OR (kind='review.feedback_message' AND scope_type='review_feedback' AND scope_id IN
                    (SELECT id::text FROM factory.review_feedback WHERE change_id=${changeID}))`;
          await sql`UPDATE factory.ticket_conversation SET active_coding_context_id=NULL WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.conversation_context WHERE conversation_id IN
            (SELECT id FROM factory.ticket_conversation WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.audit_event
            WHERE (kind='monitoring.evidence' AND scope_type='incident' AND scope_id IN
              (SELECT id::text FROM factory.monitoring_incident WHERE project_id=${projectID}))
               OR (kind='monitoring.command' AND scope_type='project' AND scope_id=${projectID})`;
          await sql`DELETE FROM factory.monitoring_incident WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.monitoring_policy WHERE hook_id IN
            (SELECT id FROM factory.monitoring_hook WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.monitoring_hook WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.audit_event
            WHERE kind='review.feedback_command' AND payload->>'changeId'=${changeID}`;
          await sql`DELETE FROM factory.review_feedback WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.review_media WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.operation
            WHERE kind IN ('delivery.promotion','delivery.merge','delivery.pull_request','delivery.branch_create')
              AND scope_type='change' AND scope_id=${changeID}`;
          await sql`DELETE FROM factory.delivery_approval WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.change_agent_session WHERE change_id = ${changeID}`;
          await sql`DELETE FROM factory.candidate_review WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.substrate_provision WHERE kind='verification' AND owner_id IN
            (SELECT id FROM factory.verification WHERE change_id=${changeID})`;
          await sql`DELETE FROM factory.verification WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.audit_event
            WHERE kind='mcp.observation' AND payload->>'turnId' IN
              (SELECT id::text FROM factory.agent_turn WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.operation
            WHERE kind IN ('coding.turn_mcp','coding.turn_skill','coding.session_archive','attachment.turn_context','learning.source_artifact')
              AND scope_type='agent_turn' AND scope_id IN
                (SELECT id::text FROM factory.agent_turn WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.attachment_reference WHERE attachment_id IN
            (SELECT id FROM factory.attachment WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.attachment WHERE project_id=${projectID}`;
          await sql`DELETE FROM factory.operation
            WHERE kind='attachments.draft' AND payload->>'projectId'=${projectID}`;
          await sql`DELETE FROM factory.audit_event
            WHERE (kind='mcp.access_decision' AND (payload->>'projectId'=${projectID} OR scope_id IN
              (SELECT id::text FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID})))
               OR (kind='mcp.policy_approval' AND scope_id IN
              (SELECT id::text FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID}))`;
          await sql`DELETE FROM factory.operation
            WHERE kind IN ('mcp.secret_write','mcp.token_refresh','mcp.connect','mcp.oauth_flow')
              AND scope_type='connection' AND scope_id IN
                (SELECT id::text FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID})`;
          await sql`DELETE FROM factory.mcp_connection WHERE id IN
            (SELECT id FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID})`;
          await sql`DELETE FROM factory.mcp_revision WHERE library_id IN
            (SELECT id FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID})`;
          await sql`DELETE FROM factory.mcp_library WHERE scope='project' AND project_id=${projectID}`;
          await sql`UPDATE factory.mcp_connection SET project_grants = project_grants - ${projectID}::text WHERE project_grants ? ${projectID}::text`;
          await sql`SET LOCAL session_replication_role = origin`;
          await sql`DELETE FROM factory.agent_turn WHERE project_id = ${projectID}`;
          await sql`SET LOCAL session_replication_role = replica`;
          await sql`DELETE FROM factory.change_writer WHERE change_id=${changeID}`;
          await sql`DELETE FROM factory.change_commit_operation WHERE change_id = ${changeID}`;
          // Recovery may create another immutable attempt in this exact owned
          // Project. The guard above rejects every actually created runtime.
          await sql`DELETE FROM factory.operation
            WHERE scope_type='runtime_attempt' AND scope_id IN
              (SELECT id::text FROM factory.runtime_attempt WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.runtime_attempt WHERE project_id = ${projectID}`;
          await sql`DELETE FROM factory.operation
            WHERE kind='workspace.terminal_op' AND scope_type='operation' AND scope_id IN
              (SELECT id::text FROM factory.operation WHERE kind='workspace.command' AND scope_id=${workspaceID})`;
          await sql`DELETE FROM factory.operation
            WHERE created_by=${userID}
               OR (kind='environments.write' AND payload->>'projectID'=${projectID})
               OR (kind='forge.grant' AND (payload->>'projectId'=${projectID} OR payload->>'userId'=${userID}))
               OR (kind='forge.branch' AND payload->>'projectId'=${projectID})
               OR (kind='forge.account' AND scope_type='user' AND scope_id=${userID})
               OR (scope_type='project' AND scope_id=${projectID})
               OR (scope_type='workspace' AND scope_id=${workspaceID})`;
          await sql`DELETE FROM factory.audit_event
            WHERE actor_id=${userID}
               OR (scope_type IN ('project','learning') AND scope_id=${projectID})
               OR (scope_type='workspace' AND scope_id=${workspaceID})`;
          await sql`DELETE FROM factory.substrate_source WHERE workspace_id=${workspaceID}`;
          await sql`DELETE FROM factory.substrate_provision WHERE kind='workspace' AND owner_id=${workspaceID}`;
          await sql`DELETE FROM factory.development_workspace WHERE id = ${workspaceID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.change WHERE id = ${changeID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.requirement_approval WHERE id = ${approvalID} AND approved_by = ${userID}`;
          await sql`DELETE FROM factory.requirement_revision WHERE ticket_id = ${ticketID} AND created_by = ${userID}`;
          await sql`DELETE FROM factory.conversation_entry WHERE conversation_id IN
            (SELECT id FROM factory.ticket_conversation WHERE project_id=${projectID})`;
          await sql`DELETE FROM factory.ticket_conversation WHERE project_id = ${projectID}`;
          await sql`SET LOCAL session_replication_role = origin`;
          await sql`DELETE FROM factory.ticket WHERE id = ${ticketID} AND project_id = ${projectID}`;
          await sql`DELETE FROM factory.project WHERE id = ${projectID} AND created_by = ${userID}`;
          // Published installation guidance retains its author until the owned database
          // is disposed. Do not rewrite provenance or delete shared guidance to remove a user.
          await sql`DELETE FROM auth."user" WHERE id = ${userID} AND email = ${`build-turn-${suffix}@factory.local`}
            AND NOT EXISTS(SELECT 1 FROM factory.skill_revision WHERE created_by=${userID} OR published_updated_by=${userID})`;
        });
        if (stopFailure) throw stopFailure;
      } finally {
        try {
          await database.client.end();
          await host?.dispose();
        } finally {
          restoreEnvironment();
        }
      }
    },
  };
}
