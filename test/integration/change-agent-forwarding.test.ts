import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentTransport } from "../../apps/factory/src/agent/change-transport";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createStopTransport } from "../../apps/factory/src/agent/stop-transport";
import {
  type AgentTurnTransaction,
  createAgentTurnStore,
} from "../../apps/factory/src/agent/turn-store";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

async function forwarding(databaseConnections?: number) {
  const owned = await fixture();
  const database = databaseConnections ? owned.connect(databaseConnections) : owned.database;
  const { turn } = await createChangeAdmission(database, buildModelID).admit(
    owned.changeID,
    owned.userID,
    { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned forwarding proof" },
  );
  const store = createAgentTurnStore(database);
  await owned.writers.prepareAgent(owned.changeID, turn.id);
  const claimed = await store.claimPending(turn.id);
  if (!claimed?.ownerToken) throw new Error("Owned forwarding claim required");
  await store.beginDispatch(turn.id, claimed.ownerToken);
  await database.client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id = ${owned.attemptID}
    WHERE turn_id = ${turn.id}`;
  await database.client`UPDATE factory.change_agent_session SET state = 'starting', active_turn_id = ${turn.id}
    WHERE change_id = ${owned.changeID}`;
  const frames: Array<{ type: string; streamId: string; method: string }> = [];
  const hub = new RuntimeHub(async () => {});
  const child = {
    data: { kind: "connector", role: "child", attemptID: owned.attemptID, generation: 1 },
    close() {},
    send(raw: string) {
      const frame = JSON.parse(raw) as (typeof frames)[number];
      frames.push(frame);
      if (databaseConnections !== 1 && frame.type === "http-request")
        queueMicrotask(() => {
          hub.message(
            child,
            JSON.stringify({ type: "http-response", streamId: frame.streamId, status: 204 }),
          );
          hub.message(child, JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
        });
      return 1;
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  hub.open(child);
  return {
    owned,
    database,
    turn,
    ownerToken: claimed.ownerToken,
    hub,
    frames,
    transport: createChangeAgentTransport(
      database,
      hub,
      owned.attemptID,
      turn.id,
      claimed.ownerToken,
    ),
    respond() {
      const frame = frames.find((frame) => frame.type === "http-request");
      if (!frame) throw new Error("Owned HTTP frame required");
      hub.message(
        child,
        JSON.stringify({ type: "http-response", streamId: frame.streamId, status: 204 }),
      );
      hub.message(child, JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
    },
    async dispose() {
      hub.revoke(owned.attemptID);
      if (database !== owned.database) await database.client.end();
      await owned.dispose();
    },
  };
}

test("Stop rejects a prompt whose body finishes buffering after revocation", async () => {
  const scope = await forwarding();
  const body = Promise.withResolvers<void>();
  const request = new Request("http://opencode.runtime/api/session/owned/prompt", {
    method: "POST",
    body: new ReadableStream({
      async start(controller) {
        await body.promise;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }),
  });
  const result = scope.transport(request, "/api/session/owned/prompt").then(
    () => "sent",
    () => "rejected",
  );
  try {
    await createChangeAgentStop(scope.database, scope.owned.hub).persist(scope.owned.changeID);
    body.resolve();
    expect(await result).toBe("rejected");
    expect(scope.frames.some((frame) => frame.type === "http-request")).toBe(false);
    expect((await scope.owned.turn(scope.turn.commandId))?.state).toBe("stopped");
  } finally {
    body.resolve();
    await result;
    await scope.dispose();
  }
});

test("a forwarded prompt releases the only SQL connection before upstream admission responds", async () => {
  const scope = await forwarding(1);
  const response = scope.transport(
    new Request("http://opencode.runtime/api/session/owned/prompt", {
      method: "POST",
      body: "{}",
    }),
    "/api/session/owned/prompt",
  );
  try {
    for (let observation = 0; !scope.frames.length && observation < 50; observation += 1)
      await Bun.sleep(10);
    expect(scope.frames[0]?.type).toBe("http-request");
    const stopping = createChangeAgentStop(scope.database, scope.owned.hub).persist(
      scope.owned.changeID,
    );
    expect(
      await Promise.race([stopping.then(() => "persisted"), Bun.sleep(500).then(() => "hung")]),
    ).toBe("persisted");
    scope.respond();
    expect((await response).status).toBe(204);
    await stopping;
  } finally {
    scope.respond();
    await response.catch(() => undefined);
    await scope.dispose();
  }
});

async function stopTransport(scope: Awaited<ReturnType<typeof forwarding>>) {
  await createChangeAgentStop(scope.database, scope.owned.hub).persist(scope.owned.changeID);
  const rows = await scope.database.client<Array<{ stopID: string }>>`
    UPDATE factory.change_agent_session SET stop_dispatched = true
    WHERE change_id = ${scope.owned.changeID} RETURNING stop_id AS "stopID"`;
  const current = rows[0];
  if (!current) throw new Error("Owned dispatched Stop required");
  return createStopTransport(scope.database, scope.hub, {
    changeID: scope.owned.changeID,
    stopID: current.stopID,
    attemptID: scope.owned.attemptID,
    sessionID: scope.owned.sessionID,
  });
}

test("a forwarded Stop releases the only SQL connection before its response", async () => {
  const scope = await forwarding(1);
  let response: Promise<Response> | undefined;
  try {
    const transport = await stopTransport(scope);
    response = transport(
      new Request("http://opencode.runtime/api/session/owned/interrupt", {
        method: "POST",
      }),
      "/api/session/owned/interrupt",
    );
    for (let observation = 0; !scope.frames.length && observation < 50; observation += 1)
      await Bun.sleep(10);
    expect(scope.frames[0]?.type).toBe("http-request");
    expect(
      await Promise.race([
        scope.database.client`SELECT 1`.then(() => "released"),
        Bun.sleep(500).then(() => "hung"),
      ]),
    ).toBe("released");
    scope.respond();
    expect((await response).status).toBe(204);
  } finally {
    if (scope.frames.length) scope.respond();
    await response?.catch(() => undefined);
    await scope.dispose();
  }
});

test.each([
  "Stop identity",
  "confirmation",
  "Session",
  "current runtime",
  "runtime state",
] as const)("Stop frame dispatch rejects changed %s", async (boundary) => {
  const scope = await forwarding();
  try {
    const transport = await stopTransport(scope);
    if (boundary === "Stop identity")
      await scope.database
        .client`UPDATE factory.change_agent_session SET stop_id = ${crypto.randomUUID()}
          WHERE change_id = ${scope.owned.changeID}`;
    if (boundary === "confirmation")
      await scope.database
        .client`UPDATE factory.change_agent_session SET stop_pending = false, stop_dispatched = false
          WHERE change_id = ${scope.owned.changeID}`;
    if (boundary === "Session")
      await scope.database
        .client`UPDATE factory.change_agent_session SET opencode_session_id = 'ses_other'
          WHERE change_id = ${scope.owned.changeID}`;
    if (boundary === "current runtime")
      await scope.database.client`UPDATE factory.change SET runtime_attempt_id = NULL
          WHERE id = ${scope.owned.changeID}`;
    if (boundary === "runtime state")
      await scope.database.client`UPDATE factory.runtime_attempt SET state = 'starting'
          WHERE id = ${scope.owned.attemptID}`;
    await expect(
      transport(
        new Request("http://opencode.runtime/api/session/owned/interrupt", {
          method: "POST",
        }),
        "/api/session/owned/interrupt",
      ),
    ).rejects.toThrow("Stop authority changed before dispatch");
    expect(scope.frames.some((frame) => frame.type === "http-request")).toBe(false);
  } finally {
    await scope.dispose();
  }
});

test.each(["before", "after"] as const)(
  "a lease expiring %s the final runtime query cannot forward a frame",
  async (phase) => {
    const scope = await forwarding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const database = {
      ...scope.database,
      client: new Proxy(scope.database.client, {
        get(target, property, receiver) {
          if (property !== "begin") return Reflect.get(target, property, receiver);
          return (callback: (sql: AgentTurnTransaction) => Promise<unknown>) =>
            target.begin((sql) =>
              callback(
                new Proxy(sql, {
                  apply(target, receiver, args) {
                    const parts = args[0] as TemplateStringsArray;
                    if (!parts.join("").includes("SELECT intent.turn_id AS id"))
                      return Reflect.apply(target, receiver, args);
                    return (async () => {
                      const result =
                        phase === "after" ? await Reflect.apply(target, receiver, args) : undefined;
                      entered.resolve();
                      await release.promise;
                      return phase === "after" ? result : Reflect.apply(target, receiver, args);
                    })();
                  },
                }),
              ),
            );
        },
      }),
    };
    let result: Promise<string> | undefined;
    try {
      await scope.database.client`UPDATE factory.agent_turn
      SET owner_expires_at = clock_timestamp() + interval '500 milliseconds' WHERE id = ${scope.turn.id}`;
      result = createChangeAgentTransport(
        database,
        scope.hub,
        scope.owned.attemptID,
        scope.turn.id,
        scope.ownerToken,
      )(
        new Request("http://opencode.runtime/api/session/owned/prompt", {
          method: "POST",
          body: "{}",
        }),
        "/api/session/owned/prompt",
      ).then(
        () => "sent",
        () => "rejected",
      );
      await entered.promise;
      for (;;) {
        const rows = await scope.database.client<Array<{ expired: boolean }>>`
        SELECT owner_expires_at <= clock_timestamp() AS expired FROM factory.agent_turn WHERE id = ${scope.turn.id}`;
        if (rows[0]?.expired) break;
        await Bun.sleep(10);
      }
      release.resolve();
      expect(await result).toBe("rejected");
      expect(scope.frames.some((frame) => frame.type === "http-request")).toBe(false);
    } finally {
      release.resolve();
      await result;
      await scope.dispose();
    }
  },
);

test.each(["lease", "runtime", "turn"] as const)(
  "rejects stale %s at the frame-send boundary",
  async (boundary) => {
    const scope = await forwarding();
    try {
      if (boundary === "lease")
        await scope.database
          .client`UPDATE factory.agent_turn SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${scope.turn.id}`;
      if (boundary === "runtime")
        await scope.database
          .client`UPDATE factory.change SET runtime_attempt_id = NULL WHERE id = ${scope.owned.changeID}`;
      if (boundary === "turn")
        await scope.database
          .client`UPDATE factory.change_agent_session SET active_turn_id = NULL WHERE change_id = ${scope.owned.changeID}`;
      await expect(
        scope.transport(
          new Request("http://opencode.runtime/api/session/owned/prompt", {
            method: "POST",
            body: "{}",
          }),
          "/api/session/owned/prompt",
        ),
      ).rejects.toThrow("authority changed");
      expect(scope.frames.some((frame) => frame.type === "http-request")).toBe(false);
    } finally {
      await scope.dispose();
    }
  },
);
