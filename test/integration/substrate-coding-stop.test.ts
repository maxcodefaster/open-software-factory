import { expect, test } from "bun:test";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { requireStoppedAgentInputsIn } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { substrateActorSelector } from "../../apps/factory/src/runtime/substrate";
import {
  actorRPCIn,
  dispatchActorRPCIn,
  intendActorRPCIn,
  observeActorRPCIn,
} from "../../apps/factory/src/runtime/substrate-rpc-facts";
import type { SubstrateSourceHandoff } from "../../apps/factory/src/workspace/substrate-source";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { buildModelID } from "../fixtures/change-agent-turns";
import { nativeInstallationFixture } from "../fixtures/native-installation";
import { pinnedOpenCode } from "../fixtures/pinned-opencode";
import { substrateFixture } from "../fixtures/substrate";

test("native teardown refuses unresolved Coding, including a pending Stop with no identifiable input", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const actorUID = crypto.randomUUID();
  let nativeCalls = 0;
  try {
    await f.database.client`INSERT INTO factory.substrate_workspace(workspace_id,generation,intent)
      VALUES(${f.workspaceID},1,${JSON.stringify({ configuration: { connection: f.config.connection } })}::jsonb)`;
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at)
        VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},
          ${JSON.stringify({ ...f.config, actorSelector: substrateActorSelector("owned-native-secret", f.attemptID) })}::jsonb,${actorUID},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by)
        VALUES(${f.changeID},${f.attemptID},'ses_owned_unresolved','working',${f.userID})`;
    });
    const call = async () => {
      nativeCalls++;
      throw new Error("Unsettled input must not call Substrate");
    };
    await expect(f.execution(call).stop()).rejects.toThrow("queued work");
    const config = nativeInstallationFixture();
    const runtime = createRuntimeController(f.database, f.hub, "owned-native-secret", {
      configuration: { ...config, database: f.config.database, connection: f.config.connection },
      call,
    });
    await expect(runtime.stop(f.attemptID)).rejects.toThrow("queued work");
    const [session] = await f.database
      .client`SELECT state,stop_pending,stop_turn_id FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
    expect(session).toMatchObject({ state: "stopped", stop_pending: true, stop_turn_id: null });
    // Neither paused nor stopped compute can supply the missing native proof.
    for (const state of ["paused", "stopped"]) {
      await f.database
        .client`UPDATE factory.runtime_attempt SET state=${state} WHERE id=${f.attemptID}`;
      await expect(requireStoppedAgentInputsIn(f.database.client, f.attemptID)).rejects.toThrow(
        "queued work",
      );
    }
    expect(nativeCalls).toBe(0);
    const [binding] = await f.database
      .client`SELECT actor_uid,delete_intended_at,deleted_at FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
    expect(binding).toEqual({ actor_uid: actorUID, delete_intended_at: null, deleted_at: null });
  } finally {
    await f.dispose();
  }
}, 60_000);

test.each([false, true])(
  "Compute Stop requires the real native input tree before snapshot/Delete: unknown root input=%s",
  async (unknownRootInput) => {
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
      const effects: string[] = [];
      let actor: NativeActor | null = null;
      let independent = false;
      const settled = async () => {
        const [session] = await f.database
          .client`SELECT state,stop_pending FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
        expect(session).toEqual({ state: "stopped", stop_pending: false });
        expect(await process.client.session.inbox.list({ sessionID: childID })).toEqual([]);
        expect((await process.control()).providerRequests).toBe(0);
      };
      const sources: SubstrateSourceHandoff = {
        async attach() {},
        async freezeActor() {
          await settled();
          effects.push("source-drain");
        },
        async paused() {
          independent = true;
          effects.push("source-independent");
        },
        async resume() {
          throw new Error("Stop cannot wake another runtime");
        },
        async requireIndependent() {
          expect(independent).toBe(true);
        },
      };
      const runtime = await f.controller(async (method, request) => {
        effects.push(method);
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") return f.template;
        if (method === "GetActor") {
          if (!actor) throw new SubstrateRPCError("NotFound", "Owned Actor absent");
          return structuredClone(actor);
        }
        if (method === "SuspendActor" && actor) {
          await settled();
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
          expect(independent).toBe(true);
          expect(request).toMatchObject({ options: { uid: actor.metadata.uid, version: "3" } });
          actor = null;
          return {};
        }
        throw new Error(`Unexpected lifecycle effect: ${method}`);
      }, sources);
      const ownedActor = f.actor();
      actor = ownedActor;
      const actorUID = actor.metadata.uid;
      const bound = {
        ...f.config,
        environment: { version: 0, secretKey: null },
        declaredApps: ["app"],
        egressHosts: f.config.egressHosts ?? [],
        actorSelector: f.config.workerSelector,
      };
      await f.database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},${f.config.generation},${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
        await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at,observation)
          VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},${JSON.stringify(bound)}::jsonb,${actorUID},now()-interval '1 second',${JSON.stringify(ownedActor)}::jsonb)`;
        // Seed the completed initial Resume before testing Stop on this running Actor.
        const resume = await intendActorRPCIn(sql, f.attemptID, "resume", null, ownedActor);
        await dispatchActorRPCIn(sql, f.attemptID, resume);
        ownedActor.metadata.version = "2";
        ownedActor.status = {
          state: "ACTOR_STATE_RUNNING",
          lastAssignedGeneration: 0,
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        await sql`UPDATE factory.substrate_binding SET observation=${JSON.stringify(ownedActor)}::jsonb
          WHERE runtime_attempt_id=${f.attemptID}`;
        await observeActorRPCIn(sql, f.attemptID, resume, ownedActor);
        await sql`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
        await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,native_session_confirmed_at,created_by)
        VALUES(${f.changeID},${f.attemptID},${sessionID},'working',now(),${f.userID})`;
      });
      expect(await actorRPCIn(f.database.client, f.attemptID, "resume", "initial")).toEqual({
        action: "resume",
        originKey: "initial",
        actorUID,
        nativeVersion: "1",
        stopID: null,
        attempted: true,
        outcome: { actorUID, version: "2", state: "ACTOR_STATE_RUNNING" },
      });
      for (const [id, parentID] of [
        [sessionID, undefined],
        [childID, sessionID],
      ] as const) {
        await process.client.session.create({
          id,
          title: "Owned Compute Stop",
          ...(parentID ? { parentID } : {}),
          location: { directory: "/workspace/project" },
          model: { providerID: "factory", id: buildModelID },
        });
        await process.client.session.switchAgent({ sessionID: id, agent: "build" });
      }
      let failedTurnID: string | undefined;
      if (!unknownRootInput) {
        const [approval] = await f.database.client<{ revision: string }[]>`
        SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
        if (!approval) throw new Error("Owned approval missing");
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
            modelId: buildModelID,
            skillRevisionIds: [],
            requiredSkillRevisionIds: [],
            conversationVersion: null,
            requirementRevisionId: approval.revision,
          },
          (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
        );
        failedTurnID = turn.id;
        const promptID = `msg_owned_failed_${turn.id.replaceAll("-", "")}`;
        const claimed = await turns.claimPending(turn.id);
        if (!claimed?.ownerToken) throw new Error("Owned failed turn lease missing");
        await turns.beginDispatch(turn.id, claimed.ownerToken);
        expect(
          await turns.settle(turn.id, claimed.ownerToken, "failed", "Owned prior failure"),
        ).toBe(true);
        await f.database.client.begin(async (sql) => {
          await sql`INSERT INTO factory.change_agent_turn_intent(
          turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id)
          VALUES(${turn.id},${f.changeID},${sessionID},${promptID},'Owned failed queued input',false,'Owned Compute Stop',${f.attemptID})`;
          await sql`UPDATE factory.change_agent_session SET state='failed',active_turn_id=${turn.id} WHERE change_id=${f.changeID}`;
        });
        await process.client.session.prompt({
          sessionID,
          id: promptID,
          text: "Cancel the exact input of the already failed turn",
          delivery: "queue",
          resume: false,
        });
      }
      await process.client.session.prompt({
        sessionID: childID,
        id: childInput,
        text: "Never execute this queued child",
        delivery: "queue",
        resume: false,
      });
      const unknownInput = `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`;
      if (unknownRootInput)
        await process.client.session.prompt({
          sessionID,
          id: unknownInput,
          text: "An unassigned root input must not be discarded",
          delivery: "queue",
          resume: false,
        });
      f.hub.connected = () => true;
      f.hub.request = async (_attempt, channel, request, path, beforeSend) => {
        expect(channel).toBe("agent");
        let sent = !beforeSend;
        await beforeSend?.(() => {
          sent = true;
        });
        if (!sent) throw new Error("Native Stop frame was not authorized");
        return process.transport(request, path);
      };
      if (unknownRootInput) {
        await expect(runtime.stop(f.attemptID)).rejects.toThrow("queued work");
        expect(effects).toEqual([]);
        expect(
          (await process.client.session.inbox.list({ sessionID })).map((item) => item.id),
        ).toEqual([unknownInput]);
        const [saved] = await f.database
          .client`SELECT state,stop_intended_at FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
        expect(saved).toEqual({ state: "ready", stop_intended_at: null });
        expect((await process.control()).providerRequests).toBe(0);
        return;
      }
      expect((await runtime.stop(f.attemptID))?.state).toBe("stopped");
      expect(effects.indexOf("source-drain")).toBeLessThan(effects.indexOf("SuspendActor"));
      expect(effects.indexOf("source-independent")).toBeLessThan(effects.indexOf("DeleteActor"));
      expect(effects).not.toContain("CreateActor");
      expect(effects).not.toContain("ResumeActor");
      expect((await process.control()).providerRequests).toBe(0);
      if (failedTurnID) {
        const [turn] = await f.database
          .client`SELECT state,outcome_summary FROM factory.agent_turn WHERE id=${failedTurnID}`;
        expect(turn).toEqual({ state: "failed", outcome_summary: "Owned prior failure" });
        const [session] = await f.database
          .client`SELECT stop_turn_id FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
        expect(session?.["stop_turn_id"]).toBe(failedTurnID);
      }
    } finally {
      await f.dispose();
      await process.dispose();
    }
  },
  60_000,
);
