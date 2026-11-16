import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { createAgentService } from "../../apps/factory/src/agent/service";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import { createDatabase } from "../../packages/db/src/client";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

type Owned = Awaited<ReturnType<typeof fixture>>;
let server: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);

async function withFixture(
  run: (context: {
    owned: Owned;
    controller: ReturnType<typeof createAgentController>;
    service: ReturnType<typeof createAgentService>;
    calls: string[];
  }) => Promise<void>,
) {
  if (!server) throw Error("Owned PostgreSQL server is required");
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = target.url;
  const database = createDatabase(2);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  let owned: Owned | undefined;
  let controller: ReturnType<typeof createAgentController> | undefined;
  try {
    owned = await fixture(undefined, undefined, database);
    const calls: string[] = [];
    const unexpected = (operation: string): never => {
      calls.push(operation);
      throw Error(`Read attempted external work: ${operation}`);
    };
    owned.hub.connected = () => false;
    owned.hub.request = async () => unexpected("OpenCode request");
    owned.hub.parentOperation = async () => unexpected("parent operation");
    controller = createAgentController(
      database,
      owned.hub,
      {
        startPersisted: async () => unexpected("runtime start"),
        get: async () => unexpected("runtime observation"),
      },
      undefined,
      owned.writers,
    );
    await run({
      owned,
      controller,
      service: createAgentService({ access: createAccessController(database), controller }),
      calls,
    });
  } finally {
    try {
      await controller?.shutdown();
      await owned?.shutdown();
    } finally {
      owned?.restoreEnvironment();
      await database.client.end();
      await target.dispose();
    }
  }
}

async function successor(owned: Owned, previousState: "stopped" | "failed") {
  const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
    owned.changeID,
    owned.userID,
    { kind: "change-start", commandId: crypto.randomUUID() },
  );
  const attemptID = runtimeIdentity(owned.workspaceID, 2).attemptID;
  await owned.database.client.begin(async (sql) => {
    await sql`UPDATE factory.change_agent_session SET state=${previousState},
      last_error='Previous implementation ended' WHERE change_id=${owned.changeID}`;
    await sql`UPDATE factory.runtime_attempt SET state=${previousState} WHERE id=${owned.attemptID}`;
    // Controlled, uncreated native records only. No Actor or runtime controller runs.
    await sql`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,
      revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${attemptID},project_id,change_id,workspace_id,generation+1,revision,'create-intended',
        parent_connector_token_hash,child_connector_token_hash,now(),created_by
      FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
      SELECT ${attemptID},${`fa-${attemptID.replaceAll("-", "")}`},
        ${`runtime-${attemptID.replaceAll("-", "")}`},intent
      FROM factory.substrate_binding WHERE runtime_attempt_id=${owned.attemptID}`;
    await freezeRuntimeEnvironment(sql, attemptID);
    await sql`UPDATE factory.change SET runtime_attempt_id=${attemptID} WHERE id=${owned.changeID}`;
  });
  return { attemptID, turnID: turn.id };
}

async function savedState(owned: Owned) {
  return owned.database.client`SELECT row_to_json(change) AS change,row_to_json(session) AS session,
    row_to_json(attempt) AS attempt,row_to_json(binding) AS binding,row_to_json(turn) AS turn,
    row_to_json(writer) AS writer
    FROM factory.change change JOIN factory.change_agent_session session ON session.change_id=change.id
    JOIN factory.runtime_attempt attempt ON attempt.change_id=change.id
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    JOIN factory.agent_turn turn ON turn.change_id=change.id
    JOIN factory.change_writer writer ON writer.change_id=change.id
    WHERE change.id=${owned.changeID} ORDER BY attempt.generation`;
}

