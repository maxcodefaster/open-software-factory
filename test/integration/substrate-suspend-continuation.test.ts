import { expect, test } from "bun:test";
import {
  type NativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { createCodingRuntimeShutdown } from "../../apps/factory/src/agent/runtime-shutdown";
import {
  createSubstrateExecution,
  type SubstrateConfiguration,
} from "../../apps/factory/src/runtime/substrate";
import { intendActorRPCIn } from "../../apps/factory/src/runtime/substrate-rpc-facts";
import { substrateFixture } from "../fixtures/substrate";

async function recoverOriginal(
  f: Awaited<ReturnType<typeof substrateFixture>>,
  call: SubstrateCall,
) {
  const [saved] = await f.database.client<
    { intent: SubstrateConfiguration & { actorSelector: Record<string, string> } }[]
  >`SELECT binding_intent AS intent FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
  if (!saved) throw Error("Original binding is unavailable");
  const { actorSelector, ...configuration } = saved.intent;
  if (!f.config.workerSelector) throw Error("Original Actor selector is unavailable");
  expect(actorSelector).toEqual(f.config.workerSelector);
  return createSubstrateExecution(
    f.database,
    f.hub,
    "owned-native-secret",
    configuration,
    createCodingRuntimeShutdown(f.database, f.hub),
    call,
  ).recover();
}

test.each([
  { label: "pending capture", durability: "PENDING", fault: null },
  { label: "durable capture", durability: "COMPLETED", fault: null },
  { label: "startup recovery of pending capture", durability: "PENDING", fault: "recover" },
  { label: "startup recovery of durable capture", durability: "COMPLETED", fault: "recover" },
  {
    label: "startup recovery after native finalization",
    durability: "COMPLETED",
    fault: "recover-completed",
  },
  { label: "background durability progress", durability: "PENDING", fault: "advance" },
  { label: "foreign Actor", durability: "PENDING", fault: "actor" },
  { label: "foreign template", durability: "PENDING", fault: "template" },
  { label: "foreign runtime", durability: "PENDING", fault: "runtime" },
  { label: "foreign storage identity", durability: "PENDING", fault: "uri" },
  { label: "skipped generation", durability: "PENDING", fault: "generation" },
  { label: "duplicate generation", durability: "PENDING", fault: "duplicate" },
  { label: "changed snapshot UUID", durability: "PENDING", fault: "uuid" },
  { label: "changed snapshot bucket", durability: "PENDING", fault: "bucket" },
  { label: "regressed durability", durability: "COMPLETED", fault: "durability" },
  { label: "substituted completed capture", durability: "PENDING", fault: "completed-uuid" },
  { label: "unfinished continuation", durability: "PENDING", fault: "unfinished" },
  { label: "substituted reply", durability: "PENDING", fault: "returned-uuid" },
  { label: "substituted storage reply", durability: "PENDING", fault: "returned-bucket" },
] as const)(
  "native Suspend continuation preserves its original checkpoint: $label",
  async ({ durability, fault }) => {
    const f = await substrateFixture();
    let actor: NativeActor | undefined;
    let creates = 0;
    let resumes = 0;
    let suspends = 0;
    const minted: { uuid: string; generation: number }[] = [];
    let original: Record<string, unknown> | undefined;
    const fact = async () => {
      const [row] = await f.database.client`
        SELECT payload->>'actorUid' AS actor_uid,
          payload->>'nativeVersion' AS native_version,
          payload->>'originKey' AS origin_key,
          payload->>'attemptedAt' AS attempted_at,
          result AS outcome
        FROM factory.operation
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
          AND scope_id=${f.attemptID} AND payload->>'action'='suspend'
        ORDER BY created_at DESC LIMIT 1`;
      if (!row) throw Error("Original Suspend dispatch is unavailable");
      return row;
    };
    const call: SubstrateCall = async (method, request) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
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
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        actor.status.state = "ACTOR_STATE_RUNNING";
        actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor" && actor) {
        suspends++;
        expect(request).toEqual({
          actor: { atespace: f.atespace, name: actor.metadata.name },
          options: { mode: "DURABILITY_MODE_SYNCHRONOUS" },
        });
        if (actor.status.state === "ACTOR_STATE_RUNNING") {
          const uuid = crypto.randomUUID();
          const generation = (actor.status.lastAssignedGeneration ?? 0) + 1;
          minted.push({ uuid, generation });
          actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
          actor.status = {
            ...actor.status,
            state: "ACTOR_STATE_SUSPENDING",
            lastAssignedGeneration: generation,
            snapshots: [
              ...(actor.status.snapshots ?? []),
              {
                uuid,
                generation,
                owner: "SNAPSHOT_OWNER_ACTOR",
                fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
                actorTemplateUid: f.config.templateUID,
                sandboxRuntime: f.config.runtime,
                durableSnapshot: {
                  state: `SNAPSHOT_STORAGE_STATE_${generation === 1 ? "COMPLETED" : durability}`,
                  object: {
                    snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
                  },
                },
              },
            ],
          };
          if (generation === 2) {
            original = await fact();
            expect(original["attempted_at"]).toBeString();
            expect(original["outcome"]).toBeNull();
            throw new SubstrateRPCError("Canceled", "Owned native workflow lease ended");
          }
        } else {
          // Pinned upstream v1 continues the same persisted snapshot and its
          // atelet Checkpoint is idempotent. This controlled transport mirrors
          // TestSuspendActor_CheckpointError and ReentryKeepsPersistedSnapshotLocation.
          expect(actor.status.state).toBe("ACTOR_STATE_SUSPENDING");
          if (!original) throw Error("Original Suspend dispatch was not captured");
          expect(await fact()).toEqual(original);
          expect(minted).toHaveLength(2);
          expect(actor.status.lastAssignedGeneration).toBe(2);
        }
        const latest = actor.status.snapshots?.at(-1) as {
          uuid: string;
          generation: number;
          durableSnapshot: { state: string; object: { snapshotUri: string } };
        };
        latest.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_COMPLETED";
        if (suspends === 3 && fault === "returned-uuid") {
          latest.uuid = crypto.randomUUID();
          latest.durableSnapshot.object.snapshotUri = `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${latest.uuid}`;
        }
        if (suspends === 3 && fault === "returned-bucket")
          latest.durableSnapshot.object.snapshotUri =
            latest.durableSnapshot.object.snapshotUri.replace("s3://owned/", "s3://other/");
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        actor.status.state =
          suspends === 3 && fault === "unfinished"
            ? "ACTOR_STATE_SUSPENDING"
            : "ACTOR_STATE_SUSPENDED";
        delete actor.status.workerAssignment;
        return { actor: structuredClone(actor) };
      }
      throw Error(`Uncommissioned native operation ${method}`);
    };
    const runtime = await f.controller(call);
    try {
      await runtime.start(f.projectID, f.userID);
      await runtime.pause(f.attemptID);
      await runtime.resumeForApp(f.attemptID, f.userID);
      await expect(runtime.pause(f.attemptID)).rejects.toThrow("Owned native workflow lease ended");
      const identity = actor?.metadata.uid;
      expect(suspends).toBe(2);
      if (!original) throw Error("Original Suspend dispatch was not captured");
      if (fault === "advance") {
        await runtime.get(f.attemptID);
        if (!actor) throw Error("Original Actor is unavailable");
        const latest = actor.status.snapshots?.at(-1) as { durableSnapshot: { state: string } };
        latest.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_COMPLETED";
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      }
      if (fault && !["advance", "recover", "recover-completed"].includes(fault)) {
        await runtime.get(f.attemptID);
        if (!actor) throw Error("Original Actor is unavailable");
        const latest = actor.status.snapshots?.at(-1) as {
          uuid: string;
          generation: number;
          actorTemplateUid: string;
          sandboxRuntime: typeof f.config.runtime;
          durableSnapshot: { state: string; object: { snapshotUri: string } };
        };
        switch (fault) {
          case "actor":
            actor.metadata.uid = crypto.randomUUID();
            break;
          case "template":
            latest.actorTemplateUid = crypto.randomUUID();
            break;
          case "runtime":
            latest.sandboxRuntime = {
              ...latest.sandboxRuntime,
              version: {
                schemaVersion: "v1",
                attributes: [{ key: "architecture", value: "arm64" }],
              },
            };
            break;
          case "uri":
            latest.durableSnapshot.object.snapshotUri = "s3://owned/unrelated-snapshot";
            break;
          case "generation":
            latest.generation++;
            actor.status.lastAssignedGeneration = latest.generation;
            break;
          case "duplicate":
            actor.status.snapshots?.push(structuredClone(latest));
            break;
          case "uuid":
          case "completed-uuid":
            latest.uuid = crypto.randomUUID();
            latest.durableSnapshot.object.snapshotUri = `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${latest.uuid}`;
            if (fault === "completed-uuid") {
              actor.status.state = "ACTOR_STATE_SUSPENDED";
              latest.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_COMPLETED";
            }
            break;
          case "bucket":
            latest.durableSnapshot.object.snapshotUri =
              latest.durableSnapshot.object.snapshotUri.replace("s3://owned/", "s3://other/");
            break;
          case "durability":
            latest.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_PENDING";
            break;
        }
        await expect(runtime.pause(f.attemptID)).rejects.toThrow();
        const called = ["unfinished", "returned-uuid", "returned-bucket"].includes(fault) ? 3 : 2;
        expect(suspends).toBe(called);
        expect(minted).toHaveLength(2);
        expect(await fact()).toEqual(original);
        const [saved] = await f.database
          .client`SELECT checkpoint,state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
        expect(saved?.["state"]).toBe("pausing");
        const first = minted[0];
        if (!first) throw Error("Previous confirmed checkpoint is unavailable");
        expect(saved?.["checkpoint"]).toMatchObject(first);
        if (["uuid", "bucket", "returned-uuid", "returned-bucket"].includes(fault)) {
          await expect(runtime.get(f.attemptID)).rejects.toThrow();
          await expect(runtime.pause(f.attemptID)).rejects.toThrow();
          expect(suspends).toBe(called);
          expect(await fact()).toEqual(original);
        }
        return;
      }
      const recoveredCompletion = fault === "recover-completed";
      if (fault === "recover" || recoveredCompletion) {
        f.hub.revoke(f.attemptID);
        if (recoveredCompletion) {
          if (!actor) throw Error("Original Actor is unavailable");
          actor.status.state = "ACTOR_STATE_SUSPENDED";
          actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        }
        await recoverOriginal(f, call);
        expect((await runtime.get(f.attemptID))?.state).toBe("paused");
      } else expect((await runtime.pause(f.attemptID))?.state).toBe("paused");
      const expectedSuspends = recoveredCompletion ? 2 : 3;
      expect({ creates, resumes, suspends }).toEqual({
        creates: 1,
        resumes: 2,
        suspends: expectedSuspends,
      });
      expect(actor?.metadata.uid).toBe(identity);
      expect(minted).toHaveLength(2);
      const observed = await fact();
      expect(observed["attempted_at"]).toBe(original["attempted_at"]);
      expect(observed["native_version"]).toBe(original["native_version"]);
      expect(observed["origin_key"]).toBe(minted[0]?.uuid);
      expect(observed["outcome"]).toMatchObject({
        actorUID: identity,
        state: "ACTOR_STATE_SUSPENDED",
        checkpoint: minted[1],
      });
      expect(
        await f.database.client`SELECT payload->>'action' AS action FROM factory.operation
          WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt'
            AND scope_id=${f.attemptID} AND payload->>'action'='suspend'`,
      ).toHaveLength(2);
      await runtime.pause(f.attemptID);
      expect(suspends).toBe(expectedSuspends);
      await recoverOriginal(f, call);
      expect(suspends).toBe(expectedSuspends);
      await runtime.resumeForApp(f.attemptID, f.userID);
      expect(resumes).toBe(3);
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.each(["missing", "undispatched"] as const)(
  "a native pending snapshot does not invent a %s original Suspend dispatch",
  async (intent) => {
    const f = await substrateFixture();
    let actor: NativeActor | undefined;
    let suspends = 0;
    const call: SubstrateCall = async (method) => {
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
        actor.metadata.version = "2";
        actor.status.state = "ACTOR_STATE_RUNNING";
        actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor") suspends++;
      throw Error(`Uncommissioned native operation ${method}`);
    };
    const runtime = await f.controller(call);
    try {
      await runtime.start(f.projectID, f.userID);
      if (!actor) throw Error("Original Actor is unavailable");
      if (intent === "undispatched")
        await intendActorRPCIn(f.database.client, f.attemptID, "suspend", null, actor);
      const uuid = crypto.randomUUID();
      actor.metadata.version = "3";
      actor.status = {
        ...actor.status,
        state: "ACTOR_STATE_SUSPENDING",
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
              state: "SNAPSHOT_STORAGE_STATE_PENDING",
              object: {
                snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
              },
            },
          },
        ],
      };
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${f.attemptID}`;
      await expect(runtime.pause(f.attemptID)).rejects.toThrow("original dispatched");
      await expect(recoverOriginal(f, call)).rejects.toThrow("original dispatched");
      expect(suspends).toBe(0);
      const [saved] = await f.database.client`SELECT checkpoint FROM factory.runtime_attempt
        WHERE id=${f.attemptID}`;
      expect(saved?.["checkpoint"]).toBeNull();
    } finally {
      await f.dispose();
    }
  },
  30_000,
);
