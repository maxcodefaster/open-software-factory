import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { substrateTemplateSHA256 } from "../../apps/factory/src/runtime/substrate";
import { nativeInputStopIn } from "../../apps/factory/src/runtime/substrate-input-stop";
import { objectDigest, type PrivateObjects } from "../../apps/factory/src/storage/objects";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import type { SubstrateSourceHandoff } from "../../apps/factory/src/workspace/substrate-source";
import {
  SubstrateRPCError,
  type SubstrateCall,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";
import { runtimeConnectorTokens } from "../../packages/runtime-domain/src/identity";

test.each([
  "settled",
  "lost-resume",
  "lost-suspend",
  "unknown-suspend",
  "unsettled",
  "foreign-result",
  "unsupported-bootstrap",
] as const)(
  "offline input Stop retains original native intent, Source and exact outcomes: %s",
  async (scenario) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    const modelID = "owned-stop-model",
      sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    let actor: ReturnType<typeof f.actor> | undefined;
    let creates = 0,
      resumes = 0,
      suspends = 0,
      sourceExports = 0;
    let loseResume = scenario === "lost-resume";
    let loseSuspend = scenario === "lost-suspend" || scenario === "unknown-suspend";
    const stored = new Map<string, Uint8Array>();
    const objects: PrivateObjects = {
      async put(key, data) {
        stored.set(key, new Uint8Array(data));
      },
      async read(key) {
        const data = stored.get(key);
        if (!data) throw Error("Owned Source object missing");
        return data;
      },
      async remove(key) {
        stored.delete(key);
      },
      async open() {
        throw Error("No public Source object access");
      },
    };
    const restore = createSubstrateSources(f.database, f.hub, objects);
    const bootstrap = {
      sourceHandoff: true,
      ...(scenario === "unsupported-bootstrap"
        ? {}
        : { inputStop: { version: 1, openCodeVersion: "2.0.27" } }),
    };
    Object.assign(f.template, {
      containers: [
        { env: [{ name: "FACTORY_SUBSTRATE_BOOTSTRAP", value: JSON.stringify(bootstrap) }] },
      ],
    });
    f.config.templateSHA256 = substrateTemplateSHA256(f.template);
    f.config.environment = { version: 0, secretKey: null };
    f.config.declaredApps = ["app"];
    f.config.egressHosts = [];
    const checkpoint = async (sql: typeof f.database.client) => {
      const [old] = await sql<{ epoch: number; generation: number; actorUID: string }[]>`
        SELECT writer_epoch::float8 AS epoch,generation::float8 AS generation,actor_uid::text AS "actorUID"
        FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`;
      if (!old) throw Error("Owned Source missing");
      const id = crypto.randomUUID(),
        epoch = old.epoch + 1,
        generation = old.generation + 1;
      await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=${epoch},checkpoint_id=${id} WHERE workspace_id=${f.workspaceID}`;
      const saved = {
        id,
        workspaceID: f.workspaceID,
        actorUID: old.actorUID,
        writerEpoch: epoch,
        generation,
        bundle: {
          version: 1,
          bytes: 4,
          sha256: objectDigest(new TextEncoder().encode("meta")),
          chunks: [objectDigest(new TextEncoder().encode("meta"))],
        },
      };
      stored.set(
        `workspace-source/v1/${f.workspaceID}/${id}/manifest.json`,
        new TextEncoder().encode(JSON.stringify(saved)),
      );
      stored.set(
        `workspace-source/v1/${f.workspaceID}/${id}/chunk-0`,
        new TextEncoder().encode("meta"),
      );
      const [frozen] = await sql`SELECT checkpoint_id::text AS id,writer_epoch::float8 AS epoch,
        generation::float8 AS generation,actor_uid::text AS uid,workspace_id::text AS workspace
        FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`;
      expect(frozen).toEqual({
        id: saved.id,
        epoch: saved.writerEpoch,
        generation: saved.generation - 1,
        uid: saved.actorUID,
        workspace: saved.workspaceID,
      });
      await sql`UPDATE factory.substrate_source SET generation=${generation},checkpoint=${JSON.stringify(saved)}::text::jsonb WHERE workspace_id=${f.workspaceID}`;
      sourceExports++;
    };
    // Controlled Source/native observations prove product coordination, not
    // Linux archive fidelity or a live Substrate Actor.
    const sources: SubstrateSourceHandoff = {
      async attach(workspaceID, uid, sql) {
        await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${workspaceID},${uid}) ON CONFLICT DO NOTHING`;
      },
      async freezeActor(_workspace, _attempt, sql) {
        const [row] =
          await sql`SELECT writable,checkpoint_id,checkpoint->>'id' AS saved FROM factory.substrate_source
          WHERE workspace_id=${f.workspaceID}`;
        if (row?.["writable"]) await checkpoint(sql as typeof f.database.client);
        else expect(row?.["checkpoint_id"]).toBe(row?.["saved"]);
      },
      async paused(_workspace, sql) {
        await sql`UPDATE factory.substrate_source SET owner='service',writer_epoch=writer_epoch+1,writable=true,
          service_base=checkpoint_id,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID} AND owner='actor'`;
      },
      async resume(_workspace, _attempt, sql) {
        const [row] =
          await sql`SELECT owner FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`;
        if (row?.["owner"] === "service") {
          await checkpoint(sql as typeof f.database.client);
          await sql`UPDATE factory.substrate_source SET owner='actor',writer_epoch=writer_epoch+1,writable=true,
            checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
        }
      },
      async requireIndependent(_workspace, uid, sql) {
        const [row] =
          await sql`SELECT workspace_id FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}
          AND actor_uid=${uid} AND owner='service' AND writable AND checkpoint IS NOT NULL AND service_base IS NOT NULL`;
        if (!row) throw Error("Owned independent Source missing");
      },
    };
    const rpc: SubstrateCall = async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActorEgressPolicy")
        return {
          metadata: { ...f.space.metadata, atespace: f.atespace, name: "default" },
          rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
        };
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        creates++;
        actor = f.actor();
        return structuredClone(actor);
      }
      if (method === "ResumeActor" && actor) {
        resumes++;
        if (resumes > 1) {
          const operation = await nativeInputStopIn(f.database.client, f.attemptID);
          expect(operation?.resumed).toBe(true);
          expect(operation?.sourceCheckpointID).toBeTruthy();
          expect(operation?.assignment).toMatchObject({
            attemptID: f.attemptID,
            sessionID,
            modelID,
            mode: "interrupt",
          });
          if (!operation) throw Error("Owned Stop is not admitted");
          const headers = {
            authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent}`,
            "X-Factory-Runtime-Actor-UID": operation.actorUID,
            "X-Factory-Runtime-Generation": "1",
          };
          const restored = await restore.restoreEndpoint(
            new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
              headers,
            }),
            f.attemptID,
          );
          expect(restored.status).toBe(200);
          expect(await restored.json()).toMatchObject({
            inputStop: operation.assignment,
            readOnly: true,
            writerEpoch: operation.sourceWriterEpoch,
            checkpoint: { id: operation.sourceCheckpointID },
          });
        }
        actor.metadata.version = String(Number(actor.metadata.version) + 1);
        actor.status = {
          ...actor.status,
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        if (resumes > 1 && loseResume) {
          loseResume = false;
          throw Error("Owned lost Stop-only Resume reply");
        }
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor" && actor) {
        suspends++;
        if (suspends > 1 && loseSuspend && scenario === "unknown-suspend") {
          loseSuspend = false;
          throw Error("Owned unknown Stop-only Suspend reply");
        }
        const uuid = crypto.randomUUID();
        actor.metadata.version = String(Number(actor.metadata.version) + 1);
        actor.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: suspends,
          snapshots: [
            {
              uuid,
              generation: suspends,
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
        if (suspends > 1 && loseSuspend) {
          loseSuspend = false;
          throw Error("Owned lost Stop-only Suspend reply");
        }
        return { actor: structuredClone(actor) };
      }
      throw Error(`Uncommissioned native operation ${method}`);
    };
    try {
      await f.database
        .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},epoch=2 WHERE change_id=${f.changeID}`;
      const runtime = await f.controller(rpc, sources);
      const execution = f.execution(rpc, sources);
      await execution.start(f.userID);
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
      await f.database.client`UPDATE factory.change SET state='active' WHERE id=${f.changeID}`;
      await f.database
        .client`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,
        state,native_session_confirmed_at,created_by)
        VALUES(${f.changeID},${f.attemptID},${sessionID},'committed',now(),${f.userID})`;
      const admitted = await createChangeAdmission(f.database, modelID).admit(
        f.changeID,
        f.userID,
        {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Owned queued work",
        },
      );
      await f.database
        .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
        WHERE turn_id=${admitted.turn.id}`;
      await f.database
        .client`UPDATE factory.change_agent_session SET state='working',active_turn_id=${admitted.turn.id}
        WHERE change_id=${f.changeID}`;
      await execution.suspend();
      f.hub.connected = () => false;
      f.hub.sourceConnected = () => true;
      f.hub.parentOperation = async (_attempt, operation) => {
        expect(operation.action).toBe("input-stop-result");
        const saved = await nativeInputStopIn(f.database.client, f.attemptID);
        if (!saved) throw Error("Stop was not persisted");
        return {
          data: JSON.stringify({
            ...saved.assignment,
            promptID: scenario === "foreign-result" ? "msg_foreign" : saved.assignment.promptID,
            confirmed: scenario !== "unsettled",
            engineExited: true,
            processTreeExited: true,
          }),
        };
      };
      const stop = createChangeAgentStop(f.database, f.hub, (target) =>
        runtime.settleRetainedInputStop(target, new AbortController().signal),
      );
      await stop.persist(f.changeID);
      expect(await stop.confirm(f.changeID, undefined, "observe")).toBe(false);
      expect(resumes).toBe(1);
      expect(
        await f.database.client`SELECT stop_id FROM factory.substrate_input_stop`,
      ).toHaveLength(0);
      if (scenario === "lost-resume") {
        await expect(stop.confirm(f.changeID)).rejects.toThrow("Owned lost");
        expect(resumes).toBe(2);
        const operation = await nativeInputStopIn(f.database.client, f.attemptID);
        if (!operation) throw Error("Lost Resume did not retain its exact intent");
        const target = {
          changeID: f.changeID,
          stopID: operation.stopID,
          attemptID: f.attemptID,
          sessionID,
          promptID: operation.assignment.promptID,
          mode: "observe" as const,
        };
        for (const changed of [
          { changeID: crypto.randomUUID() },
          { sessionID: "ses_foreign" },
          { promptID: "msg_foreign" },
        ])
          expect(
            await runtime.settleRetainedInputStop(
              { ...target, ...changed },
              new AbortController().signal,
            ),
          ).toBe(false);
        expect(suspends).toBe(1);
      }
      if (scenario === "lost-suspend" || scenario === "unknown-suspend")
        await expect(stop.confirm(f.changeID)).rejects.toThrow("Stop-only Suspend reply");
      if (scenario === "unknown-suspend") {
        await expect(stop.confirm(f.changeID)).rejects.toThrow("snapshot RPC was not repeated");
        expect(suspends).toBe(2);
        const [row] = await f.database
          .client`SELECT completed_at,snapshot_attempted_at FROM factory.substrate_input_stop WHERE runtime_attempt_id=${f.attemptID}`;
        expect(row?.["completed_at"]).toBeNull();
        expect(row?.["snapshot_attempted_at"]).not.toBeNull();
        return;
      }
      const confirmed = await stop.confirm(f.changeID);
      const expected = ["settled", "lost-resume", "lost-suspend"].includes(scenario);
      expect(confirmed).toBe(expected);
      expect(creates).toBe(1);
      expect(resumes).toBe(scenario === "unsupported-bootstrap" ? 1 : 2);
      const [session] = await f.database
        .client`SELECT stop_pending FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      expect(session?.["stop_pending"]).toBe(!expected);
      const [saved] = await f.database
        .client`SELECT completed_at,completed_checkpoint,completed_source_checkpoint_id,result,
        assignment,resume_attempted_at FROM factory.substrate_input_stop WHERE runtime_attempt_id=${f.attemptID}`;
      if (scenario === "unsupported-bootstrap") {
        expect(saved).toBeUndefined();
        expect(suspends).toBe(1);
        return;
      }
      expect(saved?.["resume_attempted_at"]).not.toBeNull();
      if (expected) {
        expect(saved?.["completed_at"]).not.toBeNull();
        expect(saved?.["completed_checkpoint"].generation).toBe(2);
        expect(saved?.["completed_source_checkpoint_id"]).toBeTruthy();
        expect(suspends).toBe(2);
        expect(sourceExports).toBe(3);
      } else expect(saved?.["completed_at"]).toBeNull();
      if (scenario === "foreign-result") expect(suspends).toBe(1);
      if (scenario === "unsettled") {
        expect(suspends).toBe(2);
        expect(saved?.["result"].confirmed).toBe(false);
      }
      await expect(
        Promise.resolve(f.database
          .client`UPDATE factory.substrate_input_stop SET assignment='{}'::jsonb
        WHERE runtime_attempt_id=${f.attemptID}`),
      ).rejects.toThrow("immutable");
    } finally {
      await restore.close();
      await f.dispose();
    }
  },
  60_000,
);
