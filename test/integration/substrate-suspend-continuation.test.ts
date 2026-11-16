import { expect, test } from "bun:test";
import { intendActorRPCIn } from "../../apps/factory/src/runtime/substrate-rpc-facts";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test.each([
  { label: "pending capture", durability: "PENDING", fault: null },
  { label: "durable capture", durability: "COMPLETED", fault: null },
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
        SELECT actor_uid::text,native_version,origin_key,attempted_at::text,outcome
        FROM factory.substrate_actor_rpc
        WHERE runtime_attempt_id=${f.attemptID} AND action='suspend'
        ORDER BY intended_at DESC LIMIT 1`;
      if (!row) throw Error("Original Suspend dispatch is unavailable");
      return row;
    };
    const runtime = await f.controller(async (method, request) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
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
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        actor.status.state =
          suspends === 3 && fault === "unfinished"
            ? "ACTOR_STATE_SUSPENDING"
            : "ACTOR_STATE_SUSPENDED";
        delete actor.status.workerAssignment;
        return { actor: structuredClone(actor) };
      }
      throw Error(`Uncommissioned native operation ${method}`);
    });
    try {
      await runtime.start(f.projectID, f.userID);
      await runtime.pause(f.attemptID);
      await runtime.resumeForApp(f.attemptID, f.userID);
      await expect(runtime.pause(f.attemptID)).rejects.toThrow("Owned native workflow lease ended");
      const identity = actor?.metadata.uid;
      expect(suspends).toBe(2);
      if (fault) {
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
        expect(suspends).toBe(["unfinished", "returned-uuid"].includes(fault) ? 3 : 2);
        expect(minted).toHaveLength(2);
        expect(await fact()).toEqual(original);
        const [saved] = await f.database
          .client`SELECT checkpoint,state FROM factory.substrate_binding
          JOIN factory.runtime_attempt ON id=runtime_attempt_id WHERE id=${f.attemptID}`;
        expect(saved?.["state"]).toBe("pausing");
        const first = minted[0];
        if (!first) throw Error("Previous confirmed checkpoint is unavailable");
        expect(saved?.["checkpoint"]).toMatchObject(first);
        if (fault === "returned-uuid") {
          await expect(runtime.pause(f.attemptID)).rejects.toThrow();
          expect(suspends).toBe(3);
        }
        return;
      }
      expect((await runtime.pause(f.attemptID))?.state).toBe("paused");
      expect({ creates, resumes, suspends }).toEqual({ creates: 1, resumes: 2, suspends: 3 });
      expect(actor?.metadata.uid).toBe(identity);
      expect(minted).toHaveLength(2);
      const observed = await fact();
      expect(observed["attempted_at"]).toBe(original?.["attempted_at"]);
      expect(observed["native_version"]).toBe(original?.["native_version"]);
      expect(observed["origin_key"]).toBe(minted[0]?.uuid);
      expect(observed["outcome"]).toMatchObject({
        actorUID: identity,
        state: "ACTOR_STATE_SUSPENDED",
        checkpoint: minted[1],
      });
      expect(
        await f.database.client`SELECT action FROM factory.substrate_actor_rpc
          WHERE runtime_attempt_id=${f.attemptID} AND action='suspend'`,
      ).toHaveLength(2);
      await runtime.pause(f.attemptID);
      expect(suspends).toBe(3);
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
    const runtime = await f.controller(async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      if (method === "CreateActor") {
        actor = f.actor();
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
    });
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
      expect(suspends).toBe(0);
      const [saved] = await f.database.client`SELECT checkpoint FROM factory.substrate_binding
        WHERE runtime_attempt_id=${f.attemptID}`;
      expect(saved?.["checkpoint"]).toBeNull();
    } finally {
      await f.dispose();
    }
  },
  30_000,
);
