import { expect, test } from "bun:test";
import { hashConnectorToken, runtimeConnectorTokens } from "#runtime-domain/identity";
import { type SubstrateCall, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import {
  beginInstallationMaintenance,
  finishInstallationMaintenance,
  installationInMaintenance,
} from "../../apps/factory/src/installation/maintenance";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import {
  dispatchActorRPCIn,
  intendActorRPCIn,
} from "../../apps/factory/src/runtime/substrate-rpc-facts";
import {
  createSubstrateWorkspaces,
  type SubstrateWorkspaceConfiguration,
} from "../../apps/factory/src/runtime/substrate-workspaces";
import { admitInitialSourceSeedIn } from "../../apps/factory/src/workspace/source-api";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { substrateFixture } from "../fixtures/substrate";

test.each([
  "running",
  "memory",
  "rootfs",
  "foreign-actor",
  "foreign-template",
  "missing-actor",
  "unadmitted",
  "pending-snapshot",
  "native-transition",
  "pending-rpc",
  "running-pending-rpc",
  "busy-workspace",
  "new-stop",
  "frozen-source",
  "active-knowledge",
] as const)(
  "maintenance retains an unconfirmed Stop without executing it: %s",
  async (scenario) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    const sources = createSubstrateSources(f.database, f.hub);
    const actor = f.actor();
    const calls: string[] = [];
    const readNative: SubstrateCall = async (method) => {
      calls.push(method);
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate")
        return scenario === "foreign-template"
          ? { ...f.template, metadata: { ...f.template.metadata, uid: crypto.randomUUID() } }
          : f.template;
      if (method === "GetActor") {
        if (scenario === "missing-actor")
          throw new SubstrateRPCError("NotFound", "Original Actor missing");
        return scenario === "foreign-actor"
          ? { ...actor, metadata: { ...actor.metadata, uid: crypto.randomUUID() } }
          : structuredClone(actor);
      }
      throw new SubstrateRPCError("PermissionDenied", `Maintenance cannot dispatch ${method}`);
    };
    let lock: ReturnType<typeof f.database.coordination> | undefined;
    try {
      f.config.deployment = "fresh-workspaces";
      f.config.environment = { version: 0, secretKey: null };
      f.config.declaredApps = ["app"];
      f.config.egressHosts = [];
      await f.controller(readNative, sources);
      actor.workerSelector = { matchLabels: f.config.workerSelector ?? {} };
      actor.metadata.version = "3";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      const paused = ["memory", "rootfs", "pending-rpc", "pending-snapshot"].includes(scenario);
      const snapshot = {
        uuid: crypto.randomUUID(),
        actorUID: actor.metadata.uid,
        generation: 1,
        owner: "SNAPSHOT_OWNER_ACTOR",
        fidelity: scenario === "memory" ? "SNAPSHOT_FIDELITY_MEMORY" : "SNAPSHOT_FIDELITY_ROOTFS",
        actorTemplateUid: f.config.templateUID,
        sandboxRuntime: f.config.runtime,
        durableSnapshot: {
          state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
          object: { snapshotUri: "" },
        },
      };
      snapshot.durableSnapshot.object.snapshotUri = `s3://owned/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${snapshot.uuid}`;
      if (paused)
        actor.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: 1,
          snapshots: [snapshot],
        };
      const tokens = runtimeConnectorTokens("owned-native-secret", f.attemptID, 1);
      await f.database.client.begin(async (sql) => {
        await admitInitialSourceSeedIn(sql, {
          workspaceID: f.workspaceID,
          projectID: f.projectID,
          repositoryURL: "https://example.invalid/fixture.git",
          revision: "a".repeat(40),
          branch: f.branch,
        });
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,
        revision,state,parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent,actor_uid,create_attempted_at,observation,checkpoint)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},
          'create-intended',${hashConnectorToken(tokens.parent)},now(),${f.userID},
          ${f.atespace},${actor.metadata.name},
          ${JSON.stringify({ ...f.config, actorSelector: f.config.workerSelector, sourceRestoreProtocol: 2 })}::jsonb,
          ${actor.metadata.uid},${actor.metadata.createTime},${JSON.stringify(actor)}::jsonb,
          ${paused ? JSON.stringify(snapshot) : null}::jsonb)`;
        const source = await sources.lease(f.workspaceID, sql);
        if (!source?.seed) throw Error("Owned Source seed missing");
        const id = crypto.randomUUID();
        await sql`UPDATE factory.substrate_source SET seed_confirmed_at=now()
        WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${id}
        WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET generation=1,checkpoint=${JSON.stringify({
          id,
          workspaceID: f.workspaceID,
          actorUID: null,
          seedID: source.seed.id,
          writerEpoch: 2,
          generation: 1,
          bundle: { version: 1, bytes: 1, sha256: "a".repeat(64), chunks: ["a".repeat(64)] },
        })}::jsonb WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.substrate_source SET owner='actor',actor_uid=${actor.metadata.uid},
        writable=true,writer_epoch=3,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
        await sql`UPDATE factory.runtime_attempt SET state=${paused ? "paused" : "ready"},
        ready_at=CASE WHEN ${scenario === "unadmitted"} THEN NULL ELSE now() END
        WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
        await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,
        state,native_session_confirmed_at,created_by)
        VALUES(${f.changeID},${f.attemptID},${`ses_owned_${f.changeID.replaceAll("-", "")}`},'committed',now(),${f.userID})`;
      });
      const admitted = await createChangeAdmission(f.database, "owned-stopped-model").admit(
        f.changeID,
        f.userID,
        {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Previously admitted input",
        },
      );
      await f.database
        .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
      WHERE turn_id=${admitted.turn.id}`;
      await f.database
        .client`UPDATE factory.change_agent_session SET state='working',active_turn_id=${admitted.turn.id}
      WHERE change_id=${f.changeID}`;
      await createChangeAgentStop(f.database, f.hub).persist(f.changeID);
      if (scenario === "native-transition") actor.status.state = "ACTOR_STATE_SUSPENDING";
      if (scenario === "pending-snapshot")
        snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_PENDING";
      if (scenario === "pending-rpc" || scenario === "running-pending-rpc") {
        const before = structuredClone(actor);
        before.metadata.version = "2";
        before.status = { state: "ACTOR_STATE_SUSPENDED" };
        await f.database
          .client`UPDATE factory.runtime_attempt SET observation=${JSON.stringify(before)}::jsonb
          WHERE id=${f.attemptID}`;
        const operation = await intendActorRPCIn(
          f.database.client,
          f.attemptID,
          "resume",
          paused ? snapshot : null,
          before,
        );
        await dispatchActorRPCIn(f.database.client, f.attemptID, operation);
      }
      if (scenario === "frozen-source")
        await f.database.client`UPDATE factory.substrate_source SET writer_epoch=4,writable=false,
        checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
      if (scenario === "active-knowledge") {
        const generationID = crypto.randomUUID();
        await f.database
          .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,payload)
        VALUES(${generationID},'knowledge.generation','project',${f.projectID},${`knowledge.generation:${generationID}`},${`knowledge.generation:${f.projectID}`},'pending',${f.userID},
          ${JSON.stringify({ id: generationID, projectId: f.projectID, sourceCommitSha: "a".repeat(40), pageCount: null, conflictCount: null, failure: null, createdBy: f.userID, modelId: null, attemptId: null, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
      }
      if (scenario === "busy-workspace") {
        lock = f.database.coordination();
        await lock`SELECT pg_advisory_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
      }
      const before = await sources.lease(f.workspaceID);
      const [stop] = await f.database
        .client`SELECT stop_id,stop_pending FROM factory.change_agent_session
      WHERE change_id=${f.changeID}`;
      if (!stop) throw Error("Original Stop missing");
      expect(stop?.["stop_pending"]).toBe(true);
      const [provision] = await f.database.client<
        { configuration: SubstrateWorkspaceConfiguration }[]
      >`SELECT intent->'configuration' AS configuration FROM factory.substrate_provision
        WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
      if (!provision) throw Error("Original provisioning intent missing");
      // Reconstruct exactly as the restricted maintenance process does: a new
      // hub, the persisted configuration and lazy Source support, without
      // starting a Source service or allowing provisioner mutations.
      const hub = new RuntimeHub(async () => {});
      const owner = createSubstrateWorkspaces(
        f.database,
        hub,
        "owned-native-secret",
        provision.configuration,
        readNative,
        async () => {
          throw Error("Maintenance has no provisioner authority");
        },
        undefined,
        sources,
      );
      const rpcBefore = await f.database.client`SELECT * FROM factory.operation
          WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${f.attemptID}`;
      const maintenance = beginInstallationMaintenance(f.database, async (sql, target) => {
        const execution = await owner.forAttempt(target.attemptID, sql);
        const retained = (await execution?.stoppedWorkRetainedIn(sql, target.stopID)) ?? false;
        if (scenario === "new-stop")
          await sql`UPDATE factory.change_agent_session SET stop_id=${crypto.randomUUID()}
          WHERE change_id=${f.changeID}`;
        return retained;
      });
      if (["running", "memory", "rootfs"].includes(scenario)) {
        await maintenance;
        expect(await installationInMaintenance(f.database)).toBe(true);
        await expect(
          createChangeAdmission(f.database, "owned-stopped-model").admit(f.changeID, f.userID, {
            kind: "change-prompt",
            commandId: crypto.randomUUID(),
            text: "Must not run during maintenance",
          }),
        ).rejects.toThrow();
        await finishInstallationMaintenance(f.database);
        await expect(
          createChangeAdmission(f.database, "owned-stopped-model").admit(f.changeID, f.userID, {
            kind: "change-prompt",
            commandId: crypto.randomUUID(),
            text: "Pending Stop still forbids new input after upgrade",
          }),
        ).rejects.toThrow();
        const execution = await owner.forAttempt(f.attemptID);
        if (!execution) throw Error("Original retained execution missing");
        await expect(execution.resume(f.userID)).rejects.toThrow();
        if (scenario === "running") await expect(execution.recover()).rejects.toThrow();
        else await execution.recover();
        for (const role of ["parent", "child"] as const) {
          const request = new Request("https://factory.test/internal/runtime-connect", {
            headers: {
              authorization: `Bearer ${tokens[role]}`,
              "x-factory-connector-role": role,
              "x-factory-runtime-attempt": f.attemptID,
              "x-factory-runtime-generation": "1",
              "x-factory-runtime-actor-uid": actor.metadata.uid,
            },
          });
          expect(await execution.authorizeConnector(request)).toBe(false);
          expect(hub.authorize(request, hashConnectorToken)).toBeNull();
        }
      } else await expect(maintenance).rejects.toThrow();
      expect(await installationInMaintenance(f.database)).toBe(false);
      expect(await sources.lease(f.workspaceID)).toEqual(before);
      expect(
        Array.from(
          await f.database.client`SELECT stop_id,stop_pending FROM factory.change_agent_session
          WHERE change_id=${f.changeID}`,
        ),
      ).toEqual([stop]);
      expect(
        await f.database.client`SELECT id AS stop_id FROM factory.operation
          WHERE kind='runtime.input_stop'`,
      ).toHaveLength(0);
      expect(
        await f.database.client`SELECT * FROM factory.operation
            WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${f.attemptID}`,
      ).toEqual(rpcBefore);
      if (scenario === "running-pending-rpc") expect(calls).toEqual([]);
      expect(
        calls.every((method) => ["GetAtespace", "GetActorTemplate", "GetActor"].includes(method)),
      ).toBe(true);
    } finally {
      if (lock) {
        await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${f.workspaceID}`}))`;
        await lock.end({ timeout: 1 });
      }
      await sources.close();
      await f.dispose();
    }
  },
  60_000,
);
