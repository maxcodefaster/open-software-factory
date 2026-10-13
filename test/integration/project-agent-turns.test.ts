import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import type { ProjectAgentOutput } from "../../packages/conversation-domain/src/conversation";
import { factoryProcess } from "../fixtures/factory-process";

// Real controller, Mastra adapter and PostgreSQL. Only model output is injected.
// Owned Docker/database setup and teardown need their own bounded integration budget.
// Run separately: bun test --timeout 30000 test/integration/project-agent-turns.test.ts
async function fixture(output: ProjectAgentOutput, failResponse = false, maxConnections = 10) {
  const isolated = await factoryProcess();
  const database = isolated.connect(maxConnections);
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const suffix = projectID.slice(0, 8);
  const release = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const secondRequest = Promise.withResolvers<void>();
  let requests = 0;
  const requestedModels: string[] = [];
  const requestedBodies: string[] = [];
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("Not found", { status: 404 });
      }
      const rawBody = await request.text();
      requestedBodies.push(rawBody);
      const body = JSON.parse(rawBody) as { stream?: boolean; model: string };
      requests += 1;
      requestedModels.push(body.model);
      requested.resolve();
      if (requests === 2) secondRequest.resolve();
      await release.promise;
      if (failResponse)
        return Response.json(
          { error: { message: "Injected lost provider outcome" } },
          { status: 503 },
        );
      const content = JSON.stringify({ output });
      const common = {
        id: "chatcmpl-turn-regression",
        created: 1_789_423_600,
        model: "factory-turn-regression",
      };
      if (!body.stream) {
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      const chunks = [
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
        },
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const controlledEnvironment = {
    FACTORY_PLANNING_MODEL_BASE_URL: "",
    FACTORY_PLANNING_MODEL_API_KEY: "",
    FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    FACTORY_MODEL_API_KEY: "owned-test-model-not-a-credential",
    FACTORY_PROJECT_AGENT_MODEL: "factory-turn-regression",
  };
  const previousEnvironment = Object.keys(controlledEnvironment).map(
    (key) => [key, process.env[key]] as const,
  );
  for (const [key, value] of Object.entries(controlledEnvironment)) process.env[key] = value;

  async function dispose() {
    release.resolve();
    await model.stop(true);
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await database.client.begin(async (transaction) => {
        const projects = await transaction<Array<{ safe: boolean }>>`
          SELECT NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE project_id = project.id)
            AND NOT EXISTS(SELECT 1 FROM factory.change WHERE project_id = project.id)
            AND NOT EXISTS(SELECT 1 FROM factory.requirement_approval approval
              JOIN factory.ticket ticket ON ticket.id = approval.ticket_id WHERE ticket.project_id = project.id)
            AND NOT EXISTS(SELECT 1 FROM factory.ticket WHERE project_id = project.id AND created_by <> ${userID}) AS safe
          FROM factory.project project WHERE id = ${projectID} AND created_by = ${userID}
            AND slug = ${`turn-${suffix}`} FOR UPDATE
        `;
        if (!projects[0]?.safe) throw new Error("Owned runtime-free fixture cleanup refused");
        await transaction`DELETE FROM factory.ticket_conversation WHERE project_id = ${projectID}`;
        // Only this owned injected fixture's revisions are disposable. The setting is transaction-local.
        await transaction`SET LOCAL session_replication_role = replica`;
        await transaction`DELETE FROM factory.requirement_revision WHERE created_by = ${userID}
          AND ticket_id IN (SELECT id FROM factory.ticket WHERE project_id = ${projectID})`;
        await transaction`SET LOCAL session_replication_role = origin`;
        await transaction`DELETE FROM factory.ticket WHERE project_id = ${projectID} AND created_by = ${userID}`;
        await transaction`DELETE FROM factory.forge_grant_intent WHERE project_id=${projectID}`;
        await transaction`DELETE FROM factory.forge_branch_intent WHERE project_id=${projectID}`;
        await transaction`DELETE FROM factory.project WHERE id = ${projectID} AND created_by = ${userID}`;
        await transaction`DELETE FROM factory.forge_account_intent WHERE user_id=${userID}`;
        await transaction`DELETE FROM auth."user" WHERE id = ${userID} AND email = ${`turn-${suffix}@factory.local`}`;
      });
    } finally {
      await database.client.end();
      await isolated.dispose();
    }
  }

  try {
    await database.client.begin(async (transaction) => {
      await transaction`
        INSERT INTO auth."user"(id, name, email, email_verified)
        VALUES (${userID}, 'Owned Turn Regression', ${`turn-${suffix}@factory.local`}, true)
      `;
      await transaction`
        INSERT INTO factory.project(
          id, slug, name, repository_url, default_branch, devcontainer_path, created_by
        ) VALUES (
          ${projectID}, ${`turn-${suffix}`}, 'Owned Turn Regression',
          'https://example.invalid/turn-regression.git', 'main', '.devcontainer/devcontainer.json', ${userID}
        )
      `;
      await transaction`INSERT INTO factory.project_membership(project_id, user_id, role, updated_by)
        VALUES (${projectID}, ${userID}, 'developer', ${userID})`;
    });
  } catch (cause) {
    await dispose();
    throw cause;
  }

  return {
    database,
    projectID,
    userID,
    controller: () => createProjectAgentController(database, { start: async () => null }),
    requested: requested.promise,
    secondRequest: secondRequest.promise,
    release: () => release.resolve(),
    requests: () => requests,
    requestedModels,
    requestedBodies,
    async turns() {
      return database.client<
        Array<{ id: string; commandId: string; state: string; authority: unknown }>
      >`
        SELECT id, command_id AS "commandId", state, authority FROM factory.agent_turn
        WHERE project_id = ${projectID} ORDER BY created_at
      `;
    },
    async entries() {
      return database.client<Array<{ kind: string; body: string }>>`
        SELECT entry.kind, entry.body FROM factory.conversation_entry entry
        JOIN factory.ticket_conversation conversation ON conversation.id = entry.conversation_id
        WHERE conversation.project_id = ${projectID} ORDER BY entry.ordinal
      `;
    },
    dispose,
  };
}

