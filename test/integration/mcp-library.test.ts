import { expect, test } from "bun:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MCPAssignment } from "#conversation-domain/mcp-library";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { createMCPLibrary, mcpDigest } from "../../apps/factory/src/mcp/controller";
import type { MCPSecret } from "../../apps/factory/src/mcp/secrets";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("MCP admission reads native writes and rolls back typed assignments in the caller's PostgreSQL transaction", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect(2);
  const library = createMCPLibrary(database);
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const libraryId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const credentialEpoch = crypto.randomUUID();
  const policyVersion = 5_000_000_000;
  const content = {
    name: "Owned transaction source",
    description: "Read within the caller's transaction",
    endpoint: "https://source.example/mcp",
    provider: "custom",
    authentication: "none",
    roles: ["planning"],
  };
  const tools: MCPAssignment["tools"] = [
    {
      name: "read",
      description: "Owned transaction read",
      inputSchema: { type: "object", properties: {} },
      digest: "a".repeat(64),
      readOnlyHint: true,
    },
  ];
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userId},'Owned transaction manager',${`${userId}@transaction.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userId})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${projectId},${`transaction-${projectId}`},'Owned transaction Project',
        'https://example.invalid/owned.git','main','.factory/actor-template.json',${userId})`;
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,created_by)
      VALUES(${conversationId},${projectId},${userId})`;
    const { turn } = await createAgentTurnStore(database).admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId,
        ticketId: null,
        conversationId,
        createdBy: userId,
        text: "Owned transaction-only admission",
      },
      { mode: "investigate", conversationVersion: 1, modelId: "owned-no-inference" },
    );
    const rollback = new Error("Owned MCP transaction rollback");
    async function admission(rollbackAfterWrite: boolean) {
      await database.client.begin(async (sql) => {
        await sql`SET LOCAL statement_timeout='5s'`;
        await sql`INSERT INTO factory.mcp_library(id,scope,owner_id)
          VALUES(${libraryId},'personal',${userId})`;
        await sql`INSERT INTO factory.mcp_revision(id,library_id,revision,content,digest,created_by)
          VALUES(${revisionId},${libraryId},1,${JSON.stringify(content)}::jsonb,${mcpDigest(content)},${userId})`;
        await sql`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,tools,allowed_tools,authorized_by)
          VALUES(${libraryId},${revisionId},'ready',${policyVersion},${credentialEpoch},
            ${JSON.stringify(tools)}::jsonb,${JSON.stringify(tools.map(({ name, digest }) => ({ name, digest })))}::jsonb,${userId})`;
        await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload)
          VALUES(${crypto.randomUUID()},'mcp.choice','personal',${projectId},${`mcp.choice:${libraryId}:personal:${projectId}:${userId}:planning`},NULL,'enable',
            ${JSON.stringify({ libraryId, scope: "personal", contextId: projectId, userId, role: "planning", state: "enable", revisionId, version: 1 })}::jsonb)`;
        expect(await library.connectionIn(sql, libraryId)).toMatchObject({
          version: policyVersion,
          credentialEpoch,
          tools,
        });
        expect(await library.revisionIn(sql, revisionId)).toMatchObject({
          libraryId,
          revision: 1,
          content,
        });
        await library.admitIn(sql, turn.id, projectId, userId, "planning");
        await library.admitIn(sql, turn.id, projectId, userId, "planning");
        expect([
          ...(await sql`SELECT payload->>'connectionId' AS connection_id,(payload->>'policyVersion')::float8 AS policy_version,payload->'tools' AS tools
            FROM factory.operation WHERE kind='coding.turn_mcp' AND scope_type='agent_turn' AND scope_id=${turn.id}`),
        ]).toEqual([{ connection_id: libraryId, policy_version: policyVersion, tools }]);
        expect(await library.assignments(turn.id)).toEqual([]);
        if (rollbackAfterWrite) throw rollback;
      });
    }
    await expect(admission(true)).rejects.toBe(rollback);
    expect(await library.assignments(turn.id)).toEqual([]);
    expect((await library.view(userId, projectId)).entries).toEqual([]);
    await admission(false);
    expect(await library.assignments(turn.id)).toEqual([
      {
        connectionId: libraryId,
        credentialEpoch,
        revisionId,
        policyVersion,
        tools,
        required: false,
      },
    ]);
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
});

