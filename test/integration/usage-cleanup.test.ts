import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createOpenCodeClient } from "../../apps/factory/src/agent/opencode-client";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createRecordedOpenCodeUsage } from "../../apps/factory/src/usage/record-opencode";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import upstream from "../../upstream.json";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("retained cleanup recovery leaves database capacity for startup and usage", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect(2);
  const inspection = processFixture.connect(1);
  try {
    const attempts = [];
    for (let index = 0; index < 4; index++)
      attempts.push(await fixture(undefined, undefined, database));
    const hub = attempts[0]!.hub;
    hub.connected = () => false;
    const runtime = createRuntimeController(
      database,
      hub,
      "owned-cleanup-capacity",
      {
        prepareExecution: async () => {
          throw new Error("Recovery must not create source");
        },
      },
      { ...createKubernetesClient(), getNamespace: async () => null },
      async () => "",
    );
    await database.client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()`;
    await Promise.race([
      runtime.recover(),
      Bun.sleep(2000).then(() => {
        throw new Error("Cleanup exhausted the startup connection pool");
      }),
    ]);
    await eventually(
      async () => {
        const [count] =
          await inspection.client`SELECT count(*)::int AS count FROM factory.runtime_attempt WHERE state<>'stopped'`;
        return count?.["count"];
      },
      (remaining) => remaining === 0,
      "Retained cleanup did not settle",
      3000,
    );
    expect(await database.client`SELECT 1 AS available`).toHaveLength(1);
  } finally {
    await database.client.end({ timeout: 1 });
    await inspection.client.end({ timeout: 1 });
    await processFixture.dispose();
  }
}, 30000);

test.each([
  [true, "completed"],
  [false, "completed"],
  [false, "interrupted"],
] as const)(
  "cleanup preserves late consumption or honest lost coverage with connection=%s and outcome=%s",
  async (connected, outcome) => {
    const processFixture = await factoryProcess();
    const database = processFixture.connect();
    try {
      const owned = await fixture(undefined, undefined, database);
      const admitted = await createChangeAdmission(database, buildModelID).admit(
        owned.changeID,
        owned.userID,
        {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Owned cleanup coverage",
        },
      );
      const store = createAgentTurnStore(database);
      const turn = await store.claimPending(admitted.turn.id);
      if (!turn?.ownerToken) throw new Error("Owned cleanup turn missing");
      await owned.writers.prepareAgent(owned.changeID, turn.id);
      await store.beginDispatch(turn.id, turn.ownerToken);
      await database.client`UPDATE factory.change_agent_turn_intent
      SET runtime_attempt_id=${owned.attemptID},session_id=${owned.sessionID} WHERE turn_id=${turn.id}`;
      let hasLateConsumption = false;
      const occurredAt = Date.now();
      const childID = `${owned.sessionID}_child`;
      owned.hub.connected = () => connected;
      owned.hub.request = async (_attempt, _channel, request, path) => {
        const url = new URL(path ?? new URL(request.url).pathname, "http://owned.local");
        if (url.pathname === "/api/session")
          return Response.json({
            data:
              url.searchParams.get("parentID") === owned.sessionID && hasLateConsumption
                ? [
                    {
                      id: childID,
                      parentID: owned.sessionID,
                      location: { directory: "/workspace/project" },
                    },
                  ]
                : [],
            cursor: {},
          });
        const sessionID = url.pathname.includes(childID) ? childID : owned.sessionID;
        const sequence = hasLateConsumption ? 2 : 0;
        const event = {
          id: `owned-consumption:${sessionID}`,
          created: occurredAt,
          type: "session.usage.recorded",
          durable: { aggregateID: sessionID, seq: sequence, version: 1 },
          data: {
            sessionID,
            source: sessionID === childID ? "title" : "compaction",
            tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        };
        const frames =
          hasLateConsumption && Number(url.searchParams.get("after") ?? 0) < sequence
            ? [event]
            : [];
        return new Response(
          [...frames, { type: "log.synced", aggregateID: sessionID, seq: sequence }]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const client = createOpenCodeClient((request, path) =>
        owned.hub.request(owned.attemptID, "agent", request, path),
      );
      const usage = createRecordedOpenCodeUsage(database);
      await usage.prepare(turn.id, client, owned.sessionID);
      await usage.settle(turn.id, outcome);
      hasLateConsumption = true;
      const read = async () => [
        ...(await database.client`
      SELECT event_id,source,counters FROM factory.usage_entry WHERE operation_id=${`turn:${turn.id}`} ORDER BY event_id`),
      ];
      let deletes = 0;
      let entriesAtDeletion: Awaited<ReturnType<typeof read>> = [];
      await database.client`UPDATE factory.runtime_attempt SET kubernetes_uid='owned-cleanup-pod' WHERE id=${owned.attemptID}`;
      const runtime = createRuntimeController(
        database,
        owned.hub,
        "owned-cleanup",
        {
          prepareExecution: async () => {
            throw new Error("Cleanup must not create source");
          },
        },
        {
          ...createKubernetesClient(),
          getNamespace: async () => ({ uid: "owned-source-namespace", labels: {} }),
          getPod: async () => ({
            uid: "owned-cleanup-pod",
            phase: "Running",
            labels: {},
            envboxImage: upstream.envbox.image,
            runtimeHostImage: process.env["FACTORY_RUNTIME_HOST_IMAGE"] ?? "owned",
          }),
          deletePod: async () => {
            entriesAtDeletion = await read();
            deletes++;
          },
          deleteNamespace: async () => {
            throw new Error("Source must survive compute cleanup");
          },
        },
        async () => "",
      );
      await runtime.stop(owned.attemptID);
      await eventually(
        async () => (await runtime.get(owned.attemptID))?.state,
        (state) => state === "stopped",
        "Usage did not persist before Pod deletion",
        15000,
      );
      expect(deletes).toBe(1);
      if (connected) {
        expect(entriesAtDeletion.map((entry) => entry["source"]).sort()).toEqual([
          "compaction",
          "title",
        ]);
        expect(entriesAtDeletion.every((entry) => entry["counters"].input === 7)).toBe(true);
      } else {
        expect(entriesAtDeletion).toHaveLength(outcome === "interrupted" ? 2 : 1);
        expect(entriesAtDeletion.every((entry) => entry["source"] === "unobserved")).toBe(true);
        expect(entriesAtDeletion.every((entry) => entry["counters"].input === null)).toBe(true);
      }
      const before = await read();
      if (connected) await usage.drainAttempt(owned.attemptID, client);
      else await usage.markUnavailable(owned.attemptID);
      expect(await read()).toEqual(before);
      expect(
        await database.client`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`,
      ).toHaveLength(1);
    } finally {
      await database.client.end({ timeout: 2 });
      await processFixture.dispose();
    }
  },
  60000,
);
