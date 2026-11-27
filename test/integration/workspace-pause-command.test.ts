import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createRuntimeAccess } from "../../apps/factory/src/access/runtime";
import { createExternalFactoryMCP } from "../../apps/factory/src/mcp/external";
import { createDeveloperIDERuntime } from "../../apps/factory/src/workspace/developer-ide-runtime";
import { createWorkspaceLifecycle } from "../../apps/factory/src/workspace/lifecycle";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { substrateFixture } from "../fixtures/substrate";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";

type Runtimes = Parameters<typeof createWorkspaceLifecycle>[1];

async function pauseFixture(kind: "personal" | "ticket" = "personal") {
  const f = await substrateFixture("a".repeat(40), kind);
  const pauses: string[] = [];
  const beforeDispatch: { run?: () => Promise<void> } = {};
  const clients: Client[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  const admission = {
    workspaceID: f.workspaceID,
    createdBy: f.userID,
    parentHash: "a".repeat(64),
    childHash: "b".repeat(64),
    connectorURL: "wss://owned.factory.invalid/internal/runtime-connect",
  };
  await recordUncreatedWorkspaceAttempt(f.database, { ...admission, generation: 1 });
  if (kind === "ticket")
    await f.database.client`UPDATE factory.change SET runtime_attempt_id=${f.attemptID}
      WHERE id=${f.changeID}`;
  // Only runtime dispatch is controlled. Real SQL authority and the single product
  // journal are exercised below; this is not native suspend/restore acceptance.
  const get: Runtimes["get"] = async (id) => {
    const [row] = await f.database.client<{ state: "ready" | "paused" }[]>`
      SELECT state FROM factory.runtime_attempt WHERE id=${id}`;
    if (!row) return null;
    return {
      id,
      projectId: f.projectID,
      workspaceId: f.workspaceID,
      changeId: kind === "ticket" ? f.changeID : null,
      workspaceKind: kind,
      ownerUserId: kind === "personal" ? f.userID : null,
      runtimeKind: kind,
      currentStaging: false,
      generation: "1",
      revision: "a".repeat(40),
      state: row.state,
      failure: null,
      createdAt: "2026-11-24T00:00:00Z",
      updatedAt: "2026-11-24T00:00:00Z",
      readyAt: null,
      appReadyAt: {},
      native: {
        engine: "substrate",
        state: row.state === "paused" ? "ACTOR_STATE_SUSPENDED" : "ACTOR_STATE_RUNNING",
        coldRestart: true,
        portable: false,
        sourceHandoff: "pending",
      },
    };
  };
  const runtimes: Runtimes = {
    get,
    async start() {
      throw new Error("Pause must never start compute");
    },
    async startPersisted() {
      throw new Error("Pause must never start Coding");
    },
    async pause(id) {
      pauses.push(id);
      const [intent] = await f.database.client`
        SELECT payload->>'runtimeAttemptId' AS runtime_attempt_id,payload->>'action' AS action,
          payload->>'dispatchAttemptedAt' AS dispatch_attempted_at,completed_at
        FROM factory.operation WHERE kind='workspace.lifecycle' AND scope_type='workspace' AND scope_id=${f.workspaceID}
        ORDER BY created_at DESC LIMIT 1`;
      expect(intent).toMatchObject({
        runtime_attempt_id: id,
        action: "pause",
        completed_at: null,
      });
      expect(intent?.["dispatch_attempted_at"]).not.toBeNull();
      await beforeDispatch.run?.();
      await f.database.client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${id}`;
      return get(id);
    },
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Pause must not control app processes or terminals");
  };
  const editor = createDeveloperIDERuntime(
    f.database,
    {
      ...runtimes,
      processOutput: unexpected,
      processAction: unexpected,
      closeTerminal: unexpected,
    },
    f.hub,
    createRuntimeAccess(f.database, () => {}),
  );
  const authorization = (userID = f.userID) => ({
    token: "owned-pause-editor",
    grant: {
      userID,
      sessionID: crypto.randomUUID(),
      epoch: 1,
      expires: Date.now() + 60_000,
      embedded: true,
    },
  });
  const path = `/__factory/workspaces/${f.workspaceID}/runtime/pause`;
  const route = (requestID: string, userID = f.userID, method = "POST") =>
    editor.route(
      path,
      new Request(`http://editor.invalid${path}`, {
        method,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ requestID }),
            }
          : {}),
      }),
      authorization(userID),
    );
  return {
    ...f,
    pauses,
    beforeDispatch,
    admission,
    route,
    lifecycle: () => createWorkspaceLifecycle(f.database, runtimes),
    async mcp() {
      const handler = createExternalFactoryMCP({
        database: f.database,
        factoryOrigin: "http://127.0.0.1",
        factoryAuth: {
          async mcpSession() {
            return { userID: f.userID, scopes: ["factory:read", "factory:work"] };
          },
        },
        runtimeController: runtimes,
        runtimeHub: f.hub,
      } as unknown as Parameters<typeof createExternalFactoryMCP>[0]);
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
      const client = new Client({ name: "owned-workspace-pause", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", server.url)));
      return client;
    },
    async dispose() {
      for (const client of clients) await client.close();
      await server?.stop(true);
      await f.dispose();
    },
  };
}

test("IDE and MCP Pause share one intent and exact native Attempt, with no public Stop alias", async () => {
  const f = await pauseFixture();
  const requestID = crypto.randomUUID();
  try {
    expect((await f.route(requestID, f.userID, "GET"))?.status).toBe(405);
    await expect(f.route("invalid-request")).rejects.toThrow();
    expect(
      await f.database.client`SELECT id FROM factory.operation WHERE kind='workspace.lifecycle'`,
    ).toHaveLength(0);
    const source = await f.database
      .client`SELECT * FROM factory.development_workspace WHERE id=${f.workspaceID}`;
    const response = await f.route(requestID);
    expect(response?.status).toBe(202);
    const result = await response?.json();
    expect(result).toMatchObject({ id: f.attemptID, state: "paused" });
    const client = await f.mcp();
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("pauseWorkspace");
    expect(tools).toContain("startWorkspace");
    expect(tools).not.toContain("stopWorkspace");
    const replay = await client.callTool({
      name: "pauseWorkspace",
      arguments: { workspaceID: f.workspaceID, requestID },
    });
    expect(replay.isError).not.toBe(true);
    const text =
      "content" in replay ? replay.content.find((part) => part.type === "text") : undefined;
    if (text?.type !== "text") throw new Error("Missing MCP Pause result");
    expect(JSON.parse(text.text)).toEqual(result);
    await expect(
      f.lifecycle().start(f.userID, { workspaceID: f.workspaceID, requestID }),
    ).rejects.toThrow("another operation");
    expect(f.pauses).toEqual([f.attemptID]);
    expect(
      await f.database
        .client`SELECT * FROM factory.development_workspace WHERE id=${f.workspaceID}`,
    ).toEqual(source);
    const [intent] = await f.database
      .client`SELECT payload->>'runtimeAttemptId' AS runtime_attempt_id,
      payload->>'action' AS action,completed_at,result
      FROM factory.operation WHERE id=${requestID} AND kind='workspace.lifecycle'`;
    expect(intent).toMatchObject({ runtime_attempt_id: f.attemptID, action: "pause", result });
    expect(intent?.["completed_at"]).not.toBeNull();
    expect(
      await f.database
        .client`SELECT id FROM factory.runtime_attempt WHERE workspace_id=${f.workspaceID}`,
    ).toHaveLength(1);
    expect(
      await f.database
        .client`SELECT id FROM factory.runtime_attempt WHERE id=${f.attemptID} AND atespace IS NOT NULL`,
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("in-flight or lost Pause outcomes are uncertain and never redispatched across command owners", async () => {
  const f = await pauseFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requestID = crypto.randomUUID();
  try {
    f.beforeDispatch.run = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("Owned lost native Pause reply");
    };
    const pending = f.lifecycle().pause(f.userID, { workspaceID: f.workspaceID, requestID });
    // Bun's rejects matcher waits eagerly. Observe rejection without blocking
    // this test's deliberate release of the first command.
    const outcome = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([
      entered.promise,
      pending.then(
        (result) => {
          throw new Error(`Pause ended before dispatch: ${JSON.stringify(result)}`);
        },
        (cause) => {
          throw cause;
        },
      ),
    ]);
    const replay = await f.route(requestID);
    expect(await replay?.json()).toEqual({ requestID, state: "uncertain" });
    release.resolve();
    expect(await outcome).toMatchObject({
      error: { message: "Owned lost native Pause reply" },
    });
    expect(await f.lifecycle().pause(f.userID, { workspaceID: f.workspaceID, requestID })).toEqual({
      requestID,
      state: "uncertain",
    });
    expect(f.pauses).toEqual([f.attemptID]);
    const [intent] = await f.database
      .client`SELECT completed_at,result FROM factory.operation WHERE id=${requestID} AND kind='workspace.lifecycle'`;
    expect(intent).toEqual({ completed_at: null, result: null });
  } finally {
    release.resolve();
    await f.dispose();
  }
}, 60_000);

test("Ticket Pause controls compute without acquiring source writing, targeting its selected Attempt", async () => {
  const f = await pauseFixture("ticket");
  try {
    const requestID = crypto.randomUUID();
    const writer = await f.database
      .client`SELECT * FROM factory.change_writer WHERE change_id=${f.changeID}`;
    await expect(
      f.lifecycle().start(f.userID, {
        workspaceID: f.workspaceID,
        requestID: crypto.randomUUID(),
      }),
    ).rejects.toThrow("observation-only");
    // A newer historical generation is not this Ticket's selected Attempt.
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${f.attemptID}`;
    await recordUncreatedWorkspaceAttempt(f.database, {
      ...f.admission,
      generation: 2,
      state: "stopped",
    });
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
    await f.route(requestID);
    expect(f.pauses).toEqual([f.attemptID]);
    expect(
      await f.database.client`SELECT * FROM factory.change_writer WHERE change_id=${f.changeID}`,
    ).toEqual(writer);
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await expect(f.route(requestID)).rejects.toThrow("Developer access required");
    expect(f.pauses).toEqual([f.attemptID]);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("a personal Workspace observer cannot pause; a current collaborator can", async () => {
  const f = await pauseFixture();
  const guest = crypto.randomUUID();
  try {
    await f.database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${guest},'Owned Pause guest',${`${guest}@factory.invalid`})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${guest},'developer',${f.userID})`;
    const sharing = createWorkspaceSharing(f.database, () => {});
    await sharing.decide(f.userID, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: guest,
      permission: "observe",
      expectedVersion: 0,
    });
    await expect(f.route(crypto.randomUUID(), guest)).rejects.toThrow("observation only");
    expect(f.pauses).toHaveLength(0);
    await sharing.decide(f.userID, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: guest,
      permission: "collaborate",
      expectedVersion: 1,
    });
    await f.route(crypto.randomUUID(), guest);
    expect(f.pauses).toEqual([f.attemptID]);
  } finally {
    await f.dispose();
  }
}, 60_000);
