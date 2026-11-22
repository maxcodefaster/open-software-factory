import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { createCodingContexts } from "../../apps/factory/src/agent/conversation-contexts";
import { createOpenCodeClient } from "../../apps/factory/src/agent/opencode-adapter";
import { createAgentService } from "../../apps/factory/src/agent/service";
import { createSessionArchives } from "../../apps/factory/src/agent/session-archive-store";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import {
  activateCodingContextIn,
  ensureConversationIn,
  insertContextIn,
} from "../../apps/factory/src/conversations/api";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import { createDatabase } from "../../packages/db/src/client";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import upstream from "../../upstream.json";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { memoryPrivateObjects } from "../fixtures/private-objects";

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

async function withArchiveFixture(
  run: (context: {
    owned: Owned;
    controller: ReturnType<typeof createAgentController>;
    service: ReturnType<typeof createAgentService>;
    calls: string[];
    objects: ReturnType<typeof memoryPrivateObjects>;
    objectReads: string[];
    onObjectRead: { current?: () => Promise<void> };
  }) => Promise<void>,
) {
  const objects = memoryPrivateObjects();
  const objectReads: string[] = [];
  const onObjectRead: { current?: () => Promise<void> } = {};
  const storage = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("GET");
      const key = new URL(request.url).pathname.replace(/^\/owned\//, "");
      objectReads.push(key);
      await onObjectRead.current?.();
      const bytes = objects.blobs.get(key);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    },
  });
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    FACTORY_OBJECT_S3_BUCKET: "owned",
    FACTORY_OBJECT_S3_ENDPOINT: storage.url.origin,
    FACTORY_OBJECT_S3_ACCESS_KEY_ID: "owned-controller-test-key",
    FACTORY_OBJECT_S3_SECRET_ACCESS_KEY: "owned-controller-test-secret",
  })) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await withFixture((context) => run({ ...context, objects, objectReads, onObjectRead }));
  } finally {
    storage.stop(true);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function saveCompletedTranscript(
  owned: Owned,
  objects: ReturnType<typeof memoryPrivateObjects>,
  contextID?: string,
) {
  const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
    owned.changeID,
    owned.userID,
    {
      kind: "change-start",
      commandId: crypto.randomUUID(),
      ...(contextID ? { contextId: contextID } : {}),
    },
  );
  const claimed = await createAgentTurnStore(owned.database).claimPending(turn.id);
  if (!claimed) throw Error("Owned archive turn lease is missing");
  const [intent] = await owned.database.client<{ promptID: string; sessionID: string }[]>`
    SELECT prompt_id AS "promptID",session_id AS "sessionID"
    FROM factory.change_agent_turn_intent WHERE turn_id=${turn.id}`;
  if (!intent) throw Error("Owned archive input intent is missing");
  expect(intent.sessionID).toBe(owned.sessionID);
  const promptID = intent.promptID;
  await owned.database.client.begin(async (sql) => {
    await sql`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID}
      WHERE turn_id=${turn.id}`;
    await sql`UPDATE factory.agent_turn SET state='dispatching' WHERE id=${turn.id}`;
    await sql`UPDATE factory.agent_turn SET state='completed',owner_token=NULL,owner_expires_at=NULL WHERE id=${turn.id}`;
    await sql`UPDATE factory.change_agent_session SET state='waiting',active_turn_id=${turn.id}
      WHERE change_id=${owned.changeID}`;
  });
  const client = createOpenCodeClient(async (request, path) => {
    expect(request.method).toBe("GET");
    if (path === "/api/info") return Response.json({ version: upstream.openCode.version });
    expect(path).toContain("/export");
    return Response.json({
      data: {
        info: {
          id: owned.sessionID,
          projectID: "owned",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          location: { directory: "/workspace/project" },
          time: { created: 1, updated: 3 },
        },
        messages: [
          { id: promptID, type: "user", text: "Owned archived bootstrap", time: { created: 1 } },
          {
            id: `${promptID}_answer`,
            type: "assistant",
            finish: "stop",
            agent: "build",
            model: { id: "owned", providerID: "factory" },
            content: [
              { type: "text", text: "Saved current Coding reply" },
              {
                type: "tool",
                name: "shell",
                state: {
                  status: "completed",
                  input: { command: "owned-transcript-check" },
                  content: [{ type: "text", text: "Saved completed check output" }],
                },
                time: { created: 2, completed: 3 },
              },
            ],
            time: { created: 2, completed: 3 },
          },
        ],
      },
    });
  });
  const archives = createSessionArchives(owned.database, () => client, objects);
  await archives.savePending();
  expect(await archives.status(owned.changeID)).toMatchObject({
    latest: { turnID: turn.id, state: "saved" },
    lastSaved: {
      turnID: turn.id,
      sessionID: owned.sessionID,
      runtimeAttemptID: owned.attemptID,
    },
  });
  await owned.database
    .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${owned.attemptID}`;
  return turn.id;
}

test("paused current Coding reads its saved terminal transcript without native work or rebinding", async () => {
  await withArchiveFixture(async ({ owned, service, calls, objects, objectReads }) => {
    const turnID = await saveCompletedTranscript(owned, objects);
    const before = await savedState(owned);
    expect(await service.get(owned.userID, owned.changeID, false)).toMatchObject({
      state: "waiting",
      turn: { id: turnID, state: "completed" },
      runtimeState: "paused",
      messagesAvailable: false,
      messages: [],
      sessionAvailable: true,
    });
    expect(objectReads).toEqual([]);
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      state: "waiting",
      turn: { id: turnID, state: "completed" },
      runtimeState: "paused",
      messagesAvailable: true,
      messages: [
        expect.objectContaining({ role: "assistant", text: "Saved current Coding reply" }),
        expect.objectContaining({
          role: "tool",
          activity: expect.objectContaining({ detail: "Saved completed check output" }),
        }),
      ],
      sessionAvailable: true,
      runtimeConnected: false,
    });
    expect(objectReads.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    expect(await savedState(owned)).toEqual(before);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
  });
});

async function insertCodingContext(owned: Owned, activate = true) {
  const contextID = crypto.randomUUID();
  await owned.database.client.begin(async (sql) => {
    const conversation = await ensureConversationIn(
      sql,
      owned.projectID,
      owned.ticketID,
      owned.userID,
    );
    await sql`UPDATE factory.ticket_conversation SET mode='build' WHERE id=${conversation.id}`;
    await insertContextIn(sql, {
      id: contextID,
      conversationID: conversation.id,
      commandID: crypto.randomUUID(),
      createdBy: owned.userID,
      title: "Owned current Coding context",
      kind: "coding",
      mode: "build",
      changeID: owned.changeID,
      nativeSessionID: owned.sessionID,
    });
    if (activate) await activateCodingContextIn(sql, conversation.id, contextID);
  });
  return contextID;
}

test("paused selected Coding context reads only its exact completed archive", async () => {
  await withArchiveFixture(async ({ owned, service, calls, objects }) => {
    const contextID = await insertCodingContext(owned);
    const turnID = await saveCompletedTranscript(owned, objects, contextID);
    const before = await savedState(owned);
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      turn: { id: turnID, state: "completed" },
      messagesAvailable: true,
      messages: [
        expect.objectContaining({ text: "Saved current Coding reply" }),
        expect.objectContaining({ role: "tool" }),
      ],
    });
    expect(calls).toEqual([]);
    expect(await savedState(owned)).toEqual(before);
  });
});

test("missing or corrupt current Coding archive stays unavailable without changing its recorded outcome", async () => {
  await withArchiveFixture(async ({ owned, service, calls, objects }) => {
    const turnID = await saveCompletedTranscript(owned, objects);
    const before = await savedState(owned);
    const [saved] = await owned.database.client<{ key: string }[]>`
      SELECT manifest_key AS key FROM factory.session_archive WHERE turn_id=${turnID}`;
    if (!saved) throw Error("Owned current checkpoint pointer is missing");
    const manifest = objects.blobs.get(saved.key);
    if (!manifest) throw Error("Owned current checkpoint bytes are missing");
    for (const corrupt of [false, true]) {
      if (corrupt) objects.blobs.set(saved.key, new TextEncoder().encode("corrupt owned manifest"));
      else objects.blobs.delete(saved.key);
      expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
        state: "waiting",
        turn: { id: turnID, state: "completed" },
        messagesAvailable: false,
        messages: [],
        transcriptArchive: { latest: { turnID, state: "saved" } },
      });
      expect(calls).toEqual([]);
      expect(await savedState(owned)).toEqual(before);
    }
    objects.blobs.set(saved.key, manifest);
  });
});

test("a new current Coding context never displays the previous context checkpoint", async () => {
  await withArchiveFixture(async ({ owned, service, calls, objects, objectReads }) => {
    const turnID = await saveCompletedTranscript(owned, objects);
    await owned.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${owned.changeID}`;
    await createCodingContexts(owned.database)(
      owned.changeID,
      owned.userID,
      crypto.randomUUID(),
      null,
      { turn: { id: turnID }, messages: [], messagesAvailable: false },
    );
    const before = await savedState(owned);
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      state: "stopped",
      messagesAvailable: false,
      messages: [],
      transcriptArchive: { latest: { turnID, state: "saved" } },
    });
    expect(objectReads).toEqual([]);
    expect(calls).toEqual([]);
    expect(await savedState(owned)).toEqual(before);
  });
});

