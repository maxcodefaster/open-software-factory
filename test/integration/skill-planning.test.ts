import { expect, test } from "bun:test";
import { z } from "zod";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createOpenCodeClient } from "../../apps/factory/src/agent/opencode-client";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import { skillRevisionInput } from "../../packages/conversation-domain/src/skills";
import { fixture as buildFixture, buildModelID } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

const administrator = "01994a7d-0000-7000-8000-000000000001";
const providerRequest = z
  .object({
    stream: z.boolean().optional(),
    model: z.string(),
    messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()),
  })
  .passthrough();

async function fixture(live = false) {
  const initial = {
    baseURL: process.env["FACTORY_MODEL_BASE_URL"],
    apiKey: process.env["FACTORY_MODEL_API_KEY"],
    modelID: live ? process.env["FACTORY_PROJECT_AGENT_MODEL"] : "controlled-skill-planning",
  };
  if (!initial.modelID || (live && (!initial.baseURL || !initial.apiKey)))
    throw new Error("Genuine Skill planning requires the configured Factory model");
  const observations: Array<{
    model: string;
    instructions: boolean;
    reference: boolean;
    replacement: boolean;
    tools: string[];
  }> = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response(null, { status: 404 });
      const raw: unknown = await request.json();
      const body = providerRequest.parse(raw);
      const messages = JSON.stringify(body.messages);
      const tools =
        z
          .object({
            tools: z
              .array(
                z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .parse(raw).tools ?? [];
      observations.push({
        model: body.model,
        instructions: messages.includes(
          requirementsInterviewSkill.instructions.replaceAll("\n", "\\n"),
        ),
        reference: messages.includes(
          requirementsInterviewSkill.references
            .map((reference) => reference.body)
            .join("\n")
            .replaceAll("\n", "\\n"),
        ),
        replacement: messages.includes("Replacement content must not reach this admitted turn"),
        tools: tools.map((tool) => tool.function.name),
      });
      if (live) {
        return fetch(`${initial.baseURL?.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${initial.apiKey}`,
          },
          body: JSON.stringify(raw),
          redirect: "error",
          signal: AbortSignal.timeout(90_000),
        });
      }
      const instructions = observations.at(-1)?.instructions;
      const reference = observations.at(-1)?.reference;
      const skillName = messages.match(/factory-[a-f0-9-]{36}/)?.[0];
      const toolCall =
        skillName && (!instructions || !reference)
          ? {
              id: `call_${instructions ? "read" : "load"}`,
              type: "function",
              function: {
                name: instructions ? "skill_read" : "skill",
                arguments: JSON.stringify(
                  instructions
                    ? { skillName, path: "references/decision-checklist.md" }
                    : { name: skillName },
                ),
              },
            }
          : undefined;
      const content = JSON.stringify({
        output: {
          kind: "answer",
          message: "A decision checklist was loaded for planning.",
          citations: [],
        },
      });
      const common = { id: "chatcmpl-approved-skill", created: 1, model: body.model };
      if (!body.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: toolCall ? null : content,
                ...(toolCall ? { tool_calls: [toolCall] } : {}),
              },
              finish_reason: toolCall ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      const chunks = [
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                ...(toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content }),
              },
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const controlled = {
    FACTORY_PLANNING_MODEL_BASE_URL: "",
    FACTORY_PLANNING_MODEL_API_KEY: "",
    FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    FACTORY_MODEL_API_KEY: "owned-skill-provider-capability",
    FACTORY_PROJECT_AGENT_MODEL: initial.modelID,
  };
  const previous = Object.keys(controlled).map((key) => [key, process.env[key]] as const);
  const processFixture = await factoryProcess(undefined, {
    FACTORY_PROJECT_AGENT_MODEL: initial.modelID,
  });
  const database = processFixture.connect();
  try {
    await processFixture.start();
    for (const [key, value] of Object.entries(controlled)) process.env[key] = value;
    const userID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${userID}, 'Owned Skill Developer', ${`skills-${userID}@factory.local`}, true)`;
    await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${projectID}, ${`skills-${projectID.slice(0, 8)}`}, 'Owned Skill Project', 'https://example.invalid/skill.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
    await database.client`INSERT INTO factory.project_membership(project_id, user_id, role, updated_by) VALUES (${projectID}, ${userID}, 'developer', ${administrator})`;
    const cookie = await processFixture.signIn();
    await database.client`INSERT INTO auth.account(id, account_id, provider_id, user_id, password)
      SELECT ${crypto.randomUUID()}, ${userID}, 'credential', ${userID}, password FROM auth.account WHERE user_id = ${administrator} AND provider_id = 'credential'`;
    const login = await fetch(`${processFixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: processFixture.base, "content-type": "application/json" },
      body: JSON.stringify({
        email: `skills-${userID}@factory.local`,
        password: "owned-process-password-not-a-secret",
      }),
    });
    if (!login.ok) throw new Error("Owned Skill Developer could not sign in");
    const developerCookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const command = (
      path: string,
      method: string,
      body?: unknown,
      actor: "system" | "developer" = "system",
    ) =>
      fetch(`${processFixture.base}${path}`, {
        method,
        headers: {
          cookie: actor === "system" ? cookie : developerCookie,
          origin: processFixture.base,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return {
      database,
      userID,
      projectID,
      observations,
      command,
      skills: createSkillController(database),
      agent: createProjectAgentController(database, { start: async () => null }),
      async dispose() {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await provider.stop(true);
        await database.client.end();
        await processFixture.dispose();
      },
    };
  } catch (cause) {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await provider.stop(true);
    await database.client.end();
    await processFixture.dispose();
    throw cause;
  }
}

test("System publication is immutable, idempotent and role-scoped; Plan really loads the admitted revision", async () => {
  const owned = await fixture();
  try {
    const id = crypto.randomUUID();
    const publication = {
      revisionId: id,
      expectedRevision: 0,
      content: requirementsInterviewSkill,
    };
    expect(
      (
        await owned.command("/api/admin/skills", "POST", {
          ...publication,
          content: { ...requirementsInterviewSkill, scripts: ["run.sh"] },
        })
      ).status,
    ).toBe(400);
    expect((await owned.command("/api/admin/skills", "POST", publication)).status).toBe(201);
    expect((await owned.command("/api/admin/skills", "POST", publication)).status).toBe(201);
    expect(
      (
        await owned.command("/api/admin/skills", "POST", {
          ...publication,
          content: { ...requirementsInterviewSkill, name: "Different input" },
        })
      ).status,
    ).toBe(409);
    const { settings } = await owned.skills.getSystem(administrator);
    await expect(
      owned.skills.publish(
        {
          ...publication,
          revisionId: crypto.randomUUID(),
          content: { ...requirementsInterviewSkill, key: "unauthorized" },
        },
        owned.userID,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      owned.skills.setSystem(
        { ...settings, build: { required: [id], optional: [], selected: [] } },
        administrator,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      owned.skills.setSystem(
        { ...settings, planning: { required: [id], optional: [], selected: [] } },
        owned.userID,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (
        await owned.command("/api/admin/skills/settings", "PUT", {
          ...settings,
          planning: { required: [id], optional: [], selected: [] },
        })
      ).status,
    ).toBe(200);
    const commandID = crypto.randomUUID();
    await owned.agent.setMode(owned.projectID, undefined, "plan", owned.userID);
    await owned.agent.message(
      owned.projectID,
      undefined,
      "Investigate which decisions remain for a product change, without drafting a requirement yet.",
      owned.userID,
      commandID,
    );
    const turn = await createAgentTurnStore(owned.database).getByCommand(commandID);
    expect(turn?.authority.skillRevisionIds).toEqual([id]);
    if (turn?.authority.mode !== "build")
      expect(turn?.authority.requiredSkillRevisionIds).toEqual([id]);
    expect(turn?.state).toBe("completed");
    const observed = (await owned.agent.get(owned.projectID, undefined, owned.userID))?.turn;
    expect(observed).toMatchObject({
      id: turn?.id,
      commandId: commandID,
      engine: "mastra",
      mode: "plan",
      modelId: "controlled-skill-planning",
      state: "completed",
      skills: [{ id, revision: 1, name: requirementsInterviewSkill.name, loaded: true }],
    });
    expect(observed).not.toHaveProperty("authority");
    expect(observed).not.toHaveProperty("ownerToken");
    expect(JSON.stringify(observed)).not.toContain(requirementsInterviewSkill.instructions);
    expect(observed?.usage).toMatchObject({
      source: "mastra-provider",
      coverage: "complete",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    const restarted = createProjectAgentController(owned.database, {
      start: async () => {
        throw new Error("Usage reads must not create a Change");
      },
    });
    expect(
      (await restarted.get(owned.projectID, undefined, owned.userID))?.turn?.usage,
    ).toMatchObject({ source: "unavailable", inputTokens: null, outputTokens: null });
    expect(owned.observations).toHaveLength(1);
    await expect(
      owned.agent.get(owned.projectID, undefined, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(owned.observations).toMatchObject([
      { instructions: true, reference: true, replacement: false },
    ]);
    expect(owned.observations[0]?.tools).toContain("skill");
    expect(owned.observations[0]?.tools).toContain("skill_read");
    const loaded = await owned.database.client<
      Array<{ revisionID: string }>
    >`SELECT revision_id AS "revisionID" FROM factory.agent_turn_skill WHERE turn_id = ${turn?.id ?? null}`;
    expect([...loaded]).toEqual([{ revisionID: id }]);
    await expect(
      Promise.resolve(
        owned.database
          .client`UPDATE factory.skill_revision SET content = '{}'::jsonb WHERE id = ${id}`,
      ),
    ).rejects.toThrow("skill_revision is immutable");
    await expect(
      Promise.resolve(
        owned.database
          .client`UPDATE factory.agent_turn_skill SET revision_id = ${crypto.randomUUID()} WHERE turn_id = ${turn?.id ?? null}`,
      ),
    ).rejects.toThrow("Loaded Skill identities are immutable");
    await expect(
      Promise.resolve(
        owned.database
          .client`UPDATE factory.agent_turn SET authority = authority || '{"skillRevisionIds":[]}'::jsonb WHERE id = ${turn?.id ?? null}`,
      ),
    ).rejects.toThrow("Agent Turn admission is immutable");
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("withdrawn content remains exact for a pending admitted Plan; fresh work blocks until restore", async () => {
  const owned = await fixture();
  try {
    const id = crypto.randomUUID();
    await owned.skills.publish(
      { revisionId: id, expectedRevision: 0, content: requirementsInterviewSkill },
      administrator,
    );
    const { settings } = await owned.skills.getSystem(administrator);
    await owned.skills.setSystem(
      { ...settings, planning: { required: [id], optional: [], selected: [] } },
      administrator,
    );
    const conversation = await owned.agent.setMode(
      owned.projectID,
      undefined,
      "plan",
      owned.userID,
    );
    if (!conversation) throw new Error("Owned planning Conversation missing");
    const turns = createAgentTurnStore(owned.database);
    const { turn } = await owned.database.client.begin(async (sql) =>
      turns.admitIn(
        sql,
        {
          kind: "project-message",
          commandId: crypto.randomUUID(),
          projectId: owned.projectID,
          createdBy: owned.userID,
          ticketId: null,
          conversationId: conversation.id,
          text: "Plan the next decision from this saved input.",
        },
        {
          mode: "plan",
          modelId: "controlled-skill-planning",
          conversationVersion: conversation.version,
          skillRevisionIds: await owned.skills.resolve("planning", sql, {
            projectID: owned.projectID,
            userID: owned.userID,
          }),
        },
        (transaction, record) =>
          appendConversationEntry(transaction, conversation.id, {
            kind: "user-message",
            actor: "user",
            mode: "plan",
            body: record.command.kind === "project-message" ? record.command.text : "",
            payload: { commandId: record.commandId, turnId: record.id },
            citations: [],
            inReplyToEntryId: null,
            requirementRevisionId: null,
            createdBy: owned.userID,
          }).then(() => {}),
      ),
    );
    const replacementID = crypto.randomUUID();
    await owned.skills.publish(
      {
        revisionId: replacementID,
        expectedRevision: 1,
        content: {
          ...requirementsInterviewSkill,
          instructions: "Replacement content must not reach this admitted turn",
        },
      },
      administrator,
    );
    await owned.skills.setPublication(id, false, administrator);
    await owned.agent.recover();
    await eventually(
      () => turns.get(turn.id),
      (record) => record?.state === "completed",
      "Admitted Plan did not load its exact withdrawn revision",
    );
    expect(owned.observations).toMatchObject([
      { instructions: false, reference: false, replacement: false },
      { instructions: true, reference: false, replacement: false },
      { instructions: true, reference: true, replacement: false },
    ]);
    const failedCommand = crypto.randomUUID();
    const retained = (await owned.agent.get(owned.projectID, undefined, owned.userID))?.turn;
    expect(retained).toMatchObject({ id: turn.id, skills: [{ id, revision: 1, loaded: true }] });
    expect(retained?.skills.some((skill) => skill.id === replacementID)).toBe(false);
    await expect(
      owned.agent.message(owned.projectID, undefined, "New work", owned.userID, failedCommand),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await turns.getByCommand(failedCommand)).toBeNull();
    const unchanged = skillRevisionInput.parse(
      (await owned.skills.getSystem(administrator)).revisions.find(
        (revision) => revision.id === id,
      ),
    );
    expect(unchanged.content.instructions).toBe(requirementsInterviewSkill.instructions);
    expect(unchanged.published).toBe(false);
    expect(
      (await owned.command(`/api/admin/skills/${id}/publication`, "PUT", { published: true }))
        .status,
    ).toBe(200);
    await owned.agent.message(
      owned.projectID,
      undefined,
      "Explicit fresh work after restore",
      owned.userID,
      crypto.randomUUID(),
    );
    expect(owned.observations).toHaveLength(4);
    await owned.database
      .client`DELETE FROM factory.ticket_conversation WHERE id = ${conversation.id}`;
    expect(
      await owned.database
        .client`SELECT turn_id FROM factory.agent_turn_skill WHERE turn_id = ${turn.id}`,
    ).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("scoped Skill commands enforce required baselines, permitted optional choices, Reset, membership and CAS", async () => {
  const owned = await fixture();
  try {
    const baseline = crypto.randomUUID();
    const optional = crypto.randomUUID();
    const spare = crypto.randomUUID();
    for (const [index, revisionId] of [baseline, optional, spare].entries()) {
      await owned.skills.publish(
        {
          revisionId,
          expectedRevision: 0,
          content: { ...requirementsInterviewSkill, key: `owned-skill-${index}` },
        },
        administrator,
      );
    }
    const { settings } = await owned.skills.getSystem(administrator);
    await owned.skills.setSystem(
      {
        ...settings,
        planning: { required: [baseline], optional: [optional, spare], selected: [optional] },
      },
      administrator,
    );
    const url = `/api/projects/${owned.projectID}/skill-settings`;
    const view = await owned.skills.getInherited(owned.projectID, owned.userID);
    expect(view.effective.planning.required).toEqual([{ revisionId: baseline, source: "system" }]);
    expect((await owned.command("/api/admin/skills", "GET", undefined, "developer")).status).toBe(
      403,
    );
    expect((await owned.command(url, "PUT", view.project, "developer")).status).toBe(403);
    expect(
      (
        await owned.command(
          `${url}/personal`,
          "PUT",
          { ...view.personal, required: [] },
          "developer",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await owned.command(
          `${url}/personal`,
          "PUT",
          { ...view.personal, planning: [baseline] },
          "developer",
        )
      ).status,
    ).toBe(409);
    const personal = { ...view.personal, planning: [spare] };
    const concurrent = await Promise.all([
      owned.command(`${url}/personal`, "PUT", personal, "developer"),
      owned.command(`${url}/personal`, "PUT", personal, "developer"),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      (await owned.skills.getInherited(owned.projectID, owned.userID)).effective.planning.selected,
    ).toEqual([spare]);
    expect(
      (await owned.skills.getInherited(owned.projectID, administrator)).effective.planning.selected,
    ).toEqual([optional]);
    await owned.database
      .client`UPDATE factory.project_membership SET manage_project = true WHERE project_id = ${owned.projectID} AND user_id = ${owned.userID}`;
    const narrowed = {
      ...view.project,
      planning: { required: [], optional: [optional], selected: null },
    };
    expect((await owned.command(url, "PUT", narrowed, "developer")).status).toBe(200);
    expect((await owned.command(url, "PUT", narrowed, "developer")).status).toBe(409);
    const afterRestriction = await owned.skills.getInherited(owned.projectID, owned.userID);
    expect(afterRestriction.effective.planning.selected).toEqual([]);
    expect(afterRestriction.effective.planning.ignoredReason).not.toBeNull();
    expect(
      (
        await owned.command(
          `${url}/personal`,
          "PUT",
          { ...afterRestriction.personal, planning: null },
          "developer",
        )
      ).status,
    ).toBe(200);
    expect(
      (await owned.skills.getInherited(owned.projectID, owned.userID)).effective.planning.selected,
    ).toEqual([optional]);
    const latest = await owned.skills.getInherited(owned.projectID, owned.userID);
    expect(
      (
        await owned.command(
          url,
          "PUT",
          { ...latest.project, planning: { required: [baseline], optional: null, selected: null } },
          "developer",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await owned.command(
          url,
          "PUT",
          {
            ...latest.project,
            planning: { required: [optional], optional: [spare], selected: [spare] },
          },
          "developer",
        )
      ).status,
    ).toBe(200);
    const promoted = await owned.skills.getInherited(owned.projectID, owned.userID);
    expect(promoted.effective.planning.required).toEqual([
      { revisionId: baseline, source: "system" },
      { revisionId: optional, source: "project" },
    ]);
    expect(
      (
        await owned.command(
          `${url}/personal`,
          "PUT",
          { ...promoted.personal, planning: [] },
          "developer",
        )
      ).status,
    ).toBe(200);
    expect(
      (await owned.skills.getInherited(owned.projectID, owned.userID)).effective.planning.required,
    ).toHaveLength(2);
    await owned.skills.setPublication(spare, false, administrator);
    const withdrawn = await owned.skills.getInherited(owned.projectID, owned.userID);
    expect(
      (
        await owned.command(
          `${url}/personal`,
          "PUT",
          { ...withdrawn.personal, planning: [spare] },
          "developer",
        )
      ).status,
    ).toBe(409);
    const otherProject = crypto.randomUUID();
    await owned.database
      .client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
      VALUES (${otherProject}, ${`other-${otherProject.slice(0, 8)}`}, 'Other Project', 'https://example.invalid/other.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
    expect(
      (
        await owned.command(
          `/api/projects/${otherProject}/skill-settings`,
          "GET",
          undefined,
          "developer",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await owned.command(
          `/api/projects/${otherProject}/skill-settings`,
          "PUT",
          view.project,
          "developer",
        )
      ).status,
    ).toBe(404);
    await owned.database
      .client`DELETE FROM factory.project_membership WHERE project_id = ${owned.projectID} AND user_id = ${owned.userID}`;
    expect((await owned.command(url, "GET", undefined, "developer")).status).toBe(404);
    expect(
      (await owned.command(`${url}/personal`, "PUT", withdrawn.personal, "developer")).status,
    ).toBe(404);
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("Build installs exact native packages, records actual loading and keeps them across viewers and withdrawal", async () => {
  const processFixture = await factoryProcess();
  let owned: Awaited<ReturnType<typeof buildFixture>> | undefined;
  try {
    await processFixture.start();
    owned = await buildFixture(undefined, undefined, processFixture.connect());
    const skills = createSkillController(owned.database);
    const revisionID = crypto.randomUUID();
    const content = {
      ...requirementsInterviewSkill,
      key: "owned-build-discipline",
      roles: ["build" as const],
      instructions:
        "Stay within the approved Requirement and run its existing local checks. Owned exact Build instruction.",
      references: [
        {
          path: "references/checks.md",
          body: "Owned exact Build reference: report checks honestly and never replace human approval.",
        },
      ],
    };
    await skills.publish({ revisionId: revisionID, expectedRevision: 0, content }, administrator);
    const { settings } = await skills.getSystem(administrator);
    await skills.setSystem(
      { ...settings, build: { required: [revisionID], optional: [], selected: [] } },
      administrator,
    );
    const commandID = crypto.randomUUID();
    const controller = owned.controller();
    await controller.prompt(
      owned.changeID,
      "Implement within the exact scope",
      owned.userID,
      commandID,
    );
    await owned.requested;
    const turns = createAgentTurnStore(owned.database);
    const turn = await turns.getByCommand(commandID);
    expect(turn?.authority.skillRevisionIds).toEqual([revisionID]);
    expect(turn?.authority.requiredSkillRevisionIds).toEqual([revisionID]);
    const payload = z
      .object({ text: z.string(), skills: z.array(z.object({ id: z.string() })).optional() })
      .parse(owned.payloads[0]);
    expect(payload.skills).toEqual([{ id: `factory-${revisionID}` }]);
    expect(payload.text).not.toContain(content.instructions);
    expect(payload.text).not.toContain(content.references[0]?.body ?? "missing reference");
    expect(payload.text).toContain(revisionID);
    const firstIntent = await createChangeAdmission(owned.database, buildModelID).intent(
      turn?.id ?? "missing",
    );
    expect(JSON.stringify(firstIntent.skillManifest)).not.toContain(content.instructions);
    expect(
      Buffer.from(firstIntent.skillManifest?.files[0]?.body ?? "", "base64").toString(),
    ).toContain(content.instructions);
    const { hub, attemptID } = owned;
    const native = createOpenCodeClient((request, path) =>
      hub.request(attemptID, "agent", request, path),
    );
    expect(await native.session.instructions.entry.list({ sessionID: owned.sessionID })).toEqual([
      {
        key: `factory-skill-factory-${revisionID}`,
        value: Buffer.from(firstIntent.skillManifest?.files[0]?.body ?? "", "base64").toString(),
      },
    ]);
    await skills.publish(
      {
        revisionId: crypto.randomUUID(),
        expectedRevision: 1,
        content: { ...content, instructions: "Replacement must not reach shared work" },
      },
      administrator,
    );
    await skills.setPublication(revisionID, false, administrator);
    owned.finish();
    owned.release();
    await eventually(
      () => controller.get(owned!.changeID),
      (view) => view.state === "committed" && view.turn?.state === "completed",
      "Owned Build did not commit with its admitted Skills",
    );
    const observed = (await controller.get(owned.changeID)).turn;
    expect(observed).toMatchObject({
      id: turn?.id,
      engine: "opencode",
      mode: "build",
      modelId: turn?.authority.modelId,
      skills: [{ id: revisionID, revision: 1, name: content.name, loaded: true }],
    });
    expect((await owned.controller().get(owned.changeID)).turn).toEqual(observed);
    expect((await controller.get(owned.changeID, crypto.randomUUID())).turn).toBeUndefined();
    const loaded = await owned.database.client<
      Array<{ revisionID: string }>
    >`SELECT revision_id AS "revisionID" FROM factory.agent_turn_skill WHERE turn_id = ${turn?.id ?? null}`;
    expect([...loaded]).toEqual([{ revisionID }]);
    expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
    const modelID = turn?.authority.modelId;
    if (!modelID) throw new Error("Owned Build model missing");
    const admission = createChangeAdmission(owned.database, modelID);
    const next = await admission.admit(owned.changeID, administrator, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Continue the shared Change",
    });
    expect(next.turn.authority.skillRevisionIds).toEqual([revisionID]);
    expect(next.turn.authority.requiredSkillRevisionIds).toEqual([revisionID]);
    expect((await admission.intent(next.turn.id)).skillManifest).toEqual(firstIntent.skillManifest);
    expect((await admission.intent(next.turn.id)).skills).toEqual(firstIntent.skills);
    expect((await admission.intent(next.turn.id)).text).not.toContain(
      "Replacement must not reach shared work",
    );
    const owner = await turns.claimPending(next.turn.id);
    if (!owner?.ownerToken) throw new Error("Owned next turn missing");
    await turns.failPending(owner.id, owner.ownerToken, "Owned frozen Skill assertion");
    const projectID = owned.projectID;
    const userID = owned.userID;
    await expect(
      owned.database.client.begin((sql) => skills.resolve("build", sql, { projectID, userID })),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    try {
      if (owned) await owned.dispose();
    } finally {
      await processFixture.dispose();
    }
  }
}, 30_000);

test.skipIf(process.env["FACTORY_LIVE_SKILL_PLAN"] !== "1")(
  "genuine configured Mastra model receives the approved planning Skill and records its actual loaded identity",
  async () => {
    const owned = await fixture(true);
    try {
      const revisionID = crypto.randomUUID();
      await owned.skills.publish(
        { revisionId: revisionID, expectedRevision: 0, content: requirementsInterviewSkill },
        administrator,
      );
      const { settings } = await owned.skills.getSystem(administrator);
      await owned.skills.setSystem(
        { ...settings, planning: { required: [revisionID], optional: [], selected: [] } },
        administrator,
      );
      await owned.agent.setMode(owned.projectID, undefined, "plan", owned.userID);
      const commandID = crypto.randomUUID();
      const response = await owned.agent.message(
        owned.projectID,
        undefined,
        "We want an Inbox for Factory notifications. Explain which real human decisions remain before proposing requirements. Do not invent Project facts. Answer with a short assessment, not a Requirement yet.",
        owned.userID,
        commandID,
      );
      expect(response?.entries.some((entry) => entry.actor === "project-agent")).toBe(true);
      expect(owned.observations.length).toBeGreaterThan(0);
      expect(
        owned.observations.every(
          (observation) =>
            observation.instructions && observation.reference && !observation.replacement,
        ),
      ).toBe(true);
      const turn = await createAgentTurnStore(owned.database).getByCommand(commandID);
      expect(turn?.state).toBe("completed");
      expect(turn?.authority.skillRevisionIds).toEqual([revisionID]);
      expect(response?.turn?.usage.source).toBe("mastra-provider");
      expect(response?.turn?.usage.inputTokens).toBeGreaterThan(0);
      expect(response?.turn?.usage.outputTokens).toBeGreaterThan(0);
      const loaded = await owned.database.client<
        Array<{ revisionID: string }>
      >`SELECT revision_id AS "revisionID" FROM factory.agent_turn_skill WHERE turn_id = ${turn?.id ?? null}`;
      expect([...loaded]).toEqual([{ revisionID }]);
      console.log(
        `Genuine Plan loaded approved Skill ${revisionID} with ${turn?.authority.modelId}; isolated database cleanup follows.`,
      );
    } finally {
      await owned.dispose();
    }
  },
  120_000,
);
