import { expect, test } from "bun:test";
import { type NativeActor, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { CommandError } from "../../apps/factory/src/command-error";
import {
  dispatchActorRPCIn,
  intendActorRPCIn,
  observeActorRPCIn,
} from "../../apps/factory/src/runtime/substrate-rpc-facts";
import type { SubstrateSourceHandoff } from "../../apps/factory/src/workspace/substrate-source";
import { buildModelID } from "../fixtures/change-agent-turns";
import { pinnedOpenCode } from "../fixtures/pinned-opencode";
import { substrateFixture } from "../fixtures/substrate";

test("writer retry settles the confirmed original OpenCode input tree before native teardown without stopping its pending turn", async () => {
  const process = await pinnedOpenCode();
  const f = await substrateFixture("a".repeat(40), "ticket").catch(async (cause) => {
    await process.dispose();
    throw cause;
  });
  try {
    f.config.deployment = "fresh-workspaces";
    const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const childID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const childInput = `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const sourceID = crypto.randomUUID();
    const effects: string[] = [];
    const mutations: string[] = [];
    let actor: NativeActor | null = null;
    const settled = async () => {
      const [session] = await f.database.client`
        SELECT state,stop_pending FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      expect(session).toEqual({ state: "stopped", stop_pending: false });
      for (const id of [sessionID, childID])
        expect(await process.client.session.inbox.list({ sessionID: id })).toEqual([]);
      expect((await process.control()).providerRequests).toBe(0);
      if (!effects.includes("input-tree-settled")) effects.push("input-tree-settled");
    };
    // Controlled Linux Source export/materialization seam only. The real PG
    // Source-transition guards and production lifecycle/input guards stay active.
    // This is controller composition coverage, not native product acceptance.
    const sources: SubstrateSourceHandoff = {
      async attach() {
        throw new Error("Handoff cannot attach a replacement Source");
      },
      async freezeActor(workspaceID, attemptID, sql) {
        expect(workspaceID).toBe(f.workspaceID);
        expect(attemptID).toBe(f.attemptID);
        await settled();
        if (!actor) throw new Error("Original Source Actor is missing");
        const checkpoint = {
          id: sourceID,
          workspaceID,
          actorUID: actor.metadata.uid,
          writerEpoch: 2,
          generation: 1,
          bundle: { version: 1, bytes: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
        };
        await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,
          checkpoint_id=${sourceID} WHERE workspace_id=${workspaceID}`;
        const [frozen] =
          await sql`SELECT workspace_id::text AS "workspaceID",actor_uid::text AS "actorUID",
          owner,writer_epoch::float8 AS "writerEpoch",writable,generation::float8 AS generation,
          checkpoint_id::text AS "checkpointID" FROM factory.substrate_source WHERE workspace_id=${workspaceID}`;
        expect(frozen).toMatchObject({
          workspaceID,
          actorUID: actor.metadata.uid,
          owner: "actor",
          writerEpoch: 2,
          writable: false,
          generation: 0,
          checkpointID: sourceID,
        });
        await sql`UPDATE factory.substrate_source SET generation=1,
          checkpoint=${JSON.stringify(checkpoint)}::text::jsonb WHERE workspace_id=${workspaceID}`;
        effects.push("source-frozen");
      },
      async makeIndependent(workspaceID, sql) {
        expect(workspaceID).toBe(f.workspaceID);
        await settled();
        expect(effects).toContain("SuspendActor");
        // The SQL trigger still requires the original completed durable ROOTFS
        // before this stub can publish independent Source-owner facts.
        await sql`UPDATE factory.substrate_source SET owner='service',writer_epoch=3,
          writable=true,service_base=checkpoint_id,checkpoint_id=NULL
          WHERE workspace_id=${workspaceID}`;
        effects.push("source-independent");
      },
      async resume() {
        throw new Error("Writer fencing cannot resume compute");
      },
      async requireIndependent(workspaceID, actorUID, sql) {
        expect(workspaceID).toBe(f.workspaceID);
        await settled();
        const [source] = await sql`SELECT workspace_id FROM factory.substrate_source
          WHERE workspace_id=${workspaceID} AND actor_uid=${actorUID} AND owner='service'
            AND writable AND generation=1 AND service_base=${sourceID}
            AND checkpoint->>'id'=${sourceID} AND checkpoint->>'actorUID'=${actorUID}`;
        if (!source)
          throw new CommandError("unavailable", "Owned Linux Source handoff stub is unconfirmed");
        effects.push("independent-source-checked");
      },
    };
    // This is the actual RuntimeController, including Coding Stop and the
    // native execution adapter. Only its Substrate RPC transport is controlled.
    const runtime = await f.controller(async (method, request) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "Owned Actor absent");
        return structuredClone(actor);
      }
      if (method === "SuspendActor" && actor) {
        await settled();
        expect(effects).toContain("source-frozen");
        effects.push(method);
        const uuid = crypto.randomUUID();
        actor.metadata.version = "3";
        actor.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: 1,
          snapshots: [
            {
              uuid,
              generation: 1,
              owner: "SNAPSHOT_OWNER_ACTOR",
              fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
              actorTemplateUid: f.config.templateUID,
              sandboxRuntime: f.config.runtime,
              durableSnapshot: {
                state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
                object: {
                  snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
                },
              },
            },
          ],
        };
        return { actor: structuredClone(actor) };
      }
      if (method === "DeleteActor" && actor) {
        await settled();
        expect(effects).toContain("source-independent");
        expect(effects).toContain("independent-source-checked");
        expect(request).toMatchObject({ options: { uid: actor.metadata.uid, version: "3" } });
        effects.push(method);
        actor = null;
        return {};
      }
      throw new Error(`Unexpected writer-handoff lifecycle effect: ${method}`);
    }, sources);
    const original = f.actor();
    actor = original;
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,
        revision,state,parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent,actor_uid,create_attempted_at,observation)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},
          'create-intended',${"b".repeat(64)},now(),${f.userID},
          ${f.atespace},${original.metadata.name},${JSON.stringify({
            ...f.config,
            actorSelector: f.config.workerSelector,
            environment: { version: 0, secretKey: null },
            declaredApps: ["app"],
            egressHosts: f.config.egressHosts ?? [],
          })}::text::jsonb,${original.metadata.uid},${original.metadata.createTime},${JSON.stringify(original)}::text::jsonb)`;
      const resume = await intendActorRPCIn(sql, f.attemptID, "resume", null, original);
      await dispatchActorRPCIn(sql, f.attemptID, resume);
      original.metadata.version = "2";
      original.status = {
        state: "ACTOR_STATE_RUNNING",
        lastAssignedGeneration: 0,
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      await sql`UPDATE factory.runtime_attempt SET observation=${JSON.stringify(original)}::text::jsonb
        WHERE id=${f.attemptID}`;
      await observeActorRPCIn(sql, f.attemptID, resume, original);
      await sql`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${f.workspaceID},${original.metadata.uid})`;
    });
    for (const [id, parentID] of [
      [sessionID, undefined],
      [childID, sessionID],
    ] as const) {
      await process.client.session.create({
        id,
        title: "Owned queued writer handoff",
        ...(parentID ? { parentID } : {}),
        location: { directory: "/workspace/project" },
        model: { providerID: "factory", id: buildModelID },
      });
      await process.client.session.switchAgent({ sessionID: id, agent: "build" });
    }
    expect((await process.client.session.get({ sessionID: childID })).parentID).toBe(sessionID);
    const turns = createAgentTurnStore(f.database);
    const [approval] = await f.database.client<{ revision: string }[]>`
      SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
    if (!approval) throw new Error("Owned approval missing");
    const admit = async (assigned: boolean) => {
      const text = assigned ? "Owned original queued input" : "Owned newly commissioned retry";
      const { turn } = await turns.admit(
        {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          projectId: f.projectID,
          ticketId: f.ticketID,
          changeId: f.changeID,
          createdBy: f.userID,
          conversationId: null,
          text,
        },
        {
          mode: "build",
          modelId: buildModelID,
          skillRevisionIds: [],
          requiredSkillRevisionIds: [],
          conversationVersion: null,
          requirementRevisionId: approval.revision,
        },
        (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
      );
      const promptID = `msg_owned_${turn.id.replaceAll("-", "")}`;
      await f.database.client`INSERT INTO factory.change_agent_turn_intent(
        turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id)
        VALUES(${turn.id},${f.changeID},${sessionID},${promptID},${text},false,
          'Owned confirmed Session',${assigned ? f.attemptID : null})`;
      return { turn, promptID, text };
    };
    const previous = await admit(true);
    const previousLease = await turns.claimPending(previous.turn.id);
    if (!previousLease?.ownerToken) throw new Error("Owned original turn lease missing");
    expect(await turns.beginDispatch(previous.turn.id, previousLease.ownerToken)).not.toBeNull();
    expect(
      await turns.settle(
        previous.turn.id,
        previousLease.ownerToken,
        "failed",
        "Owned previous failure with queued input",
      ),
    ).toBe(true);
    await f.database.client`INSERT INTO factory.change_agent_session(
      change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,
      native_session_confirmed_at,implementation_session_id,implementation_session_confirmed_at)
      VALUES(${f.changeID},${f.attemptID},${sessionID},'failed',${f.userID},${previous.turn.id},
        now(),${sessionID},now())`;
    for (const [id, promptID, text] of [
      [sessionID, previous.promptID, previous.text],
      [childID, childInput, "Owned child input must never execute"],
    ] as const) {
      await process.client.session.prompt({
        sessionID: id,
        id: promptID,
        text,
        delivery: "queue",
        resume: false,
      });
      expect(
        (await process.client.session.inbox.list({ sessionID: id })).map((input) => input.id),
      ).toEqual([promptID]);
    }
    expect((await process.control()).providerRequests).toBe(0);
    const retry = await admit(false);
    const pending = await turns.claimPending(retry.turn.id, 60_000);
    if (!pending?.ownerToken) throw new Error("Owned retry lease missing");
    const [preparing] = await f.database.client`
      SELECT state,turn_id,fence_required,fence_attempt_id FROM factory.change_writer WHERE change_id=${f.changeID}`;
    expect(preparing).toMatchObject({
      state: "agent-preparing",
      turn_id: retry.turn.id,
      fence_required: true,
      fence_attempt_id: f.attemptID,
    });
    f.hub.connected = (attemptID) => attemptID === f.attemptID && actor !== null;
    f.hub.request = async (attemptID, channel, request, path, beforeSend) => {
      expect(attemptID).toBe(f.attemptID);
      expect(channel).toBe("agent");
      let sent = !beforeSend;
      await beforeSend?.(() => {
        sent = true;
      });
      if (!sent) throw new Error("Original input Stop frame was not authorized");
      if (!["GET", "HEAD"].includes(request.method)) mutations.push(`${request.method} ${path}`);
      return process.transport(request, path);
    };
    const writers = createChangeWriterController({
      database: f.database,
      runtime,
      agentUsername: "owned-control",
      async stopAgent() {
        throw new Error("Preparing the admitted retry must use Runtime Stop, not user Stop");
      },
      async protect() {},
    });
    const outcome = await writers.prepareAgent(f.changeID, retry.turn.id).then(
      (prepared) => ({ prepared }),
      (cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
    const retainedRetry = await turns.get(retry.turn.id);
    console.info("Owned confirmed-input writer handoff", {
      outcome,
      retryState: retainedRetry?.state,
      rootQueued: (await process.client.session.inbox.list({ sessionID })).map((input) => input.id),
      childQueued: (await process.client.session.inbox.list({ sessionID: childID })).map(
        (input) => input.id,
      ),
      providerRequests: (await process.control()).providerRequests,
      effects,
    });
    expect(retainedRetry?.state).toBe("pending");
    expect(retainedRetry?.ownerToken).toBe(pending.ownerToken);
    expect(retainedRetry?.ownerExpiresAt).toEqual(pending.ownerExpiresAt);
    expect(outcome).toEqual({ prepared: true });
    expect(await turns.validateExecution(retry.turn.id, pending.ownerToken)).toBe(true);
    await settled();
    expect(mutations).toContain(`DELETE /api/session/${sessionID}/inbox/${previous.promptID}`);
    expect(mutations).toContain(`DELETE /api/session/${childID}/inbox/${childInput}`);
    expect(mutations).not.toContain(`DELETE /api/session/${sessionID}/inbox/${retry.promptID}`);
    expect(effects).toEqual([
      "input-tree-settled",
      "source-frozen",
      "SuspendActor",
      "source-independent",
      "independent-source-checked",
      "DeleteActor",
    ]);
    expect((await turns.get(previous.turn.id))?.state).toBe("failed");
    const [session] = await f.database.client`
      SELECT stop_turn_id,runtime_attempt_id,opencode_session_id,stop_pending,
        native_session_confirmed_at IS NOT NULL AS confirmed,
        implementation_session_confirmed_at IS NOT NULL AS reused
      FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
    expect(session).toMatchObject({
      stop_turn_id: previous.turn.id,
      runtime_attempt_id: f.attemptID,
      opencode_session_id: sessionID,
      stop_pending: false,
      confirmed: true,
      reused: true,
    });
    const [intent] = await f.database.client`
      SELECT runtime_attempt_id FROM factory.change_agent_turn_intent WHERE turn_id=${retry.turn.id}`;
    expect(intent).toEqual({ runtime_attempt_id: null });
    const [stopped] = await f.database.client`
      SELECT state,actor_uid,deleted_at IS NOT NULL AS deleted
      FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(stopped).toEqual({ state: "stopped", actor_uid: original.metadata.uid, deleted: true });
  } finally {
    try {
      await f.dispose();
    } finally {
      await process.dispose();
    }
  }
}, 60_000);
