import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

const readCases = (["committed", "stopped"] as const).flatMap((state) =>
  (["before headers", "during body", "not stalled"] as const).map((stall) => ({ state, stall })),
);

test("completed history can be read from the same retained Workspace without rebinding execution", async () => {
  const owned = await fixture();
  const replacementID = crypto.randomUUID();
  const original = owned.hub.request.bind(owned.hub);
  let historyReads = 0;
  try {
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state = 'failed' WHERE id = ${owned.attemptID}`;
    await owned.database
      .client`INSERT INTO factory.runtime_attempt(id, project_id, change_id, workspace_id, generation, revision, state,
      kubernetes_namespace, kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
      SELECT ${replacementID}, project_id, change_id, workspace_id, generation + 1, revision, 'ready',
        kubernetes_namespace, 'never-created-replacement', parent_connector_token_hash, child_connector_token_hash, now(), created_by
      FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
    await owned.database
      .client`UPDATE factory.change SET runtime_attempt_id = ${replacementID} WHERE id = ${owned.changeID}`;
    owned.hub.request = async (attemptID, channel, request, path) => {
      if (new URL(request.url).pathname.endsWith("/message")) {
        historyReads++;
        expect(attemptID).toBe(replacementID);
        return Response.json({
          data: [
            {
              id: "retained-output",
              type: "assistant",
              content: [{ type: "text", text: "Retained exact answer" }],
              time: { created: 1 },
            },
          ],
        });
      }
      return original(attemptID, channel, request, path);
    };
    expect(await owned.controller().get(owned.changeID, undefined, false)).toMatchObject({
      state: "committed",
      messagesAvailable: false,
      messages: [],
      runtimeConnected: true,
      sessionAvailable: true,
      stopPending: false,
    });
    expect(historyReads).toBe(0);
    expect(await owned.controller().get(owned.changeID)).toMatchObject({
      messagesAvailable: true,
      runtimeConnected: true,
      messages: [expect.objectContaining({ text: "Retained exact answer" })],
    });
    expect(historyReads).toBe(1);
    const [session] = await owned.database.client<
      Array<{ attemptID: string }>
    >`SELECT runtime_attempt_id AS "attemptID" FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
    expect(session?.attemptID).toBe(owned.attemptID);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    owned.hub.request = original;
    await owned.database
      .client`UPDATE factory.change SET runtime_attempt_id = ${owned.attemptID} WHERE id = ${owned.changeID}`;
    await owned.database
      .client`DELETE FROM factory.runtime_attempt WHERE id = ${replacementID} AND kubernetes_uid IS NULL AND kubernetes_namespace_uid IS NULL`;
    await owned.dispose();
  }
});

test("Build history uses immutable human input and hides injected bootstrap instructions", async () => {
  const owned = await fixture();
  const original = owned.hub.request.bind(owned.hub);
  try {
    const admission = createChangeAdmission(owned.database, buildModelID);
    const store = createAgentTurnStore(owned.database);
    const inputs = [
      { kind: "change-start", commandId: crypto.randomUUID() },
      {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Keep the dashboard.\n\nMy own context",
      },
      {
        kind: "change-repair",
        commandId: crypto.randomUUID(),
        text: "Repair the exact failing check.",
      },
    ] as const;
    const messages: Array<{ id: string; type: string; text: string; time: { created: number } }> =
      [];
    for (const input of inputs) {
      const { turn } = await admission.admit(owned.changeID, owned.userID, input);
      const intent = await admission.intent(turn.id);
      expect(intent.text).toContain("Factory development browser:");
      messages.unshift({
        id: intent.promptID,
        type: "user",
        text: intent.text,
        time: { created: messages.length + 1 },
      });
      const claimed = await store.claimPending(turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned history Turn claim required");
      await store.beginDispatch(turn.id, claimed.ownerToken);
      expect(
        await store.settle(turn.id, claimed.ownerToken, "completed", "Owned history fixture"),
      ).toBe(true);
    }
    owned.hub.request = async (attemptID, channel, request, path) => {
      if (new URL(request.url).pathname.endsWith("/message"))
        return Response.json({ data: messages });
      return original(attemptID, channel, request, path);
    };
    const result = await owned.controller().get(owned.changeID);
    expect(result.messagesAvailable).toBe(true);
    expect(result.messages.map((message) => message.text)).toEqual([
      inputs[1].text,
      inputs[2].text,
    ]);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    owned.hub.request = original;
    await owned.dispose();
  }
});

test.each(["uncertain", "failed"] as const)(
  "a saved $state Turn cannot appear working while Session projection lags",
  async (state) => {
    const owned = await fixture();
    try {
      const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
        owned.changeID,
        owned.userID,
        {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Owned terminal projection",
        },
      );
      const store = createAgentTurnStore(owned.database);
      const claimed = await store.claimPending(turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned projection claim required");
      await store.beginDispatch(turn.id, claimed.ownerToken);
      await owned.database.client`UPDATE factory.change_agent_session SET state = 'working',
        active_turn_id = ${turn.id} WHERE change_id = ${owned.changeID}`;
      expect(await store.settle(turn.id, claimed.ownerToken, state, "Owned lost outcome")).toBe(
        true,
      );
      expect(await owned.controller().get(owned.changeID)).toMatchObject({
        state: "failed",
        lastError: expect.stringContaining("Owned lost outcome"),
        turn: { id: turn.id, state },
      });
      await owned.database.client`UPDATE factory.change_agent_session SET state = 'stopped'
        WHERE change_id = ${owned.changeID}`;
      expect((await owned.controller().get(owned.changeID)).state).toBe("stopped");
    } finally {
      await owned.dispose();
    }
  },
);

test.each(readCases)(
  "persisted $state remains readable when OpenCode history is $stall",
  async ({ state, stall }) => {
    const owned = await fixture();
    const entered = Promise.withResolvers<void>();
    const original = owned.hub.request.bind(owned.hub);
    const transport = new RuntimeHub(async () => {});
    const sent: Array<{ type: string; streamId: string; path?: string }> = [];
    const child = {
      data: { kind: "connector", role: "child", attemptID: owned.attemptID, generation: 1 },
      close() {},
      send(raw: string) {
        const message = JSON.parse(raw) as (typeof sent)[number];
        sent.push(message);
        if (message.type === "http-request") {
          entered.resolve();
          if (stall !== "before headers") {
            transport.message(
              child,
              JSON.stringify({
                type: "http-response",
                streamId: message.streamId,
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
            if (stall === "not stalled") {
              transport.message(
                child,
                JSON.stringify({
                  type: "stream-data",
                  streamId: message.streamId,
                  data: Buffer.from(
                    JSON.stringify({
                      data: [
                        {
                          id: "owned-output",
                          type: "assistant",
                          content: [{ type: "text", text: "Useful Build output" }],
                          time: { created: 1, completed: 2 },
                          finish: "stop",
                        },
                      ],
                    }),
                  ).toString("base64"),
                }),
              );
              transport.message(
                child,
                JSON.stringify({ type: "stream-end", streamId: message.streamId }),
              );
            }
          }
        }
        return 1;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    transport.open(child);
    owned.hub.request = transport.request.bind(transport);
    let read: ReturnType<ReturnType<typeof owned.controller>["get"]> | undefined;
    try {
      const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
        owned.changeID,
        owned.userID,
        { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned completed read" },
      );
      // Isolate the observed read pattern, not inference or commit execution.
      if (state === "stopped") {
        await owned.database
          .client`UPDATE factory.agent_turn SET state = 'stopped' WHERE id = ${turn.id}`;
        await owned.database
          .client`UPDATE factory.change_agent_session SET state = 'stopped' WHERE change_id = ${owned.changeID}`;
      } else {
        const store = createAgentTurnStore(owned.database);
        const claimed = await store.claimPending(turn.id);
        if (!claimed?.ownerToken) throw new Error("Owned read fixture claim required");
        await store.beginDispatch(turn.id, claimed.ownerToken);
        expect(
          await store.settle(turn.id, claimed.ownerToken, "completed", "Owned read fixture"),
        ).toBe(true);
      }
      read = owned.controller().get(owned.changeID);
      await entered.promise;
      const result = await Promise.race([
        read,
        Bun.sleep(3_000).then(() => "History blocked persisted state" as const),
      ]);
      expect(result).toMatchObject({
        state,
        messagesAvailable: stall === "not stalled",
        messages:
          stall === "not stalled"
            ? [expect.objectContaining({ role: "assistant", text: "Useful Build output" })]
            : [],
        turn: { id: turn.id, state: state === "stopped" ? "stopped" : "completed" },
      });
      expect(sent.some((message) => message.type === "stream-close")).toBe(stall !== "not stalled");
      expect(sent.filter((message) => message.type === "http-request")).toHaveLength(1);
      expect(sent[0]?.path).toContain(`/api/session/${owned.sessionID}/message`);
      expect(owned.requests()).toBe(0);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      transport.revoke(owned.attemptID);
      await read?.catch(() => {});
      owned.hub.request = original;
      await owned.dispose();
    }
  },
);
