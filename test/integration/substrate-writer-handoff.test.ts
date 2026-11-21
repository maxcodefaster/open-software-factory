import { expect, test } from "bun:test";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import {
  dispatchActorRPCIn,
  intendActorRPCIn,
  observeActorRPCIn,
} from "../../apps/factory/src/runtime/substrate-rpc-facts";
import type { SubstrateSourceHandoff } from "../../apps/factory/src/workspace/substrate-source";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test.each(["complete", "stop-during-cleanup", "committed-stopped"] as const)(
  "native writer handoff preserves the new Coding retry and explicit Stop semantics: %s",
  async (action) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    let actor: NativeActor | null = null;
    const effects: string[] = [];
    const sources: SubstrateSourceHandoff = {
      async attach() {},
      async freezeActor() {},
      async paused() {},
      async resume() {
        throw Error("Fencing cannot resume compute");
      },
      async requireIndependent() {
        effects.push("independent-source");
      },
    };
    try {
      f.config.deployment = "fresh-workspaces";
      const runtime = await f.controller(async (method) => {
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") return f.template;
        if (method === "GetActor") {
          if (!actor) throw new SubstrateRPCError("NotFound", "Owned Actor absent");
          return structuredClone(actor);
        }
        if (method === "DeleteActor") {
          effects.push(method);
          actor = null;
          return {};
        }
        throw Error(`Unexpected handoff lifecycle operation: ${method}`);
      }, sources);
      const initial = f.actor();
      actor = initial;
      await f.database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,
        revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},
          'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID})`;
        await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,
        actor_uid,create_attempted_at,observation)
        VALUES(${f.attemptID},${f.atespace},${initial.metadata.name},
          ${JSON.stringify({
            ...f.config,
            actorSelector: f.config.workerSelector,
            egressHosts: f.config.egressHosts ?? [],
            environment: { version: 0, secretKey: null },
            declaredApps: ["app"],
          })}::jsonb,
          ${initial.metadata.uid},${initial.metadata.createTime},${JSON.stringify(initial)}::jsonb)`;
        const resume = await intendActorRPCIn(sql, f.attemptID, "resume", null, initial);
        await dispatchActorRPCIn(sql, f.attemptID, resume);
        initial.metadata.version = "3";
        initial.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        await sql`UPDATE factory.substrate_binding SET observation=${JSON.stringify(initial)}::jsonb
        WHERE runtime_attempt_id=${f.attemptID}`;
        await observeActorRPCIn(sql, f.attemptID, resume, initial);
        const pause = await intendActorRPCIn(sql, f.attemptID, "suspend", null, initial);
        await dispatchActorRPCIn(sql, f.attemptID, pause);
        const uuid = crypto.randomUUID();
        const checkpoint = {
          uuid,
          actorUID: initial.metadata.uid,
          generation: 1,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: f.config.templateUID,
          sandboxRuntime: f.config.runtime,
          durableSnapshot: {
            state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
            object: {
              snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${initial.metadata.uid}/snapshots/${uuid}`,
            },
          },
        };
        initial.metadata.version = "5";
        initial.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: 1,
          snapshots: [checkpoint],
        };
        await sql`UPDATE factory.substrate_binding SET observation=${JSON.stringify(initial)}::jsonb,
        checkpoint=${JSON.stringify(checkpoint)}::jsonb WHERE runtime_attempt_id=${f.attemptID}`;
        await observeActorRPCIn(sql, f.attemptID, pause, initial, checkpoint);
        await sql`UPDATE factory.runtime_attempt SET state='paused',ready_at=now() WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
        const sourceID = crypto.randomUUID();
        const sourceCheckpoint = {
          id: sourceID,
          workspaceID: f.workspaceID,
          actorUID: initial.metadata.uid,
          writerEpoch: 2,
          generation: 1,
          bundle: { version: 1, bytes: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
        };
        // Controlled Source-owner facts at this composition seam. Linux export,
        // object verification and materialization have their separate coverage.
        await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${f.workspaceID},${initial.metadata.uid})`;
        await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${sourceID}
        WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET generation=1,checkpoint=${JSON.stringify(sourceCheckpoint)}::jsonb
        WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET owner='service',writable=true,writer_epoch=3,
        service_base=${sourceID},checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
      });
      const turns = createAgentTurnStore(f.database);
      const [approval] = await f.database.client<{ revision: string }[]>`
      SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
      if (!approval) throw Error("Owned approval missing");
      const sessionID = `ses_owned_${f.changeID.replaceAll("-", "")}`;
      const admit = async (assigned: boolean) => {
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
            modelId: "owned-handoff",
            skillRevisionIds: [],
            requiredSkillRevisionIds: [],
            conversationVersion: null,
            requirementRevisionId: approval.revision,
          },
          (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
        );
        await f.database.client`INSERT INTO factory.change_agent_turn_intent(
        turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id)
        VALUES(${turn.id},${f.changeID},${sessionID},${`msg_owned_${turn.id.replaceAll("-", "")}`},
          'Owned bootstrap',true,'Owned handoff',${assigned ? f.attemptID : null})`;
        return turn;
      };
      const previous = await admit(true);
      const claimed = await turns.claimPending(previous.id);
      if (!claimed?.ownerToken) throw Error("Owned previous lease missing");
      const writers = createChangeWriterController({
        database: f.database,
        runtime,
        agentUsername: "owned-control",
        async stopAgent() {
          throw Error("Retry fencing is not a user Stop");
        },
        async protect() {},
      });
      if (action === "committed-stopped") {
        expect(await writers.prepareAgent(f.changeID, previous.id)).toBe(true);
        await turns.beginDispatch(previous.id, claimed.ownerToken);
        await turns.settle(previous.id, claimed.ownerToken, "completed", "Owned input completed");
      } else
        expect(
          await turns.failPending(previous.id, claimed.ownerToken, "Owned startup failure"),
        ).toBe(true);
      await f.database.client`INSERT INTO factory.change_agent_session(
      change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id)
      VALUES(${f.changeID},${f.attemptID},${sessionID},
        ${action === "committed-stopped" ? "committed" : "failed"},${f.userID},${previous.id})`;
      if (action === "committed-stopped") {
        await f.database
          .client`UPDATE factory.change_agent_session SET native_session_confirmed_at=now()
          WHERE change_id=${f.changeID}`;
        expect((await runtime.stop(f.attemptID))?.state).toBe("stopped");
        await f.database.client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},
          turn_id=NULL,epoch=epoch+1 WHERE change_id=${f.changeID}`;
      }
      const retry = await admit(false);
      let pending = await turns.claimPending(retry.id);
      if (!pending?.ownerToken) throw Error("Owned retry lease missing");
      const [writer] = await f.database.client<{ epoch: string }[]>`
      SELECT epoch::text AS epoch FROM factory.change_writer WHERE change_id=${f.changeID}`;
      if (!writer) throw Error("Owned pending writer missing");
      if (action === "committed-stopped") {
        const before = await f.database.client`SELECT state,stop_pending,stop_id,active_turn_id,
          opencode_session_id,native_session_confirmed_at
          FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
        const priorEffects = [...effects];
        expect(await writers.prepareAgent(f.changeID, retry.id)).toBe(true);
        expect((await turns.get(retry.id))?.state).toBe("pending");
        expect(await turns.validateExecution(retry.id, pending.ownerToken)).toBe(true);
        expect(
          await f.database.client`SELECT state,stop_pending,stop_id,active_turn_id,
          opencode_session_id,native_session_confirmed_at
          FROM factory.change_agent_session WHERE change_id=${f.changeID}`,
        ).toEqual(before);
        expect((await runtime.get(f.attemptID))?.state).toBe("stopped");
        expect(effects).toEqual(priorEffects);
        expect(effects.filter((effect) => effect === "DeleteActor")).toHaveLength(1);
        return;
      }
      for (const invalid of [
        { turnID: crypto.randomUUID(), epoch: writer.epoch },
        { turnID: retry.id, epoch: String(BigInt(writer.epoch) - 1n) },
      ]) {
        await expect(runtime.stop(f.attemptID, invalid)).rejects.toThrow();
        expect((await turns.get(retry.id))?.state).toBe("pending");
        expect(effects).toEqual([]);
      }
      await turns.releasePending(retry.id, pending.ownerToken);
      await expect(
        runtime.stop(f.attemptID, { turnID: retry.id, epoch: writer.epoch }),
      ).rejects.toThrow();
      expect(effects).toEqual([]);
      pending = await turns.claimPending(retry.id);
      if (!pending?.ownerToken) throw Error("Owned retry lease was not reacquired");
      if (action === "stop-during-cleanup") {
        const stop = createChangeAgentStop(f.database, f.hub);
        await stop.persist(f.changeID, { turnID: retry.id, epoch: writer.epoch });
        expect((await turns.get(retry.id))?.state).toBe("pending");
        const [before] = await f.database.client<
          { id: string; turnID: string; pending: boolean }[]
        >`
        SELECT stop_id AS id,stop_turn_id AS "turnID",stop_pending AS pending
        FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
        expect(before).toMatchObject({ turnID: previous.id, pending: true });
        expect(await turns.renew(retry.id, pending.ownerToken)).toBe(true);
        expect(await turns.validateExecution(retry.id, pending.ownerToken)).toBe(false);
        const agent = createAgentController(f.database, f.hub, runtime);
        try {
          expect(await agent.get(f.changeID, retry.id, false)).toMatchObject({
            state: "starting",
            stopPending: false,
            stopId: null,
            turn: { id: retry.id, state: "pending" },
          });
        } finally {
          await agent.shutdown();
        }
        await stop.persist(f.changeID);
        expect((await turns.get(retry.id))?.state).toBe("stopped");
        expect(await turns.renew(retry.id, pending.ownerToken)).toBe(false);
        const [after] = await f.database.client<{ id: string; turnID: string; pending: boolean }[]>`
        SELECT stop_id AS id,stop_turn_id AS "turnID",stop_pending AS pending
        FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
        expect(after).toEqual(before);
        expect((await turns.get(previous.id))?.state).toBe("failed");
        expect(effects).toEqual([]);
        return;
      }
      expect(await writers.prepareAgent(f.changeID, retry.id)).toBe(true);
      expect((await turns.get(retry.id))?.state).toBe("pending");
      expect(await turns.validateExecution(retry.id, pending.ownerToken)).toBe(true);
      expect((await turns.get(previous.id))?.state).toBe("failed");
      const [session] = await f.database.client<{ turnID: string }[]>`
      SELECT stop_turn_id AS "turnID" FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      expect(session?.turnID).toBe(previous.id);
      expect(effects.filter((effect) => effect === "DeleteActor")).toHaveLength(1);
      expect(effects).toContain("independent-source");
      // Explicit user Stop still cancels the newly admitted work. The exemption
      // belongs only to its exact, lease-owned previous-runtime handoff.
      await runtime.stop(f.attemptID);
      expect((await turns.get(retry.id))?.state).toBe("stopped");
      expect(effects.filter((effect) => effect === "DeleteActor")).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);
