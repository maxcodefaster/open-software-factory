import { expect, test } from "bun:test";
import {
  type AgentTurnRecord,
  createAgentTurnStore,
} from "../../apps/factory/src/agent/turn-store";
import { connectFactoryMCP, createFactoryTicketCommand } from "../../apps/factory/src/mcp/factory";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import { readResearch, searchResearch } from "../../apps/factory/src/project-agent/research";
import { factoryProcess } from "../fixtures/factory-process";

function toolOf(mcp: Awaited<ReturnType<typeof connectFactoryMCP>>, name: string) {
  const tool = mcp.tools.find((tool) => tool.name === name);
  if (!tool) throw new Error(`Expected MCP tool ${name}`);
  return tool;
}

async function fixture() {
  const host = await factoryProcess();
  const database = host.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
    VALUES(${userID},'MCP contributor',${`${userID}@factory.local`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${projectID},${`mcp-${projectID}`},'Factory MCP','https://example.invalid/mcp.git','main','.devcontainer/devcontainer.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
    VALUES(${projectID},${userID},'product-contributor',${userID})`;
  } catch (cause) {
    await database.client.end();
    await host.dispose();
    throw cause;
  }
  const controller = createProjectAgentController(database, { start: async () => null });
  const store = createAgentTurnStore(database);
  async function admitted(mode: "plan" | "investigate" = "plan", intent?: "project-research") {
    const conversation = await controller.setMode(projectID, undefined, mode, userID);
    if (!conversation) throw new Error("Owned conversation missing");
    const command = {
      kind: "project-message" as const,
      commandId: crypto.randomUUID(),
      projectId: projectID,
      ticketId: null,
      conversationId: conversation.id,
      createdBy: userID,
      text: "Create a ticket for keyboard navigation.",
      ...(intent ? { intent } : {}),
    };
    const { turn } = await store.admit(
      command,
      {
        mode,
        conversationVersion: conversation.version,
        modelId: "owned-factory-mcp",
      },
      async (sql, record) => {
        await appendConversationEntry(sql, conversation.id, {
          kind: "user-message",
          actor: "user",
          mode,
          body: command.text,
          payload: { commandId: command.commandId, turnId: record.id },
          citations: [],
          inReplyToEntryId: null,
          requirementRevisionId: null,
          createdBy: userID,
        });
      },
    );
    const owner = await store.claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Owned turn missing");
    await store.beginDispatch(turn.id, owner.ownerToken);
    return owner as AgentTurnRecord & { ownerToken: string };
  }
  async function connect(turn: AgentTurnRecord & { ownerToken: string }) {
    return connectFactoryMCP({
      database,
      turn,
      ownerToken: turn.ownerToken,
      signal: AbortSignal.timeout(20_000),
      authorize: async () => {
        if (!(await store.validateExecution(turn.id, turn.ownerToken))) throw new Error("Revoked");
      },
      search: ({ query, source }) => searchResearch(database, projectID, userID, query, source),
      read: ({ source, id, offset, expectedVersion }) =>
        readResearch(database, projectID, userID, source, id, offset, expectedVersion),
    });
  }
  return {
    host,
    database,
    userID,
    projectID,
    store,
    controller,
    admitted,
    connect,
    async dispose() {
      await database.client.end();
      await host.dispose();
    },
  };
}

test("actual MCP discovery and calls create one retained Ticket with atomic, idempotent receipts", async () => {
  const f = await fixture();
  let mcp: Awaited<ReturnType<typeof f.connect>> | undefined;
  try {
    const turn = await f.admitted();
    mcp = await f.connect(turn);
    expect(mcp.tools.map((tool) => tool.name)).toEqual([
      "searchProject",
      "readProject",
      "createTicket",
    ]);
    const create = toolOf(mcp, "createTicket");
    const input = {
      key: "keyboard-navigation",
      title: "Keyboard navigation",
      description: "All controls work using the keyboard.",
    };
    const [first, retry] = await Promise.all([create.run(input), create.run(input)]);
    expect(first.isError).toBe(false);
    expect(retry.isError).toBe(false);
    expect(JSON.parse(retry.content)).toEqual(JSON.parse(first.content));
    const saved = JSON.parse(first.content);
    expect(saved).toMatchObject({ projectId: f.projectID, title: input.title, state: "ready" });
    expect(
      await f.database.client`SELECT id FROM factory.ticket WHERE project_id=${f.projectID}`,
    ).toHaveLength(1);
    const entries = await f.database.client<
      { payload: { factoryAction: { result: { id: string } } } }[]
    >`
      SELECT payload FROM factory.conversation_entry WHERE payload ? 'factoryAction'`;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload.factoryAction.result.id).toBe(saved.id);
    const conflict = await create.run({ ...input, title: "Another title" });
    expect(conflict.isError).toBe(true);
    expect(conflict.content).toContain("different Ticket");
    const foreign = await create.run({ ...input, key: "foreign", projectId: crypto.randomUUID() });
    expect(foreign.isError).toBe(true);
    const read = await toolOf(mcp, "readProject").run({ source: "ticket", id: saved.id });
    expect(read.content).toContain(input.description);
    expect(await f.database.client`SELECT id FROM factory.change`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.requirement_approval`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.requirement_revision`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    await f.store.settle(
      turn.id,
      turn.ownerToken,
      "failed",
      "Owned provider failed after creation",
    );
    expect(await f.database.client`SELECT id FROM factory.ticket`).toHaveLength(1);
    expect(
      await f.database
        .client`SELECT id FROM factory.conversation_entry WHERE payload ? 'factoryAction'`,
    ).toHaveLength(1);
    await expect(create.run({ ...input, key: "after-finish" })).rejects.toThrow("Revoked");
  } finally {
    await mcp?.close();
    await f.dispose();
  }
});

test("read-only conversations do not advertise creation, and stale or revoked authority cannot write", async () => {
  const f = await fixture();
  let mcp: Awaited<ReturnType<typeof f.connect>> | undefined;
  try {
    for (const mode of ["investigate", "research"] as const) {
      const turn = await f.admitted(
        mode === "research" ? "plan" : "investigate",
        mode === "research" ? "project-research" : undefined,
      );
      mcp = await f.connect(turn);
      expect(mcp.tools.map((tool) => tool.name)).toEqual(["searchProject", "readProject"]);
      await expect(
        createFactoryTicketCommand(f.database)(
          turn.id,
          turn.ownerToken,
          { key: "forbidden", title: "No" },
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow("personal Project chat");
      await f.store.settle(turn.id, turn.ownerToken, "completed", "Owned read-only request");
      await mcp.close();
      mcp = undefined;
    }
    const turn = await f.admitted();
    mcp = await f.connect(turn);
    await f.database
      .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    const create = toolOf(mcp, "createTicket");
    await expect(create.run({ key: "revoked", title: "No" })).rejects.toThrow("Revoked");
    await expect(
      createFactoryTicketCommand(f.database)(
        turn.id,
        turn.ownerToken,
        { key: "revoked", title: "No" },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("no longer owns");
    expect(await f.database.client`SELECT id FROM factory.ticket`).toHaveLength(0);
  } finally {
    await mcp?.close();
    await f.dispose();
  }
});

test("ownership expiry while a planning write waits rolls back both Ticket and receipt", async () => {
  const f = await fixture();
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let blocker: Promise<unknown> | undefined;
  try {
    const turn = await f.admitted();
    blocker = f.database.client.begin(async (sql) => {
      await sql`SELECT id FROM factory.project WHERE id=${f.projectID} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    await f.database
      .client`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()+interval '1 second' WHERE id=${turn.id}`;
    const creating = createFactoryTicketCommand(f.database)(
      turn.id,
      turn.ownerToken,
      {
        key: "expired-while-waiting",
        title: "Must not commit",
      },
      AbortSignal.timeout(5000),
    );
    const outcome = creating.then(
      () => null,
      (error: unknown) => error,
    );
    await Bun.sleep(1100);
    release.resolve();
    await blocker;
    expect(String(await outcome)).toContain("expired before commit");
    expect(await f.database.client`SELECT id FROM factory.ticket`).toHaveLength(0);
    expect(
      await f.database
        .client`SELECT id FROM factory.conversation_entry WHERE payload ? 'factoryAction'`,
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await blocker?.catch(() => {});
    await f.dispose();
  }
});

test("the Project Chat uses MCP tools through the real Mastra loop and does not create again on command replay", async () => {
  const f = await fixture();
  let requests = 0;
  let tools: string[] = [];
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests++;
      tools = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      const creating = requests === 1;
      const message = creating
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "factory-create",
                type: "function",
                function: {
                  name: "createTicket",
                  arguments: JSON.stringify({
                    key: "keyboard-navigation",
                    title: "Keyboard navigation",
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: JSON.stringify({
              output: {
                kind: "answer",
                message: "The Ticket is saved in Requirements.",
                citations: [],
              },
            }),
          };
      return Response.json({
        id: `owned-mcp-${requests}`,
        object: "chat.completion",
        created: 1,
        model: "owned-factory-mcp",
        choices: [{ index: 0, message, finish_reason: creating ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    },
  });
  const environment = {
    FACTORY_PLANNING_MODEL_BASE_URL: "",
    FACTORY_PLANNING_MODEL_API_KEY: "",
    FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    FACTORY_MODEL_API_KEY: "owned-model",
    FACTORY_PROJECT_AGENT_MODEL: "owned-factory-mcp",
  };
  const previous = Object.keys(environment).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
  try {
    const controller = createProjectAgentController(f.database, { start: async () => null });
    await controller.setMode(f.projectID, undefined, "plan", f.userID);
    const command = crypto.randomUUID();
    const response = await controller.message(
      f.projectID,
      undefined,
      "Create a Ticket for keyboard navigation.",
      f.userID,
      command,
    );
    expect(tools).toContain("createTicket");
    expect(response?.entries.some((entry) => entry.payload["factoryAction"])).toBe(true);
    expect(response?.entries.at(-1)?.body).toBe("The Ticket is saved in Requirements.");
    expect(await f.database.client`SELECT id FROM factory.ticket`).toHaveLength(1);
    await controller.message(
      f.projectID,
      undefined,
      "Create a Ticket for keyboard navigation.",
      f.userID,
      command,
    );
    expect(requests).toBe(2);
    expect(await f.database.client`SELECT id FROM factory.ticket`).toHaveLength(1);
  } finally {
    await model.stop(true);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.dispose();
  }
});