test("Contributor citation filtering preserves the supported inline reference number", async () => {
  const output: ProjectAgentOutput = {
    kind: "answer",
    message: "The Ticket describes the intended outcome.[^2]",
    citations: [],
  };
  const owned = await fixture(output);
  const ticketID = crypto.randomUUID();
  try {
    await owned.database
      .client`INSERT INTO factory.ticket(id,project_id,title,description,created_by)
      VALUES(${ticketID},${owned.projectID},'Supported outcome','A clear outcome',${owned.userID})`;
    await owned.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    output.citations.push(
      {
        source: "code",
        id: owned.projectID,
        label: "Uninspected code",
        commitSha: "a".repeat(40),
        path: "src/private.ts",
      },
      { source: "ticket", id: ticketID, label: "Supported outcome" },
    );
    owned.release();
    const result = await owned
      .controller()
      .message(
        owned.projectID,
        ticketID,
        "Explain this Ticket's intended outcome.",
        owned.userID,
        crypto.randomUUID(),
      );
    const answer = result?.entries.findLast((entry) => entry.kind === "agent-message");
    expect(answer?.body).toContain("[^2]");
    expect(answer?.citations).toEqual([
      { source: "ticket", id: ticketID, label: "Supported outcome", reference: 2 },
    ]);
    expect(answer?.payload["visibility"]).not.toBe("developer");
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("a Ticket interview receives its admitted Ticket and immutable Spec context", async () => {
  const owned = await fixture({
    kind: "answer",
    message: "Selected Ticket understood",
    citations: [],
  });
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const canonical = JSON.stringify({
    summary: "SPEC CONTEXT ONLY FOR THIS TICKET",
    acceptanceCriteria: ["First run is clear"],
    nonGoals: [],
  });
  const controller = owned.controller();
  const commandID = crypto.randomUUID();
  let response: Promise<unknown> | undefined;
  try {
    await owned.database
      .client`INSERT INTO factory.ticket(id, project_id, title, description, created_by)
      VALUES(${ticketID}, ${owned.projectID}, 'Selected starter onboarding', 'TICKET CONTEXT ONLY FOR THIS TICKET', ${owned.userID})`;
    await owned.database
      .client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES(${revisionID}, ${ticketID}, 1, ${canonical}, ${createHash("sha256").update(canonical).digest("hex")}, ${owned.userID})`;
    await controller.setMode(owned.projectID, ticketID, "plan", owned.userID);
    response = controller.message(
      owned.projectID,
      ticketID,
      "Conduct a requirements interview",
      owned.userID,
      commandID,
      "requirements-interview",
    );
    await owned.requested;
    const request = owned.requestedBodies[0];
    expect(request).toContain(ticketID);
    expect(request).toContain(revisionID);
    expect(request).toContain("Selected starter onboarding");
    expect(request).toContain("TICKET CONTEXT ONLY FOR THIS TICKET");
    expect(request).toContain("SPEC CONTEXT ONLY FOR THIS TICKET");
    const snapshots = await owned.database.client<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM factory.conversation_entry WHERE kind='user-message'
        AND conversation_id IN (SELECT id FROM factory.ticket_conversation WHERE ticket_id=${ticketID})`;
    expect(snapshots[0]?.payload["ticketContext"]).toMatchObject({
      id: ticketID,
      revisionId: revisionID,
    });
    expect(snapshots[0]?.payload["intent"]).toBe("requirements-interview");
    await owned.database
      .client`UPDATE factory.ticket SET title='Changed after admission' WHERE id=${ticketID}`;
    owned.release();
    await response;
    await controller.message(
      owned.projectID,
      ticketID,
      "Conduct a requirements interview",
      owned.userID,
      commandID,
      "requirements-interview",
    );
    expect(owned.requests()).toBe(1);
    const frozen = await owned.database.client<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM factory.conversation_entry WHERE payload->>'commandId'=${commandID}`;
    expect(frozen[0]?.payload["ticketContext"]).toEqual(snapshots[0]?.payload["ticketContext"]);
  } finally {
    owned.release();
    await response?.catch(() => undefined);
    await owned.dispose();
  }
});

const answer = {
  kind: "answer",
  message: "This is injected output for the lifecycle regression.",
  citations: [],
} satisfies ProjectAgentOutput;

async function until(check: () => Promise<boolean>) {
  for (let observation = 0; observation < 250; observation += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Owned Project recovery assertion did not become true");
}

async function pendingProject(owned: Awaited<ReturnType<typeof fixture>>) {
  const current = await owned
    .controller()
    .setMode(owned.projectID, undefined, "investigate", owned.userID);
  if (!current) throw new Error("Owned Conversation required");
  const command = {
    kind: "project-message" as const,
    commandId: crypto.randomUUID(),
    projectId: owned.projectID,
    ticketId: null,
    conversationId: current.id,
    createdBy: owned.userID,
    text: "Recover this exact saved Project input",
  };
  return createAgentTurnStore(owned.database).admit(
    command,
    {
      mode: "investigate",
      conversationVersion: current.version,
      modelId: "factory-turn-regression",
    },
    (sql, turn) =>
      appendConversationEntry(sql, current.id, {
        kind: "user-message",
        actor: "user",
        mode: "investigate",
        body: command.text,
        payload: { commandId: command.commandId, turnId: turn.id },
        citations: [],
        inReplyToEntryId: null,
        requirementRevisionId: null,
        createdBy: owned.userID,
      }).then(() => {}),
  );
}

test("Project startup recovery dispatches saved pending input once with its admitted model", async () => {
  const owned = await fixture(answer);
  try {
    const admitted = await pendingProject(owned);
    process.env["FACTORY_PROJECT_AGENT_MODEL"] = "changed-default";
    owned.release();
    await Promise.all([owned.controller().recover(), owned.controller().recover()]);
    await until(async () => (await owned.turns())[0]?.state === "completed");
    expect(owned.requests()).toBe(1);
    expect(owned.requestedModels).toEqual(["factory-turn-regression"]);
    expect((await owned.entries()).filter((entry) => entry.kind === "user-message")).toHaveLength(
      1,
    );
    expect((await owned.entries()).filter((entry) => entry.kind === "agent-message")).toHaveLength(
      1,
    );
    expect((await owned.turns())[0]?.id).toBe(admitted.turn.id);
    await owned.controller().recover();
    expect(owned.requests()).toBe(1);
  } finally {
    owned.release();
    await owned.dispose();
  }
});

test("Project startup recovery quarantines expired dispatch without replaying inference or late output", async () => {
  const owned = await fixture(answer);
  let original: Promise<unknown> | undefined;
  try {
    original = owned
      .controller()
      .message(
        owned.projectID,
        undefined,
        "Original paid boundary",
        owned.userID,
        crypto.randomUUID(),
      );
    await owned.requested;
    await owned.database
      .client`UPDATE factory.agent_turn SET owner_expires_at = clock_timestamp() - interval '1 second'
      WHERE project_id = ${owned.projectID}`;
    await owned.controller().recover();
    await until(async () => (await owned.turns())[0]?.state === "uncertain");
    expect(owned.requests()).toBe(1);
    owned.release();
    await expect(original).rejects.toMatchObject({ code: "conflict" });
    expect((await owned.entries()).filter((entry) => entry.kind === "agent-message")).toHaveLength(
      0,
    );
    await owned.controller().recover();
    expect(owned.requests()).toBe(1);
    expect((await owned.turns())[0]?.state).toBe("uncertain");
    await owned
      .controller()
      .message(
        owned.projectID,
        undefined,
        "Explicit new attempt",
        owned.userID,
        crypto.randomUUID(),
      );
    expect(owned.requests()).toBe(2);
    expect((await owned.turns()).map((turn) => turn.state)).toEqual(["uncertain", "completed"]);
  } finally {
    owned.release();
    if (original) await Promise.allSettled([original]);
    await owned.dispose();
  }
});

test("Project startup recovery rejects pending input whose Conversation authority changed", async () => {
  const owned = await fixture(answer);
  try {
    await pendingProject(owned);
    await owned.controller().setMode(owned.projectID, undefined, "plan", owned.userID);
    await owned.controller().recover();
    await until(async () => (await owned.turns())[0]?.state === "failed");
    expect(owned.requests()).toBe(0);
    expect((await owned.entries()).filter((entry) => entry.kind === "user-message")).toHaveLength(
      1,
    );
  } finally {
    owned.release();
    await owned.dispose();
  }
});

test("Project startup recovery waits for a pending lease instead of stealing or losing input", async () => {
  const owned = await fixture(answer);
  try {
    const { turn } = await pendingProject(owned);
    const store = createAgentTurnStore(owned.database);
    const owner = await store.claimPending(turn.id, 300);
    if (!owner?.ownerToken) throw new Error("Owned pending lease required");
    owned.release();
    await owned.controller().recover();
    expect((await store.get(turn.id))?.ownerToken).toBe(owner.ownerToken);
    expect(owned.requests()).toBe(0);
    await until(async () => (await owned.turns())[0]?.state === "completed");
    expect(owned.requests()).toBe(1);
  } finally {
    owned.release();
    await owned.dispose();
  }
});

test("Project startup recovery retains pending intent beyond its first observation window", async () => {
  const owned = await fixture(answer);
  const sleep = Bun.sleep;
  const leaseBoundary = Promise.withResolvers<void>();
  let simulatedWait = 0;
  let waiting: ReturnType<typeof spyOn> | undefined;
  try {
    const { turn } = await pendingProject(owned);
    const owner = await createAgentTurnStore(owned.database).claimPending(turn.id, 60_000);
    if (!owner) throw new Error("Owned pending lease required");
    // Exercise the real SQL/claim path across a whole ownership window without
    // waiting a minute. SQL expiry remains authoritative, not the test's clock.
    waiting = spyOn(Bun, "sleep").mockImplementation(async (duration) => {
      if (typeof duration === "number" && duration >= 1_000) {
        simulatedWait += duration;
        if (simulatedWait >= 60_000) {
          await owned.database.client`UPDATE factory.agent_turn
            SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${turn.id}`;
          leaseBoundary.resolve();
        }
        await sleep(0);
      } else await sleep(duration);
    });
    owned.release();
    await owned.controller().recover();
    await leaseBoundary.promise;
    await until(async () => (await owned.turns())[0]?.state === "completed");
    expect(owned.requests()).toBe(1);
    expect((await owned.turns())[0]?.id).toBe(turn.id);
  } finally {
    waiting?.mockRestore();
    owned.release();
    await owned.dispose();
  }
});

test("Project startup recovery cannot quarantine or repeat a live provider owner", async () => {
  const owned = await fixture(answer);
  let original: Promise<unknown> | undefined;
  try {
    original = owned
      .controller()
      .message(owned.projectID, undefined, "Live owner", owned.userID, crypto.randomUUID());
    await owned.requested;
    const turn = (await owned.turns())[0];
    if (!turn) throw new Error("Owned live Turn required");
    expect(await createAgentTurnStore(owned.database).quarantineExpiredProject(turn.id)).toBe(
      false,
    );
    await owned.controller().recover();
    await Bun.sleep(30);
    expect((await owned.turns())[0]?.state).toBe("dispatching");
    expect(owned.requests()).toBe(1);
    owned.release();
    await original;
    expect((await owned.turns())[0]?.state).toBe("completed");
  } finally {
    owned.release();
    if (original) await Promise.allSettled([original]);
    await owned.dispose();
  }
});

test("Project startup recovery preserves stopped intent without dispatch", async () => {
  const owned = await fixture(answer);
  try {
    const { turn } = await pendingProject(owned);
    await owned.database.client`UPDATE factory.agent_turn SET state = 'stopped', owner_token = NULL,
      owner_expires_at = NULL, outcome_summary = 'Owned persisted Stop' WHERE id = ${turn.id}`;
    await owned.controller().recover();
    expect((await owned.turns())[0]?.state).toBe("stopped");
    expect(await createAgentTurnStore(owned.database).claimPending(turn.id)).toBeNull();
    expect(owned.requests()).toBe(0);
  } finally {
    owned.release();
    await owned.dispose();
  }
});

test("Project startup recovery records unavailable before dispatch and does not silently retry it", async () => {
  const owned = await fixture(answer);
  try {
    await pendingProject(owned);
    delete process.env["FACTORY_MODEL_API_KEY"];
    await owned.controller().recover();
    await until(async () => (await owned.turns())[0]?.state === "failed");
    expect(owned.requests()).toBe(0);
    expect((await owned.entries()).filter((entry) => entry.kind === "user-message")).toHaveLength(
      1,
    );
    process.env["FACTORY_MODEL_API_KEY"] = "owned-test-model-not-a-credential";
    await owned.controller().recover();
    expect(owned.requests()).toBe(0);
  } finally {
    owned.release();
    await owned.dispose();
  }
});

test("a rejected competing Project prompt does not append unadmitted input", async () => {
  const owned = await fixture(answer);
  const controller = owned.controller();
  const first = controller.message(
    owned.projectID,
    undefined,
    "First prompt",
    owned.userID,
    crypto.randomUUID(),
  );
  try {
    await owned.requested;
    const second = await Promise.allSettled([
      controller.message(
        owned.projectID,
        undefined,
        "Competing prompt",
        owned.userID,
        crypto.randomUUID(),
      ),
    ]);
    expect(second[0]?.status).toBe("rejected");
    owned.release();
    await first;
    const inputs = (await owned.entries()).filter((entry) => entry.kind === "user-message");
    expect(inputs.map((entry) => entry.body)).toEqual(["First prompt"]);
    expect(owned.requests()).toBe(1);
  } finally {
    owned.release();
    await Promise.allSettled([first]);
    await owned.dispose();
  }
});

test("independent controllers cannot both dispatch work for one Conversation", async () => {
  const owned = await fixture(answer);
  const first = owned
    .controller()
    .message(owned.projectID, undefined, "First owner", owned.userID, crypto.randomUUID());
  let second: Promise<unknown> | undefined;
  try {
    await owned.requested;
    second = owned
      .controller()
      .message(owned.projectID, undefined, "Second owner", owned.userID, crypto.randomUUID());
    await Promise.race([owned.secondRequest, second.catch(() => undefined)]);
    owned.release();
    const results = await Promise.allSettled([first, second]);
    expect(owned.requests()).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await owned.entries()).filter((entry) => entry.kind === "user-message")).toHaveLength(
      1,
    );
  } finally {
    owned.release();
    await Promise.allSettled(second ? [first, second] : [first]);
    await owned.dispose();
  }
});

test("a late Plan question cannot publish after switching to Investigate", async () => {
  const owned = await fixture({
    kind: "question",
    message: "One decision remains.",
    question: { type: "free-text", prompt: "What changes?", placeholder: "Describe it" },
    citations: [],
  });
  const controller = owned.controller();
  let pending: Promise<unknown> | undefined;
  try {
    await controller.setMode(owned.projectID, undefined, "plan", owned.userID);
    pending = controller.message(
      owned.projectID,
      undefined,
      "Plan this",
      owned.userID,
      crypto.randomUUID(),
    );
    await owned.requested;
    await controller.setMode(owned.projectID, undefined, "investigate", owned.userID);
    owned.release();
    await Promise.allSettled([pending]);
    expect((await owned.entries()).filter((entry) => entry.kind === "question")).toHaveLength(0);
  } finally {
    owned.release();
    if (pending) await Promise.allSettled([pending]);
    await owned.dispose();
  }
});

test("the same authenticated Project command replays before and after completion", async () => {
  const owned = await fixture(answer);
  const commandID = crypto.randomUUID();
  const first = owned
    .controller()
    .message(owned.projectID, undefined, "One command", owned.userID, commandID);
  try {
    await owned.requested;
    await owned
      .controller()
      .message(owned.projectID, undefined, "One command", owned.userID, commandID);
    owned.release();
    await first;
    process.env["FACTORY_PROJECT_AGENT_MODEL"] = "changed-default";
    await owned
      .controller()
      .message(owned.projectID, undefined, "One command", owned.userID, commandID);
    expect(owned.requests()).toBe(1);
    expect((await owned.entries()).filter((entry) => entry.kind === "user-message")).toHaveLength(
      1,
    );
    expect(await owned.turns()).toMatchObject([
      {
        commandId: commandID,
        state: "completed",
        authority: { modelId: "factory-turn-regression" },
      },
    ]);
    const usage = await owned.database.client`
      SELECT operation.purpose, operation.outcome, entry.counters, entry.source
      FROM factory.usage_operation operation
      JOIN factory.usage_entry entry ON entry.operation_id=operation.id
      WHERE operation.project_id=${owned.projectID}`;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      purpose: "research",
      outcome: "completed",
      source: "step",
      counters: { output: 1, cacheRead: null, input: null },
    });
    await expect(
      owned
        .controller()
        .message(owned.projectID, undefined, "Changed input", owned.userID, commandID),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      owned
        .controller()
        .message(crypto.randomUUID(), undefined, "One command", owned.userID, commandID),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    owned.release();
    await Promise.allSettled([first]);
    await owned.dispose();
  }
}, 30_000);

test("replay of a draft bound to a Ticket does not create another draft or Requirement", async () => {
  const owned = await fixture({
    kind: "requirement",
    message: "A bounded proposal.",
    citations: [],
    ticket: { title: "Owned admission proposal", description: "One change" },
    requirement: {
      summary: "One change",
      acceptanceCriteria: ["One recorded proposal"],
      nonGoals: [],
    },
  });
  try {
    await owned.controller().setMode(owned.projectID, undefined, "plan", owned.userID);
    const commandID = crypto.randomUUID();
    owned.release();
    const first = await owned
      .controller()
      .message(owned.projectID, undefined, "Propose this", owned.userID, commandID);
    const replay = await owned
      .controller()
      .message(owned.projectID, undefined, "Propose this", owned.userID, commandID);
    expect(replay?.id).toBe(first?.id);
    expect(replay?.ticketId).toBe(first?.ticketId);
    expect(owned.requests()).toBe(1);
    expect((await owned.entries()).filter((entry) => entry.kind === "requirement")).toHaveLength(1);
    const conversations = await owned.database.client<Array<{ id: string }>>`
      SELECT id FROM factory.ticket_conversation WHERE project_id = ${owned.projectID}
    `;
    expect(conversations).toHaveLength(1);
  } finally {
    await owned.dispose();
  }
});

test("an unavailable model retains admitted input but never dispatches", async () => {
  const owned = await fixture(answer);
  const commandID = crypto.randomUUID();
  try {
    delete process.env["FACTORY_MODEL_API_KEY"];
    await expect(
      owned
        .controller()
        .message(owned.projectID, undefined, "Saved intent", owned.userID, commandID),
    ).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect((await owned.entries()).filter((entry) => entry.kind === "user-message")).toHaveLength(
      1,
    );
    expect(await owned.turns()).toMatchObject([{ commandId: commandID, state: "failed" }]);
    await owned
      .controller()
      .message(owned.projectID, undefined, "Saved intent", owned.userID, commandID);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("an unknown provider outcome requires a new explicit command rather than replay", async () => {
  const owned = await fixture(answer, true);
  const commandID = crypto.randomUUID();
  try {
    owned.release();
    await expect(
      owned
        .controller()
        .message(owned.projectID, undefined, "One request", owned.userID, commandID),
    ).rejects.toThrow();
    expect(await owned.turns()).toMatchObject([{ commandId: commandID, state: "uncertain" }]);
    await owned
      .controller()
      .message(owned.projectID, undefined, "One request", owned.userID, commandID);
    expect(owned.requests()).toBe(1);
    await expect(
      owned
        .controller()
        .message(owned.projectID, undefined, "One request", owned.userID, crypto.randomUUID()),
    ).rejects.toThrow();
    expect(owned.requests()).toBe(2);
  } finally {
    await owned.dispose();
  }
});

test("interview answers are admitted once and invalid answers leave no turn or input", async () => {
  const owned = await fixture({
    kind: "question",
    message: "One question",
    citations: [],
    question: {
      type: "single-select",
      prompt: "Which option?",
      allowCustom: true,
      options: [
        { id: "one", label: "One", description: "" },
        { id: "two", label: "Two", description: "" },
      ],
    },
  });
  try {
    owned.release();
    await owned.controller().setMode(owned.projectID, undefined, "plan", owned.userID);
    const first = await owned
      .controller()
      .message(owned.projectID, undefined, "Plan", owned.userID, crypto.randomUUID());
    const questionID = first?.entries.find((entry) => entry.kind === "question")?.id;
    if (!questionID) throw new Error("Question required");
    await expect(
      owned
        .controller()
        .answer(
          owned.projectID,
          undefined,
          questionID,
          { selectedOptionIds: ["not-allowed"], customText: "" },
          owned.userID,
          crypto.randomUUID(),
        ),
    ).rejects.toThrow("unknown option");
    expect(await owned.turns()).toHaveLength(1);
    expect((await owned.entries()).filter((entry) => entry.kind === "answer")).toHaveLength(0);
    const commandID = crypto.randomUUID();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        owned
          .controller()
          .answer(
            owned.projectID,
            undefined,
            questionID,
            { selectedOptionIds: ["one"], customText: "" },
            owned.userID,
            commandID,
          ),
      ),
    );
    expect(owned.requests()).toBe(2);
    expect((await owned.entries()).filter((entry) => entry.kind === "answer")).toHaveLength(1);
    await expect(
      owned
        .controller()
        .answer(
          owned.projectID,
          undefined,
          questionID,
          { selectedOptionIds: ["one"], customText: "" },
          owned.userID,
          crypto.randomUUID(),
        ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await owned.turns()).toHaveLength(2);
  } finally {
    await owned.dispose();
  }
});

test("returning to Plan does not restore an earlier turn's authority", async () => {
  const owned = await fixture({
    kind: "question",
    message: "Late decision",
    citations: [],
    question: { type: "free-text", prompt: "Must not publish", placeholder: "Answer" },
  });
  let pending: Promise<unknown> | undefined;
  try {
    await owned.controller().setMode(owned.projectID, undefined, "plan", owned.userID);
    pending = owned
      .controller()
      .message(owned.projectID, undefined, "Plan", owned.userID, crypto.randomUUID());
    await owned.requested;
    await owned.controller().setMode(owned.projectID, undefined, "investigate", owned.userID);
    await owned.controller().setMode(owned.projectID, undefined, "plan", owned.userID);
    owned.release();
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect((await owned.entries()).filter((entry) => entry.kind === "question")).toHaveLength(0);
    expect(await owned.turns()).toMatchObject([{ state: "failed" }]);
  } finally {
    owned.release();
    if (pending) await Promise.allSettled([pending]);
    await owned.dispose();
  }
});

test("a long Project request renews ownership without holding a database connection", async () => {
  const owned = await fixture(answer, false, 1);
  let pending: Promise<unknown> | undefined;
  try {
    pending = owned
      .controller()
      .message(owned.projectID, undefined, "Long request", owned.userID, crypto.randomUUID());
    await owned.requested;
    const before = await owned.database.client<Array<{ expires: number; token: string }>>`
      SELECT (extract(epoch FROM owner_expires_at) * 1000)::float8 AS expires, owner_token AS token FROM factory.agent_turn
      WHERE project_id = ${owned.projectID}
    `;
    if (!before[0]) throw new Error("Owned turn required");
    // A real interval tick, with only the loopback model held. There is no genuine inference.
    await Bun.sleep(10_300);
    const after = await owned.database.client<Array<{ expires: number; token: string }>>`
      SELECT (extract(epoch FROM owner_expires_at) * 1000)::float8 AS expires, owner_token AS token FROM factory.agent_turn
      WHERE project_id = ${owned.projectID}
    `;
    expect(after[0]?.token).toBe(before[0].token);
    expect(after[0]?.expires).toBeGreaterThan(before[0].expires);
    owned.release();
    await pending;
    expect(await owned.turns()).toMatchObject([{ state: "completed" }]);
  } finally {
    owned.release();
    if (pending) await Promise.allSettled([pending]);
    await owned.dispose();
  }
}, 30_000);
