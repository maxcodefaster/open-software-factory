import { expect, test } from "bun:test";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createOpenCodeClient } from "../../apps/factory/src/agent/opencode-adapter";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createRecordedOpenCodeUsage } from "../../apps/factory/src/usage/record-opencode";
import { disableStarterSkillsIn } from "../fixtures/change-agent-turns";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";

test.each([
  { connected: true, outcome: "completed", loseChildLog: false },
  { connected: false, outcome: "completed", loseChildLog: false },
  { connected: false, outcome: "interrupted", loseChildLog: false },
  { connected: true, outcome: "completed", loseChildLog: true },
] as const)(
  "native Delete retains usage with connection=$connected, outcome=$outcome and lost child log=$loseChildLog",
  async ({ connected, outcome, loseChildLog }) => {
    const f = await nativeRuntimeFixture("ticket");
    const database = f.database;
    try {
      const runtime = f.controller();
      await runtime.startPersisted(f.changeID, f.userID);
      const sessionID = `ses_owned_usage_${f.changeID.replaceAll("-", "")}`;
      await database.client.begin(async (sql) => {
        await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change SET state='active' WHERE id=${f.changeID}`;
        await sql`UPDATE factory.change_writer SET state='unassigned',user_id=NULL,epoch=epoch+1 WHERE change_id=${f.changeID}`;
        await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,native_session_confirmed_at,created_by)
          VALUES(${f.changeID},${f.attemptID},${sessionID},'committed',now(),${f.userID})`;
        await disableStarterSkillsIn(sql, f.userID, f.projectID, database);
      });
      const admitted = await createChangeAdmission(database, "factory-coding-model").admit(
        f.changeID,
        f.userID,
        { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned cleanup coverage" },
      );
      const store = createAgentTurnStore(database);
      const turn = await store.claimPending(admitted.turn.id);
      if (!turn?.ownerToken) throw Error("Owned cleanup turn missing");
      const writers = createChangeWriterController({
        database,
        runtime,
        agentUsername: "owned-control",
        stopAgent: async () => {},
        protect: async () => {},
      });
      await writers.prepareAgent(f.changeID, turn.id);
      expect(await store.beginDispatch(turn.id, turn.ownerToken)).not.toBeNull();
      await database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id=${f.attemptID},session_id=${sessionID} WHERE turn_id=${turn.id}`;
      let hasLateConsumption = false;
      const occurredAt = Date.now();
      const childID = `${sessionID}_child`;
      f.hub.connected = () => connected;
      f.hub.request = async (_attempt, _channel, request, path) => {
        const url = new URL(path ?? new URL(request.url).pathname, "http://owned.local");
        if (url.pathname === "/api/session")
          return Response.json({
            data:
              url.searchParams.get("parentID") === sessionID && hasLateConsumption
                ? [
                    {
                      id: childID,
                      parentID: sessionID,
                      location: { directory: "/workspace/project" },
                    },
                  ]
                : [],
            cursor: {},
          });
        const id = url.pathname.includes(childID) ? childID : sessionID;
        if (hasLateConsumption && loseChildLog && id === childID)
          throw Error("Owned late child log became unavailable");
        const sequence = hasLateConsumption ? 2 : 0;
        const event = {
          id: `owned-consumption:${id}`,
          created: occurredAt,
          type: "session.usage.recorded",
          durable: { aggregateID: id, seq: sequence, version: 1 },
          data: {
            sessionID: id,
            source: id === childID ? "title" : "compaction",
            tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        };
        const frames =
          hasLateConsumption && Number(url.searchParams.get("after") ?? 0) < sequence
            ? [event]
            : [];
        return new Response(
          [...frames, { type: "log.synced", aggregateID: id, seq: sequence }]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const client = createOpenCodeClient((request, path) =>
        f.hub.request(f.attemptID, "agent", request, path),
      );
      const usage = createRecordedOpenCodeUsage(database);
      await usage.prepare(turn.id, client, sessionID);
      await usage.settle(turn.id, outcome);
      expect(
        await store.settle(
          turn.id,
          turn.ownerToken,
          outcome === "completed" ? "completed" : "failed",
          "Controlled terminal Coding",
        ),
      ).toBe(true);
      hasLateConsumption = true;
      const read = async () => [
        ...(await database.client`
        SELECT event_id,source,counters FROM factory.usage_entry WHERE operation_id=${`turn:${turn.id}`} ORDER BY event_id`),
      ];
      let entriesAtDeletion: Awaited<ReturnType<typeof read>> = [];
      f.beforeCall(async (method) => {
        if (method === "DeleteActor") entriesAtDeletion = await read();
      });
      expect((await runtime.stop(f.attemptID))?.state).toBe("stopped");
      expect(f.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(1);
      if (connected && !loseChildLog) {
        expect(entriesAtDeletion.map((entry) => entry["source"]).sort()).toEqual([
          "compaction",
          "title",
        ]);
        expect(entriesAtDeletion.every((entry) => entry["counters"].input === 7)).toBe(true);
      } else if (loseChildLog) {
        expect(entriesAtDeletion.map((entry) => entry["source"]).sort()).toEqual([
          "compaction",
          "unobserved",
        ]);
        expect(
          entriesAtDeletion.find((entry) => entry["source"] === "compaction")?.["counters"].input,
        ).toBe(7);
        expect(
          entriesAtDeletion.find((entry) => entry["source"] === "unobserved")?.["counters"].input,
        ).toBeNull();
      } else {
        expect(entriesAtDeletion).toHaveLength(outcome === "interrupted" ? 2 : 1);
        expect(entriesAtDeletion.every((entry) => entry["source"] === "unobserved")).toBe(true);
        expect(entriesAtDeletion.every((entry) => entry["counters"].input === null)).toBe(true);
      }
      const before = await read();
      if (connected && !loseChildLog) await usage.drainAttempt(f.attemptID, client);
      else await usage.markUnavailable(f.attemptID);
      expect(await read()).toEqual(before);
      expect((await runtime.stop(f.attemptID))?.state).toBe("stopped");
      expect(f.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(1);
      expect(
        await database.client`SELECT id FROM factory.development_workspace WHERE change_id=${f.changeID}`,
      ).toHaveLength(1);
      expect(
        await database.client`SELECT workspace_id FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`,
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);
