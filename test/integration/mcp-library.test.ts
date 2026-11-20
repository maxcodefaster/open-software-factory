import { expect, test } from "bun:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import type { MCPSecret } from "../../apps/factory/src/mcp/secrets";
import type { MCPAssignment } from "../../packages/conversation-domain/src/mcp-library";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("MCP library keeps private definitions private, grants exact read tools and fences changed or revoked access", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const manager = crypto.randomUUID();
  const author = crypto.randomUUID();
  const other = crypto.randomUUID();
  const project = crypto.randomUUID();
  const foreign = crypto.randomUUID();
  const stored = new Map<string, MCPSecret>();
  let calls = 0;
  let changed = false;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "Owned MCP fixture", version: "1.0.0" });
    server.registerTool(
      "read_issue",
      {
        description: changed ? "Changed schema contract" : "Read an issue",
        inputSchema: z.object({ id: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        calls++;
        return { content: [{ type: "text", text: `Owned issue ${id}` }] };
      },
    );
    server.registerTool(
      "delete_issue",
      {
        description: "Delete an issue",
        inputSchema: z.object({ id: z.string() }),
      },
      async () => {
        throw new Error("A write tool must never run");
      },
    );
    return server;
  });
  const connections = createMCPConnections(
    database,
    {
      configured: true,
      read: async (key) => stored.get(key),
      create: async (key, value) => {
        stored.set(key, value);
      },
    },
    "owned-mcp-signing-key",
    "https://factory.example",
    async (url, init) => handler.fetch(new Request(url, init)),
  );
  const library = connections.library;
  const libraryId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  try {
    for (const id of [manager, author, other])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${id},'Owned MCP account',${`${id}@mcp.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    for (const id of [project, foreign]) {
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${id},${`mcp-${id}`},'Owned MCP Project','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${id},${author},'product-contributor',false,${manager})`;
    }
    const content = {
      name: "Owned source",
      description: "Read our issues",
      endpoint: "https://mcp.example/mcp",
      authentication: "bearer",
      provider: "custom",
      roles: ["planning", "build"],
    };
    const personal = {
      libraryId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      expectedRevision: 0,
      scope: "personal",
      content,
    };
    await library.save(personal, author);
    await library.save(personal, author);
    expect((await library.view(author, foreign)).entries).toHaveLength(1);
    expect((await library.view(other)).entries).toHaveLength(0);
    await expect(library.save({ ...personal, scope: "system" }, author)).rejects.toThrow("Manager");
    await expect(
      library.save(
        {
          ...personal,
          revisionId: crypto.randomUUID(),
          content: { ...content, endpoint: "http://unsafe.example" },
        },
        author,
      ),
    ).rejects.toThrow();
    await library.save(
      { libraryId, revisionId, expectedRevision: 0, scope: "system", content },
      manager,
    );
    const command = {
      commandId: crypto.randomUUID(),
      revisionId,
      expectedVersion: 0,
      token: "owned-secret-token",
    };
    expect(await connections.connect(libraryId, manager, command)).toEqual({
      authorizationUrl: null,
    });
    await expect(
      connections.connect(libraryId, manager, { ...command, token: "different-owned-key" }),
    ).rejects.toThrow("identity was reused");
    expect(await connections.connect(libraryId, manager, command)).toEqual({
      authorizationUrl: null,
    });
    expect(calls).toBe(0);
    const full = await database.client.begin((sql) => library.connectionIn(sql, libraryId));
    expect(full.state).toBe("review");
    const read = fixtureValue(
      full.tools.find((tool) => tool.name === "read_issue"),
      'full.tools.find((tool) => tool.name === "read_issue")',
    );
    await expect(
      library.review(libraryId, manager, full.version, [{ name: "read_issue", digest: "wrong" }]),
    ).rejects.toThrow();
    await library.review(libraryId, manager, full.version, [
      { name: read.name, digest: read.digest },
    ]);
    let assignment: MCPAssignment = {
      connectionId: libraryId,
      credentialEpoch: full.credentialEpoch,
      revisionId,
      policyVersion: full.version + 1,
      tools: [read],
      required: true,
    };
    const call = (name = "read_issue") =>
      connections.call(
        assignment,
        project,
        author,
        name,
        { id: "42" },
        async () => {},
        new AbortController().signal,
      );
    await expect(call()).rejects.toThrow("not been granted");
    await library.grant(libraryId, project, manager, true, full.version + 1);
    const conversation = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,mode,created_by) VALUES(${conversation},${project},'investigate',${author})`;
    await library.choose(
      {
        libraryId,
        revisionId,
        scope: "project",
        projectId: project,
        role: "planning",
        state: "required",
        expectedVersion: 0,
      },
      manager,
    );
    await library.choose(
      {
        libraryId,
        revisionId,
        scope: "personal",
        projectId: project,
        role: "planning",
        state: "disable",
        expectedVersion: 0,
      },
      author,
    );
    const turns = createAgentTurnStore(database);
    const admitted = await turns.admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId: project,
        ticketId: null,
        conversationId: conversation,
        createdBy: author,
        text: "Read this Project's issue",
      },
      { mode: "investigate", conversationVersion: 1, modelId: "owned-no-inference" },
    );
    const assignments = await library.assignments(admitted.turn.id);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.required).toBe(true);
    expect(assignments[0]?.tools).toEqual(assignment.tools);
    await expect(
      (async () =>
        await database.client`UPDATE factory.agent_turn_mcp SET required=false WHERE turn_id=${admitted.turn.id}`)(),
    ).rejects.toThrow();
    expect(await call()).toEqual({ content: "Owned issue 42", isError: false });
    expect(calls).toBe(1);
    const [approvals] = await database.client<
      Array<{ count: number }>
    >`SELECT count(*)::float8 AS count FROM factory.mcp_policy_approval WHERE connection_id=${libraryId}`;
    expect(approvals?.count).toBe(1);
    await expect(call("delete_issue")).rejects.toThrow("not admitted");
    expect(calls).toBe(1);
    expect(JSON.stringify(await library.view(author, project))).not.toContain("owned-secret-token");
    expect(
      (await library.view(author, foreign)).entries.find((entry) => entry.id === libraryId)
        ?.connection,
    ).toBeNull();
    const beforeAccountChange = await database.client.begin((sql) =>
      library.connectionIn(sql, libraryId),
    );
    await connections.connect(libraryId, manager, {
      commandId: crypto.randomUUID(),
      revisionId,
      expectedVersion: beforeAccountChange.version,
      token: "owned-new-account-key",
    });
    const newAccount = await database.client.begin((sql) => library.connectionIn(sql, libraryId));
    await library.review(libraryId, manager, newAccount.version, [
      { name: read.name, digest: read.digest },
    ]);
    expect(
      (await library.view(manager, project)).entries.find((entry) => entry.id === libraryId)
        ?.connection?.projectGrants,
    ).toEqual([]);
    await expect(call()).rejects.toThrow("not been granted");
    await expect(
      library.grant(libraryId, project, manager, true, beforeAccountChange.version),
    ).rejects.toThrow("current connection");
    await library.grant(libraryId, project, manager, true, newAccount.version + 1);
    await expect(call()).rejects.toThrow("changed or revoked");
    assignment = {
      ...assignment,
      credentialEpoch: newAccount.credentialEpoch,
      policyVersion: newAccount.version + 1,
    };
    changed = true;
    await expect(call()).rejects.toThrow("tool changed");
    expect(calls).toBe(1);
    changed = false;
    await library.grant(libraryId, project, manager, false, newAccount.version + 1);
    await expect(call()).rejects.toThrow("not been granted");
    const beforeReconnect = await database.client.begin((sql) =>
      library.connectionIn(sql, libraryId),
    );
    await connections.connect(libraryId, manager, {
      commandId: crypto.randomUUID(),
      revisionId,
      expectedVersion: beforeReconnect.version,
      token: "owned-reconnected-key",
    });
    const reconnected = await database.client.begin((sql) => library.connectionIn(sql, libraryId));
    await library.review(libraryId, manager, reconnected.version, [
      { name: read.name, digest: read.digest },
    ]);
    await library.grant(libraryId, project, manager, true, reconnected.version + 1);
    await expect(call()).rejects.toThrow("changed or revoked");
    await library.disconnect(libraryId, manager);
    await expect(call()).rejects.toThrow("Reconnect");
    expect(calls).toBe(1);
  } finally {
    await handler.close();
    await database.client.end();
    await fixture.dispose();
  }
});

test("completed private Project turns do not expose personal MCP definitions and shared Ticket work retains exact revisions", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const manager = crypto.randomUUID();
  const author = crypto.randomUUID();
  const reader = crypto.randomUUID();
  const project = crypto.randomUUID();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "Owned revision fixture", version: "1.0.0" });
    server.registerTool(
      "read_issue",
      { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => {
        throw new Error("Revision inspection must not invoke an MCP tool");
      },
    );
    return server;
  });
  const connections = createMCPConnections(
    database,
    {
      configured: false,
      read: async () => undefined,
      create: async () => {
        throw new Error("This public fixture does not use credentials");
      },
    },
    "owned-revision-signing-key",
    "https://factory.example",
    async (url, init) => handler.fetch(new Request(url, init)),
  );
  const library = connections.library;
  const turns = createAgentTurnStore(database);
  async function source(scope: "personal" | "project", userId: string) {
    const definition = {
      libraryId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      expectedRevision: 0,
      scope,
      ...(scope === "project" ? { projectId: project } : {}),
      content: {
        name: `Owned ${scope} revision`,
        description: `Owned ${scope} definition`,
        endpoint: `https://${scope}.example/mcp`,
        authentication: "none",
        provider: "custom",
        roles: ["planning"],
      },
    };
    await library.save(definition, userId);
    await connections.connect(definition.libraryId, userId, {
      commandId: crypto.randomUUID(),
      revisionId: definition.revisionId,
      expectedVersion: 0,
    });
    const connection = await database.client.begin((sql) =>
      library.connectionIn(sql, definition.libraryId),
    );
    const tool = fixtureValue(connection.tools[0], "owned revision fixture tool");
    await library.review(definition.libraryId, userId, connection.version, [
      { name: tool.name, digest: tool.digest },
    ]);
    await library.choose(
      {
        libraryId: definition.libraryId,
        revisionId: definition.revisionId,
        projectId: project,
        scope,
        role: "planning",
        state: "enable",
        expectedVersion: 0,
      },
      userId,
    );
    return definition;
  }
  async function completedTurn(conversationId: string, ticketId: string | null) {
    const { turn } = await turns.admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId: project,
        ticketId,
        conversationId,
        createdBy: author,
        text: "Inspect this owned source without inference",
      },
      { mode: "investigate", conversationVersion: 1, modelId: "owned-no-inference" },
    );
    const owner = await turns.claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Owned revision turn lease missing");
    expect(await turns.beginDispatch(turn.id, owner.ownerToken)).not.toBeNull();
    expect(
      await turns.settle(turn.id, owner.ownerToken, "completed", "Owned no-inference turn"),
    ).toBe(true);
    return turn.id;
  }
  try {
    for (const id of [manager, author, reader])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${id},'Owned MCP revision account',${`${id}@mcp.test`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`mcp-${project}`},'Owned MCP revision Project','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager})`;
    for (const id of [manager, author, reader])
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${project},${id},'product-contributor',${id === manager},${manager})`;
    const personal = await source("personal", author);
    const privateConversation = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,created_by)
      VALUES(${privateConversation},${project},${author})`;
    const privateTurnId = await completedTurn(privateConversation, null);
    expect([...(await library.assignments(privateTurnId))]).toMatchObject([
      { connectionId: personal.libraryId, revisionId: personal.revisionId },
    ]);
    expect([
      ...(await database.client`SELECT ticket_id,state FROM factory.agent_turn WHERE id=${privateTurnId}`),
    ]).toMatchObject([{ ticket_id: null, state: "completed" }]);
    for (const userId of [reader, manager]) {
      const view = await library.view(userId, project);
      expect(view.entries.find((entry) => entry.id === personal.libraryId)).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain(personal.revisionId);
      expect(JSON.stringify(view)).not.toContain(personal.content.endpoint);
    }
    expect(
      (await library.view(author, project)).entries
        .find((entry) => entry.id === personal.libraryId)
        ?.revisions.find((revision) => revision.id === personal.revisionId),
    ).toMatchObject({ content: personal.content });
    await library.choose(
      {
        libraryId: personal.libraryId,
        revisionId: personal.revisionId,
        projectId: project,
        scope: "personal",
        role: "planning",
        state: "disable",
        expectedVersion: 1,
      },
      author,
    );
    const shared = await source("project", manager);
    const ticket = crypto.randomUUID();
    const sharedConversation = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES(${ticket},${project},'Owned shared source inspection',${author})`;
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by)
      VALUES(${sharedConversation},${project},${ticket},${author})`;
    const sharedTurnId = await completedTurn(sharedConversation, ticket);
    expect([
      ...(await database.client`SELECT ticket_id,state FROM factory.agent_turn WHERE id=${sharedTurnId}`),
    ]).toMatchObject([{ ticket_id: ticket, state: "completed" }]);
    expect([...(await library.assignments(sharedTurnId))]).toMatchObject([
      { connectionId: shared.libraryId, revisionId: shared.revisionId },
    ]);
    const newerRevisionId = crypto.randomUUID();
    await library.save(
      {
        ...shared,
        revisionId: newerRevisionId,
        expectedRevision: 1,
        content: { ...shared.content, endpoint: "https://newer.example/mcp" },
      },
      manager,
    );
    const view = await library.view(reader, project);
    const inspected = fixtureValue(
      view.entries.find((entry) => entry.id === shared.libraryId),
      "shared MCP definition",
    );
    expect(inspected.editable).toBe(false);
    expect(inspected.revisions.map((revision) => revision.id)).toEqual([
      newerRevisionId,
      shared.revisionId,
    ]);
    expect(inspected.revisions.find((revision) => revision.id === shared.revisionId)).toMatchObject(
      { content: shared.content },
    );
    expect(inspected.connection).toMatchObject({ revisionId: shared.revisionId, editable: false });
    expect(inspected.connection).not.toHaveProperty("credentialEpoch");
    expect(inspected.connection).not.toHaveProperty("secretKey");
    expect(view.entries.find((entry) => entry.id === personal.libraryId)).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(personal.revisionId);
    const proposal = crypto.randomUUID();
    await library.propose(proposal, personal.revisionId, "project", project, author);
    expect((await library.view(reader, project)).proposals).toHaveLength(0);
    expect((await library.view(manager, project)).proposals).toMatchObject([
      { id: proposal, revision: { id: personal.revisionId, content: personal.content } },
    ]);
  } finally {
    await handler.close();
    await database.client.end();
    await fixture.dispose();
  }
});