test.each(["stopped", "failed"] as const)(
  "getAgentView projects a current successor instead of the previous %s runtime without external work",
  async (previousState) => {
    await withFixture(async ({ owned, controller, service, calls }) => {
      const current = await successor(owned, previousState);
      owned.hub.connected = (attemptID) => attemptID === current.attemptID;
      const unsubscribe = controller.subscribeActivity(owned.changeID, () => {});
      try {
        for (const state of [
          "create-intended",
          "starting",
          "resuming",
          "pausing",
          "paused",
          "stop-intended",
          "stopping",
          "cleanup-failed",
          "failed",
          "stopped",
        ]) {
          await owned.database
            .client`UPDATE factory.runtime_attempt SET state=${state} WHERE id=${current.attemptID}`;
          const before = await savedState(owned);
          // The authenticated service is the getAgentView handler's read path.
          for (const history of [false, true]) {
            expect(await service.get(owned.userID, owned.changeID, history)).toMatchObject({
              state: "starting",
              turn: { id: current.turnID, state: "pending" },
              runtimeState: state,
              lastError: undefined,
              messagesAvailable: false,
              messages: [],
              runtimeConnected: false,
              stopPending: false,
            });
            expect(calls).toEqual([]);
          }
          expect(await savedState(owned)).toEqual(before);
        }
        expect(owned.requests()).toBe(0);
        expect(owned.commitCalls).toEqual([]);
      } finally {
        unsubscribe();
      }
    });
  },
);

test("a ready same-Workspace successor keeps only confirmed history readable without rebinding execution", async () => {
  await withFixture(async ({ owned, controller, service, calls }) => {
    const current = await successor(owned, "stopped");
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${current.attemptID}`;
    owned.hub.connected = (attemptID) => attemptID === current.attemptID;
    owned.hub.request = async (attemptID, channel, request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(attemptID).toBe(current.attemptID);
      expect(channel).toBe("agent");
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe(`/api/session/${owned.sessionID}/message`);
      return Response.json({
        data: [
          {
            id: "retained-answer",
            type: "assistant",
            content: [{ type: "text", text: "Saved implementation output" }],
            time: { created: 1 },
          },
        ],
      });
    };
    const before = await savedState(owned);
    expect(await service.get(owned.userID, owned.changeID, false)).toMatchObject({
      state: "starting",
      runtimeState: "ready",
      runtimeConnected: true,
      sessionAvailable: true,
      messagesAvailable: false,
      messages: [],
    });
    expect(calls).toEqual([]);
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      messagesAvailable: true,
      messages: [expect.objectContaining({ text: "Saved implementation output" })],
    });
    expect(calls).toHaveLength(1);
    expect(await savedState(owned)).toEqual(before);
    await owned.database.client`UPDATE factory.change_agent_session
      SET native_session_confirmed_at=NULL WHERE change_id=${owned.changeID}`;
    calls.length = 0;
    const unconfirmed = await savedState(owned);
    const unsubscribe = controller.subscribeActivity(owned.changeID, () => {});
    try {
      expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
        runtimeState: "ready",
        sessionAvailable: false,
        messagesAvailable: false,
        messages: [],
      });
      expect(calls).toEqual([]);
      expect(await savedState(owned)).toEqual(unconfirmed);
    } finally {
      unsubscribe();
    }
  });
});

test("an unselected successor or an inactive Change cannot replace the retained runtime projection", async () => {
  await withFixture(async ({ owned, service, calls }) => {
    const current = await successor(owned, "stopped");
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${current.attemptID}`;
    await owned.database
      .client`UPDATE factory.change SET runtime_attempt_id=${owned.attemptID} WHERE id=${owned.changeID}`;
    expect((await service.get(owned.userID, owned.changeID, false)).runtimeState).toBe("stopped");
    await owned.database.client`UPDATE factory.change SET runtime_attempt_id=${current.attemptID},
      state='cancelled',cancelled_at=now() WHERE id=${owned.changeID}`;
    expect((await service.get(owned.userID, owned.changeID, false)).runtimeState).toBe("stopped");
    expect(calls).toEqual([]);
  });
});