test("MCP saves fence replay digests and concurrent revisions without leaving partial rows", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const library = createMCPLibrary(database);
  const userId = crypto.randomUUID();
  const input = {
    libraryId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    expectedRevision: 0,
    scope: "personal",
    content: {
      name: "Owned revision source",
      description: "Fence the exact revision",
      endpoint: "https://source.example/mcp",
      provider: "custom",
      authentication: "none",
      roles: ["planning"],
    },
  };
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userId},'Owned revision author',${`${userId}@revision.test`},true)`;
    await library.save(input, userId);
    await library.save(input, userId);
    await expect(
      library.save({ ...input, content: { ...input.content, name: "Changed replay" } }, userId),
    ).rejects.toThrow("identity was reused");
    const foreignLibraryId = crypto.randomUUID();
    await expect(library.save({ ...input, libraryId: foreignLibraryId }, userId)).rejects.toThrow(
      "identity was reused",
    );
    expect([
      ...(await database.client`SELECT id FROM factory.mcp_library WHERE id=${foreignLibraryId}`),
    ]).toEqual([]);
    expect([
      ...(await database.client`SELECT id FROM factory.mcp_library WHERE id=${foreignLibraryId} AND cover_key IS NOT NULL`),
    ]).toEqual([]);
    const candidates = ["First", "Second"].map((name) => ({
      ...input,
      revisionId: crypto.randomUUID(),
      expectedRevision: 1,
      content: { ...input.content, name },
    }));
    const results = await Promise.allSettled(
      candidates.map((value) => library.save(value, userId)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const entry = fixtureValue((await library.view(userId)).entries[0], "owned revision entry");
    expect(entry.revisions.map((revision) => revision.revision)).toEqual([2, 1]);
    expect(entry.revisions[1]).toMatchObject({
      id: input.revisionId,
      digest: mcpDigest(input.content),
    });
    for (const revision of entry.revisions)
      expect(revision.digest).toBe(mcpDigest(revision.content));
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
});

test("MCP credential recovery supersedes lost writes after base-key, epoch, disconnect or authority changes", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const stored = new Map<string, MCPSecret>();
  let requests = 0;
  const connections = createMCPConnections(
    database,
    {
      configured: true,
      read: async (key) => stored.get(key),
      create: async (key, value) => {
        stored.set(key, value);
        throw new Error("Lost owned write acknowledgement");
      },
    },
    "owned-recovery-key",
    "https://factory.example",
    async () => {
      requests++;
      throw new Error("Unsettled credentials must not dispatch");
    },
  );
  try {
    for (const change of ["base-key", "epoch", "disconnect", "authority"]) {
      const userId = crypto.randomUUID();
      const libraryId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${userId},'Owned recovery author',${`${userId}@recovery.test`},true)`;
      await connections.library.save(
        {
          libraryId,
          revisionId,
          expectedRevision: 0,
          scope: "personal",
          content: {
            name: `Owned ${change} source`,
            description: "Reject a stale credential write",
            endpoint: "https://source.example/mcp",
            provider: "custom",
            authentication: "bearer",
            roles: ["planning"],
          },
        },
        userId,
      );
      await expect(
        connections.connect(libraryId, userId, {
          commandId,
          revisionId,
          expectedVersion: 0,
          token: "Owned unacknowledged token",
        }),
      ).rejects.toThrow("Could not connect");
      const [pending] = await database.client<
        Array<{ id: string; epoch: string; state: string }>
      >`SELECT id,payload->>'credentialEpoch' AS epoch,state FROM factory.operation WHERE kind='mcp.secret_write' AND scope_type='connection' AND scope_id=${libraryId}`;
      if (!pending) throw new Error("Owned credential write intent missing");
      expect(pending).toMatchObject({ epoch: commandId, state: "intended" });
      if (change === "base-key")
        await database.client`UPDATE factory.mcp_connection SET secret_key='owned-replacement'
          WHERE id=${libraryId}`;
      else if (change === "epoch")
        await database.client`UPDATE factory.mcp_connection SET credential_epoch=${crypto.randomUUID()}
          WHERE id=${libraryId}`;
      else if (change === "disconnect") await connections.library.disconnect(libraryId, userId);
      else
        await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${userId}`;
      const [before] =
        await database.client`SELECT secret_key,credential_epoch,state FROM factory.mcp_connection WHERE id=${libraryId}`;
      if (!before) throw new Error("Owned recovery connection missing");
      await connections.recover();
      const [settled] =
        await database.client`SELECT state FROM factory.operation WHERE id=${pending.id} AND kind='mcp.secret_write'`;
      expect(settled?.["state"]).toBe("superseded");
      expect([
        ...(await database.client`SELECT secret_key,credential_epoch,state FROM factory.mcp_connection WHERE id=${libraryId}`),
      ]).toEqual([before]);
    }
    expect(requests).toBe(0);
    expect(stored.size).toBe(4);
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
});

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
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${id},${`mcp-${id}`},'Owned MCP Project','https://example.invalid/owned.git','main','.factory/actor-template.json',${manager})`;
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
        await database.client`UPDATE factory.operation SET payload=jsonb_set(payload,'{required}','false'::jsonb)
          WHERE kind='coding.turn_mcp' AND scope_type='agent_turn' AND scope_id=${admitted.turn.id}`)(),
    ).rejects.toThrow();
    expect(await call()).toEqual({ content: "Owned issue 42", isError: false });
    expect(calls).toBe(1);
    const [approvals] = await database.client<
      Array<{ count: number }>
    >`SELECT count(*)::float8 AS count FROM factory.audit_event WHERE kind='mcp.policy_approval' AND scope_type='connection' AND scope_id=${libraryId}`;
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
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${project},${`mcp-${project}`},'Owned MCP revision Project','https://example.invalid/owned.git','main','.factory/actor-template.json',${manager})`;
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