test("an earlier saved Coding checkpoint cannot stand in for a later pending or unarchived terminal turn", async () => {
  await withArchiveFixture(async ({ owned, controller, service, calls, objects, objectReads }) => {
    const previousTurnID = await saveCompletedTranscript(owned, objects);
    await owned.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${owned.changeID}`;
    const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-prompt", commandId: crypto.randomUUID(), text: "New unarchived input" },
    );
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      turn: { id: turn.id, state: "pending" },
      messagesAvailable: false,
      messages: [],
    });
    expect(await controller.get(owned.changeID, previousTurnID)).toMatchObject({
      messagesAvailable: false,
      messages: [],
    });
    await createAgentTurnStore(owned.database).claimPending(turn.id);
    await owned.database.client.begin(async (sql) => {
      await sql`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${turn.id}`;
      await sql`UPDATE factory.agent_turn SET state='dispatching' WHERE id=${turn.id}`;
      await sql`UPDATE factory.agent_turn SET state='completed',owner_token=NULL,owner_expires_at=NULL WHERE id=${turn.id}`;
      await sql`UPDATE factory.change_agent_session SET state='waiting',active_turn_id=${turn.id} WHERE change_id=${owned.changeID}`;
    });
    const before = await savedState(owned);
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      turn: { id: turn.id, state: "completed" },
      messagesAvailable: false,
      messages: [],
      transcriptArchive: { latest: { turnID: previousTurnID, state: "saved" } },
    });
    expect(objectReads).toEqual([]);
    expect(calls).toEqual([]);
    expect(await savedState(owned)).toEqual(before);
  });
});

test("current archive history requires the original confirmed Session and separate implementation history stays unavailable", async () => {
  await withArchiveFixture(async ({ owned, service, calls, objects, objectReads }) => {
    await saveCompletedTranscript(owned, objects);
    await owned.database
      .client`UPDATE factory.change_agent_session SET native_session_confirmed_at=NULL WHERE change_id=${owned.changeID}`;
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      messagesAvailable: false,
      messages: [],
      sessionAvailable: false,
    });
    await owned.database
      .client`UPDATE factory.change_agent_session SET native_session_confirmed_at=now(),
      implementation_session_id='ses_owned_other_implementation' WHERE change_id=${owned.changeID}`;
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      messagesAvailable: false,
      messages: [],
    });
    expect(objectReads).toEqual([]);
    expect(calls).toEqual([]);
  });
});

test("Coding context changes during private archive reads cannot publish the previous history as current", async () => {
  await withArchiveFixture(async ({ owned, service, calls, objects, onObjectRead }) => {
    await saveCompletedTranscript(owned, objects);
    const next = await insertCodingContext(owned, false);
    onObjectRead.current = async () => {
      delete onObjectRead.current;
      await owned.database
        .client`UPDATE factory.ticket_conversation SET active_coding_context_id=${next} WHERE ticket_id=${owned.ticketID}`;
    };
    expect(await service.get(owned.userID, owned.changeID)).toMatchObject({
      messagesAvailable: false,
      messages: [],
    });
    expect(calls).toEqual([]);
  });
});

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
