import { expect, test } from "bun:test";
import { createCodingRuntimeShutdown } from "../../apps/factory/src/agent/runtime-shutdown";
import {
  createSubstrateExecution,
  type SubstrateConfiguration,
} from "../../apps/factory/src/runtime/substrate";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  type NativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

type ResumeFact = {
  actor_uid: string;
  native_version: string;
  origin_key: string;
  origin_checkpoint: unknown;
  attempted_at: string;
  outcome: unknown;
};

test.each([
  { scenario: "initial", fault: null },
  { scenario: "checkpoint", fault: null },
  { scenario: "startup-initial", fault: null },
  { scenario: "startup-checkpoint", fault: null },
  { scenario: "checkpoint", fault: "uuid" },
  { scenario: "checkpoint", fault: "uri" },
  { scenario: "checkpoint", fault: "generation" },
  { scenario: "checkpoint", fault: "durability" },
  { scenario: "checkpoint", fault: "completed-uri" },
  { scenario: "initial", fault: "completed-initial" },
] as const)(
  "an interrupted native Resume preserves $scenario allocation with $fault",
  async ({ scenario, fault }) => {
    const f = await substrateFixture();
    let actor: NativeActor | undefined;
    let creates = 0;
    let resumes = 0;
    let lose = !scenario.endsWith("checkpoint");
    let original: ResumeFact | undefined;
    const originalFact = () => {
      if (!original) throw Error("Original dispatched Resume fact was not captured");
      return original;
    };
    const facts = async () => {
      const [row] = await f.database.client<ResumeFact[]>`
        SELECT actor_uid::text,native_version,origin_key,origin_checkpoint,
          attempted_at::text,outcome FROM factory.substrate_actor_rpc
        WHERE runtime_attempt_id=${f.attemptID} AND action='resume'
        ORDER BY intended_at DESC LIMIT 1`;
      if (!row) throw Error("Original Resume dispatch missing");
      return row;
    };
    const call: SubstrateCall = async (method, request) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActorEgressPolicy")
        return {
          metadata: { ...f.space.metadata, name: "default", atespace: f.atespace },
          rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
        };
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        creates++;
        actor = await f.createdActor();
        return structuredClone(actor);
      }
      if (method === "ResumeActor" && actor) {
        resumes++;
        expect(request).toEqual({ actor: { atespace: f.atespace, name: actor.metadata.name } });
        const continuing = actor.status.state === "ACTOR_STATE_RESUMING";
        if (continuing) {
          expect(await facts()).toEqual(originalFact());
          expect(creates).toBe(1);
        }
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
        if (lose) {
          lose = false;
          actor.status.state = "ACTOR_STATE_RESUMING";
          original = await facts();
          throw new SubstrateRPCError("Canceled", "Original native Resume interrupted");
        }
        actor.status.state = "ACTOR_STATE_RUNNING";
        if (continuing && fault === "completed-uri") {
          const snapshot = actor.status.snapshots?.at(-1) as {
            durableSnapshot: { object: { snapshotUri: string } };
          };
          snapshot.durableSnapshot.object.snapshotUri =
            snapshot.durableSnapshot.object.snapshotUri.replace("s3://owned/", "s3://other/");
        }
        if (continuing && fault === "completed-initial") {
          const uuid = crypto.randomUUID();
          actor.status.lastAssignedGeneration = 1;
          actor.status.snapshots = [
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
          ];
        }
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor" && actor) {
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        actor.status = {
          state: "ACTOR_STATE_SUSPENDED",
          lastAssignedGeneration: 1,
          snapshots: [
            {
              uuid: "fe9d65ce-7c11-44a5-b141-d825c53db47e",
              generation: 1,
              owner: "SNAPSHOT_OWNER_ACTOR",
              fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
              actorTemplateUid: f.config.templateUID,
              sandboxRuntime: f.config.runtime,
              durableSnapshot: {
                state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
                object: {
                  snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/fe9d65ce-7c11-44a5-b141-d825c53db47e`,
                },
              },
            },
          ],
        };
        return { actor: structuredClone(actor) };
      }
      throw Error(`Uncommissioned native operation ${method}`);
    };
    const runtime = await f.controller(call);
    try {
      if (scenario.endsWith("checkpoint")) {
        await runtime.start(f.projectID, f.userID);
        await runtime.pause(f.attemptID);
        lose = true;
        await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow(
          "Resume interrupted",
        );
      } else {
        await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("Resume interrupted");
      }
      const uid = actor?.metadata.uid;
      const priorCalls = resumes;
      const snapshots = structuredClone(actor?.status.snapshots);
      if (fault && !fault.startsWith("completed")) {
        const [before] = await f.database
          .client`SELECT checkpoint,observation FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
        if (!actor) throw Error("Original Actor missing");
        const latest = actor.status.snapshots?.at(-1) as {
          uuid: string;
          generation: number;
          durableSnapshot: { state: string; object: { snapshotUri: string } };
        };
        if (!latest) throw Error("Original snapshot missing");
        switch (fault) {
          case "uuid": {
            const replacement = crypto.randomUUID();
            latest.durableSnapshot.object.snapshotUri =
              latest.durableSnapshot.object.snapshotUri.replace(latest.uuid, replacement);
            latest.uuid = replacement;
            break;
          }
          case "uri":
            latest.durableSnapshot.object.snapshotUri =
              latest.durableSnapshot.object.snapshotUri.replace("s3://owned/", "s3://other/");
            break;
          case "generation":
            actor.status.lastAssignedGeneration = 2;
            latest.generation = 2;
            break;
          case "durability":
            latest.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_PENDING";
            break;
        }
        await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow();
        expect(resumes).toBe(priorCalls);
        expect(await facts()).toEqual(originalFact());
        const [after] = await f.database
          .client`SELECT checkpoint,observation FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
        expect(after).toEqual(before);
        return;
      }
      const continueOriginal = async () => {
        if (!scenario.startsWith("startup")) {
          await runtime.resumeForApp(f.attemptID, f.userID);
          return;
        }
        const [saved] = await f.database.client<
          { intent: SubstrateConfiguration & { actorSelector: Record<string, string> } }[]
        >`SELECT intent FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
        if (!saved) throw Error("Original binding missing");
        const { actorSelector: _, ...configuration } = saved.intent;
        await createSubstrateExecution(
          f.database,
          f.hub,
          "owned-native-secret",
          configuration,
          createCodingRuntimeShutdown(f.database, f.hub),
          call,
        ).recover();
      };
      if (fault?.startsWith("completed")) {
        await expect(continueOriginal()).rejects.toThrow();
        expect(resumes).toBe(priorCalls + 1);
        expect(await facts()).toEqual(originalFact());
        const [after] = await f.database.client<{ observation: NativeActor }[]>`
          SELECT observation FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
        expect(after?.observation.status.state).toBe("ACTOR_STATE_RESUMING");
        expect(after?.observation.status.snapshots).toEqual(snapshots);
        return;
      }
      await continueOriginal();
      expect(resumes).toBe(priorCalls + 1);
      expect(actor?.metadata.uid).toBe(uid);
      expect(actor?.status.snapshots).toEqual(snapshots);
      expect(actor?.status.state).toBe("ACTOR_STATE_RUNNING");
      const completed = await facts();
      const completedDispatch: ResumeFact = { ...completed, outcome: null };
      expect(completedDispatch).toEqual(originalFact());
      expect(completed.outcome).toMatchObject({ actorUID: uid, state: "ACTOR_STATE_RUNNING" });
      await runtime.resumeForApp(f.attemptID, f.userID);
      expect(resumes).toBe(priorCalls + 1);
      expect(creates).toBe(1);
    } finally {
      await f.dispose();
    }
  },
);

test.each([
  "stop",
  "newer-generation",
  "revoked-user",
  "foreign-actor",
  "foreign-runtime",
  "snapshot-initial",
] as const)("native Resume continuation refuses %s without another dispatch", async (fault) => {
  const f = await substrateFixture();
  let actor: NativeActor | undefined;
  let resumes = 0;
  const runtime = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = await f.createdActor();
      return structuredClone(actor);
    }
    if (method === "ResumeActor" && actor) {
      resumes++;
      actor.metadata.version = "2";
      actor.status.state = "ACTOR_STATE_RESUMING";
      actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      throw new SubstrateRPCError("Canceled", "Interrupted original Resume");
    }
    throw Error(`Uncommissioned native operation ${method}`);
  });
  try {
    await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow("Interrupted");
    if (!actor) throw Error("Original Actor missing");
    switch (fault) {
      case "stop":
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${f.attemptID}`;
        break;
      case "newer-generation": {
        const newer = runtimeIdentity(f.workspaceID, 2).attemptID;
        // Controlled stale-state fixture, not a native completion: both
        // generations keep valid, immutable provisioning identities.
        await f.database.client.begin(async (sql) => {
          await sql`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
          await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,created_by,create_intended_at)
            SELECT ${newer},project_id,workspace_id,2,revision,'create-intended',parent_connector_token_hash,child_connector_token_hash,created_by,now()
            FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
          await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
            SELECT ${newer},${`fa-${newer.replaceAll("-", "")}`},${`runtime-${newer.replaceAll("-", "")}`},
              jsonb_set(intent,'{generation}','2'::jsonb)
            FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
          await sql`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${newer}`;
          await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
        });
        break;
      }
      case "revoked-user":
        await f.database
          .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
        break;
      case "foreign-actor":
        actor.metadata.uid = crypto.randomUUID();
        break;
      case "foreign-runtime":
        actor.status.workerAssignment = {
          sandboxRuntime: {
            ...f.config.runtime,
            version: { schemaVersion: "v1", attributes: [{ key: "architecture", value: "arm64" }] },
          },
        };
        break;
      case "snapshot-initial":
        actor.status.lastAssignedGeneration = 1;
        actor.status.snapshots = [{ generation: 1 }];
        break;
    }
    await expect(runtime.resumeForApp(f.attemptID, f.userID)).rejects.toThrow();
    expect(resumes).toBe(1);
  } finally {
    await f.dispose();
  }
});
