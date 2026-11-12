import { expect, test } from "bun:test";
import { createOpenCodeClient } from "../../apps/factory/src/agent/opencode-client";
import { createCodingContexts } from "../../apps/factory/src/agent/conversation-contexts";
import { createSessionArchives } from "../../apps/factory/src/agent/session-archive-store";
import { readNativeSessionArchive } from "../../apps/factory/src/agent/session-archive";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { ensureConversationIn } from "../../apps/factory/src/project-agent/conversation-store";
import { fixture } from "../fixtures/change-agent-turns";
import { observe } from "../fixtures/pinned-opencode";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { substrateFixture } from "../fixtures/substrate";

test("archive failure is independent of turn/commit settlement and retries retain the last good checkpoint", async () => {
  const owned = await fixture();
  const objects = memoryPrivateObjects();
  let fail = true;
  const client = createOpenCodeClient(async (_request, path) => {
    if (path === "/api/info") return Response.json({ version: "2.0.27" });
    const intents = await owned.database.client<
      { sessionID: string; promptID: string; text: string }[]
    >`
      SELECT session_id AS "sessionID",prompt_id AS "promptID",prompt_text AS text
      FROM factory.change_agent_turn_intent WHERE change_id=${owned.changeID} ORDER BY created_at,turn_id`;
    return Response.json({
      data: {
        info: {
          id: intents[0]?.sessionID,
          projectID: "owned",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          location: { directory: "/workspace/project" },
          time: { created: 1, updated: 2 },
        },
        messages: intents.flatMap((intent, index) => [
          {
            id: intent.promptID,
            type: "user",
            text: intent.text,
            time: { created: index * 3 + 1 },
          },
          {
            id: `${intent.promptID}_result`,
            type: "assistant",
            finish: "stop",
            agent: "build",
            model: { id: "owned", providerID: "factory" },
            content: [],
            time: { created: index * 3 + 2, completed: index * 3 + 3 },
          },
        ]),
      },
    });
  });
  const archives = createSessionArchives(owned.database, () => client, {
    ...objects,
    put: async (...args) => {
      if (fail) throw new Error("Owned archive write failure");
      await objects.put(...args);
    },
  });
  async function complete(text: string) {
    const commandID = crypto.randomUUID();
    owned.finish();
    const controller = owned.controller();
    await controller.prompt(owned.changeID, text, owned.userID, commandID);
    owned.release();
    await observe(
      () => owned.turn(commandID),
      (turn) => turn?.state === "completed",
    );
    await observe(
      () => controller.get(owned.changeID),
      (view) => view.state === "committed",
    );
    const turn = await owned.turn(commandID);
    if (!turn) throw new Error("Completed owned turn missing");
    return turn.id;
  }
  try {
    const firstID = await complete("First owned checkpoint");
    const commits = await owned.database
      .client`SELECT state FROM factory.change_commit_operation WHERE id=${firstID}`;
    expect(commits[0]?.["state"]).toBe("succeeded");
    await owned.database
      .client`UPDATE factory.session_archive SET retry_after=now() WHERE state<>'saved'`;
    await archives.savePending();
    expect(await archives.status(owned.changeID)).toMatchObject({
      latest: { turnID: firstID, state: "failed" },
      lastSaved: null,
    });
    const original = await owned.database
      .client`SELECT id, factorybox_worker_id, factorybox_admission_id FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    fail = false;
    await owned.database
      .client`UPDATE factory.session_archive SET retry_after=now() WHERE state<>'saved'`;
    await archives.savePending();
    const good = await archives.status(owned.changeID);
    expect(good.latest).toMatchObject({ turnID: firstID, state: "saved" });
    expect(good.lastSaved?.turnID).toBe(firstID);
    expect(objects.blobs.size).toBeGreaterThan(0);
    await expect(
      Promise.resolve(
        owned.database
          .client`UPDATE factory.session_archive SET session_id='different' WHERE turn_id=${firstID}`,
      ),
    ).rejects.toThrow("immutable");
    await expect(
      Promise.resolve(
        owned.database.client`DELETE FROM factory.session_archive WHERE turn_id=${firstID}`,
      ),
    ).rejects.toThrow("immutable");
    fail = true;
    const secondID = await complete("Second owned checkpoint");
    await owned.database
      .client`UPDATE factory.session_archive SET retry_after=now() WHERE state<>'saved'`;
    await archives.savePending();
    expect(await archives.status(owned.changeID)).toMatchObject({
      latest: { turnID: secondID, state: "failed" },
      lastSaved: { turnID: firstID },
    });
    expect(
      await owned.database
        .client`SELECT id, factorybox_worker_id, factorybox_admission_id FROM factory.runtime_attempt WHERE id=${owned.attemptID}`,
    ).toEqual(original);
    const data = await owned.database.client<
      { bytes: number }[]
    >`SELECT octet_length(summary::text) AS bytes FROM factory.session_archive WHERE turn_id=${firstID}`;
    expect(data[0]?.bytes).toBeLessThan(16384);
    expect(owned.requests()).toBe(2);
    const status = await owned.controller().get(owned.changeID);
    expect(status.transcriptArchive.lastSaved?.turnID).toBe(firstID);
  } finally {
    await owned.dispose();
  }
}, 60_000);

test("native transcript checkpoint retains pinned recovery references without copying provisioning credentials or claiming turn-atomic Source", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const objects = memoryPrivateObjects();
  const image = `registry.test/native@sha256:${"d".repeat(64)}`;
  const actorUID = crypto.randomUUID();
  const checkpointID = crypto.randomUUID();
  try {
    const [approval] = await f.database.client<{ revision: string }[]>`
      SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
    if (!approval) throw new Error("Owned approval fixture missing");
    const turns = createAgentTurnStore(f.database);
    const { turn } = await turns.admit(
      {
        kind: "change-start",
        commandId: crypto.randomUUID(),
        projectId: f.projectID,
        ticketId: f.ticketID,
        changeId: f.changeID,
        createdBy: f.userID,
        conversationId: null,
      },
      {
        mode: "build",
        modelId: "factory-coding-model",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
        conversationVersion: null,
        requirementRevisionId: approval.revision,
      },
    );
    const leased = await turns.claimPending(turn.id);
    if (!leased?.ownerToken) throw new Error("Owned turn lease missing");
    const sessionID = `ses_owned_${turn.id.replaceAll("-", "")}`;
    const promptID = `msg_owned_${turn.id.replaceAll("-", "")}`;
    const intent = {
      ...f.config,
      connection: { ...f.config.connection, tokenFile: "/must-never-archive-editor-credential" },
    };
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},${JSON.stringify({ configuration: { workloadImage: image, provisioner: { tokenFile: "/must-never-archive-owner-credential" } } })}::jsonb)`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID},true,NULL,NULL)`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},${JSON.stringify(intent)}::jsonb,${actorUID},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id) VALUES(${turn.id},${f.changeID},${sessionID},${promptID},'Owned checkpoint',true,'Owned native archive',${f.attemptID})`;
      await sql`UPDATE factory.agent_turn SET state='dispatching' WHERE id=${turn.id}`;
      await sql`UPDATE factory.agent_turn SET state='completed',owner_token=NULL,owner_expires_at=NULL WHERE id=${turn.id}`;
      await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid) VALUES(${f.workspaceID},${actorUID})`;
      await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${checkpointID} WHERE workspace_id=${f.workspaceID}`;
      await sql`UPDATE factory.substrate_source SET generation=1,checkpoint=${JSON.stringify({
        id: checkpointID,
        workspaceID: f.workspaceID,
        actorUID,
        writerEpoch: 2,
        generation: 1,
        bundle: { version: 1, bytes: 1024, sha256: "e".repeat(64), chunks: ["e".repeat(64)] },
      })}::jsonb WHERE workspace_id=${f.workspaceID}`;
    });
    let exports = 0;
    const client = createOpenCodeClient(async (request, path) => {
      if (path === "/api/info") return Response.json({ version: "2.0.27" });
      expect(request.method).toBe("GET");
      expect(path).toContain("/export");
      exports++;
      return Response.json({
        data: {
          info: {
            id: sessionID,
            projectID: "owned",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            location: { directory: "/workspace/project" },
            time: { created: 1, updated: 3 },
          },
          messages: [
            { id: promptID, type: "user", text: "Owned checkpoint", time: { created: 1 } },
            {
              id: `${promptID}_result`,
              type: "assistant",
              finish: "stop",
              agent: "build",
              model: { id: "owned", providerID: "factory" },
              content: [
                { type: "text", text: "Owned completed checkpoint reply" },
                {
                  type: "tool",
                  name: "shell",
                  state: {
                    status: "completed",
                    input: { command: "owned-check" },
                    content: [{ type: "text", text: "Owned completed tool result" }],
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
    const archives = createSessionArchives(f.database, () => client, objects);
    await archives.savePending();
    const [saved] = await f.database.client<
      {
        state: string;
        key: string;
        sha256: string;
        source: Record<string, unknown>;
      }[]
    >`SELECT state,manifest_key AS key,manifest_sha256 AS sha256,source_refs AS source FROM factory.session_archive WHERE turn_id=${turn.id}`;
    expect(saved?.state).toBe("saved");
    if (!saved) throw new Error("Owned native archive missing");
    expect(saved.source["runtimeArtifacts"]).toBe(image);
    expect(saved.source["nativeRuntime"]).toEqual({
      engine: "substrate",
      profile: f.config.profile,
      runtime: f.config.runtime,
      actorUID,
      templateUID: f.config.templateUID,
      templateSHA256: f.config.templateSHA256,
    });
    expect(saved.source["lastConfirmedSource"]).toEqual({
      id: checkpointID,
      generation: 1,
      writerEpoch: 2,
      bundleSHA256: "e".repeat(64),
      manifestKey: `workspace-source/v1/${f.workspaceID}/${checkpointID}/manifest.json`,
      relationship: "last-confirmed-generation-not-turn-atomic",
    });
    expect(saved.source["workerID"]).toBeNull();
    expect(saved.source["admissionID"]).toBeNull();
    expect(JSON.stringify(saved.source)).not.toContain("must-never-archive");
    expect(
      (await readNativeSessionArchive(objects, saved.key, saved.sha256)).manifest.source,
    ).toEqual(saved.source);
    expect(exports).toBe(1);
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    const conversationID = await f.database.client.begin(async (sql) => {
      const conversation = await ensureConversationIn(sql, f.projectID, f.ticketID, f.userID);
      await sql`UPDATE factory.ticket_conversation SET mode='build' WHERE id=${conversation.id}`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at) VALUES(${f.changeID},${f.attemptID},${sessionID},'committed',${f.userID},${turn.id},now())`;
      return conversation.id;
    });
    const next = await createCodingContexts(f.database)(
      f.changeID,
      f.userID,
      crypto.randomUUID(),
      null,
      { turn: { id: turn.id }, messages: [], messagesAvailable: false },
    );
    const [context] = await f.database.client<{ id: string }[]>`
      SELECT id FROM factory.conversation_context WHERE conversation_id=${conversationID} AND original`;
    if (!context) throw new Error("Owned archived context missing");
    const history = await archives.retainedMessages(context.id);
    expect(history?.messagesAvailable).toBe(true);
    expect(history?.messages).toEqual([
      expect.objectContaining({ role: "assistant", text: "Owned completed checkpoint reply" }),
      expect.objectContaining({
        role: "tool",
        activity: expect.objectContaining({ detail: "Owned completed tool result" }),
      }),
    ]);
    expect(await archives.retainedMessages(next)).toBeUndefined();
    expect(await archives.retainedMessages(crypto.randomUUID())).toBeUndefined();
    expect(exports).toBe(1); // Private history read sent no native request or prompt.
    const manifestBytes = objects.blobs.get(saved.key);
    if (!manifestBytes) throw new Error("Owned manifest bytes missing");
    objects.blobs.set(saved.key, new TextEncoder().encode("corrupt owned archive"));
    await expect(archives.retainedMessages(context.id)).rejects.toThrow("checksum differs");
    objects.blobs.set(saved.key, manifestBytes);
  } finally {
    await f.dispose();
  }
}, 60_000);
