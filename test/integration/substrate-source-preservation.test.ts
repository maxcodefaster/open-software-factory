import { expect, test } from "bun:test";
import { objectDigest, type PrivateObjects } from "../../apps/factory/src/storage/objects";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { sourcePreservationPrefix } from "../../apps/factory/src/workspace/substrate-source-preservation";
import { runtimeConnectorTokens } from "../../packages/runtime-domain/src/identity";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

async function fixture() {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  let suspends = 0;
  let resumes = 0;
  let connected = true;
  let interruptedSnapshot: string | undefined;
  let checkpoints = 0;
  let afterRead: (() => Promise<void>) | undefined;
  const stored = new Map<string, Uint8Array>();
  const objects: PrivateObjects = {
    async put(key, bytes) {
      stored.set(key, new Uint8Array(bytes));
    },
    async read(key) {
      const bytes = stored.get(key);
      if (!bytes) throw Error("Missing private fixture object");
      await afterRead?.();
      return bytes;
    },
    async remove() {
      throw Error("Preserved Source cannot be removed");
    },
    async open() {
      throw Error("Preserved Source cannot be exposed through an unauthenticated URL");
    },
  };
  const source = createSubstrateSources(f.database, f.hub, objects);
  f.hub.sourceConnected = () => connected;
  f.hub.parentOperation = async () => {
    throw Error("Completed original writer drain must not be replayed");
  };
  const controller = f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = f.actor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      resumes++;
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    if (method === "SuspendActor" && actor) {
      suspends++;
      if (actor.status.state === "ACTOR_STATE_RUNNING") checkpoints++;
      actor.metadata.version = String(Number(actor.metadata.version) + 1);
      actor.status.state = "ACTOR_STATE_SUSPENDED";
      actor.status.lastAssignedGeneration = 1;
      actor.status.snapshots = [
        {
          uuid: interruptedSnapshot ?? crypto.randomUUID(),
          generation: 1,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: f.config.templateUID,
          sandboxRuntime: f.config.runtime,
          durableSnapshot: {
            state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
            object: { snapshotUri: "" },
          },
        },
      ];
      const snapshot = actor.status.snapshots[0] as {
        uuid: string;
        durableSnapshot: { object: { snapshotUri: string } };
      };
      snapshot.durableSnapshot.object.snapshotUri = `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${snapshot.uuid}`;
      return { actor: structuredClone(actor) };
    }
    throw Error(`Unexpected preservation effect: ${method}`);
  }, source);
  try {
    await f.database
      .client`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
    await controller.start(f.projectID, f.userID);
    const actorUID = (await source.lease(f.workspaceID))?.actorUID;
    if (!actorUID) throw Error("Original fixture Actor is unavailable");
    const checkpointID = crypto.randomUUID();
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='pausing',failure='Original CLI bootstrap failed' WHERE id=${f.attemptID}`;
    await f.database
      .client`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${checkpointID} WHERE workspace_id=${f.workspaceID}`;
    const bytes = new TextEncoder().encode(
      "bounded controller protocol fixture; native qualification uses a real complete tar",
    );
    const prefix = sourcePreservationPrefix({ workspaceID: f.workspaceID, checkpointID });
    const producer = {
      version: 1,
      kind: "retained-source-preservation",
      projectID: f.projectID,
      workspaceID: f.workspaceID,
      attemptID: f.attemptID,
      actorUID,
      checkpointID,
      writerEpoch: 2,
      sourceGeneration: 0,
      archiveObjectPrefix: prefix,
      objectPrefix: prefix,
      actorRecoveryArchive: `/home/rootless/persist/connector/source-preservation-${checkpointID}-noatime/source.tar`,
      predecessorSHA256: "a".repeat(64),
      toolSHA256: "b".repeat(64),
      originalLockfile: {
        uid: 0,
        gid: 0,
        mode: 0o100644,
        ino: "1",
        size: "393",
        atime: "1790000000123456789",
        mtime: "1790000000123456789",
        ctime: "1790000000123456789",
      },
      bundle: {
        version: 2,
        bytes: bytes.length,
        sha256: objectDigest(bytes),
        chunks: [objectDigest(bytes)],
      },
    };
    const manifest = new TextEncoder().encode(JSON.stringify(producer));
    stored.set(`${prefix}/recovery.json`, manifest);
    stored.set(`${prefix}/chunk-0`, bytes);
    const token = runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent;
    const request = (
      input: unknown = { checkpointID, manifestSHA256: objectDigest(manifest) },
      bearer = token,
    ) =>
      new Request(`https://factory.test/internal/substrate-source/${f.attemptID}/preserve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "X-Factory-Runtime-Actor-UID": actorUID,
          "X-Factory-Runtime-Generation": "1",
        },
        body: JSON.stringify(input),
      });
    return {
      ...f,
      source,
      controller,
      stored,
      prefix,
      producer,
      request,
      checkpointID,
      manifestSHA256: objectDigest(manifest),
      suspends: () => suspends,
      resumes: () => resumes,
      checkpoints: () => checkpoints,
      interruptedCommittedPause(durable = true) {
        if (!actor) throw Error("Original fixture Actor is unavailable");
        interruptedSnapshot = crypto.randomUUID();
        checkpoints = 1;
        actor.metadata.version = "3";
        actor.status.state = "ACTOR_STATE_SUSPENDING";
        actor.status.lastAssignedGeneration = 1;
        actor.status.snapshots = [
          {
            uuid: interruptedSnapshot,
            generation: 1,
            owner: "SNAPSHOT_OWNER_ACTOR",
            fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
            actorTemplateUid: f.config.templateUID,
            sandboxRuntime: f.config.runtime,
            durableSnapshot: {
              state: durable
                ? "SNAPSHOT_STORAGE_STATE_COMPLETED"
                : "SNAPSHOT_STORAGE_STATE_PENDING",
              object: {
                snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${interruptedSnapshot}`,
              },
            },
          },
        ];
        return interruptedSnapshot;
      },
      connect(value: boolean) {
        connected = value;
      },
      onRead(effect: () => Promise<void>) {
        afterRead = effect;
      },
      async dispose() {
        await source.close();
        await f.dispose();
      },
    };
  } catch (error) {
    await source.close();
    await f.dispose();
    throw error;
  }
}

test("exact initial Source preservation retains ROOTFS without granting editor handoff or replaying failed bootstrap", async () => {
  const f = await fixture();
  try {
    expect((await f.source.preservationEndpoint(f.request({}, "wrong"), f.attemptID)).status).toBe(
      403,
    );
    for (const [header, value] of [
      ["X-Factory-Runtime-Generation", "2"],
      ["X-Factory-Runtime-Actor-UID", crypto.randomUUID()],
    ] as const) {
      const request = f.request();
      request.headers.set(header, value);
      expect((await f.source.preservationEndpoint(request, f.attemptID)).status).toBe(403);
    }
    await expect(
      f.source.preservationEndpoint(
        f.request({ checkpointID: crypto.randomUUID(), manifestSHA256: f.manifestSHA256 }),
        f.attemptID,
      ),
    ).rejects.toThrow("exact frozen failed owner");
    await expect(
      f.source.preservationEndpoint(
        f.request({ checkpointID: f.checkpointID, manifestSHA256: "f".repeat(64) }),
        f.attemptID,
      ),
    ).rejects.toThrow("preservation is unconfirmed");
    expect((await f.source.lease(f.workspaceID))?.preservation).toBeNull();
    const response = await f.source.preservationEndpoint(f.request(), f.attemptID);
    expect(await response.json()).toEqual({ confirmed: true, sourceHandoff: "pending" });
    expect((await f.source.preservationEndpoint(f.request(), f.attemptID)).status).toBe(200);
    expect(await f.source.lease(f.workspaceID)).toMatchObject({
      owner: "actor",
      writable: false,
      writerEpoch: 2,
      generation: 0,
      checkpoint: null,
      preservation: { checkpointID: f.checkpointID },
    });
    expect(f.suspends()).toBe(0);
    const paused = await f.controller.stop(f.attemptID);
    expect(paused?.state).toBe("paused");
    expect(paused?.native).toMatchObject({
      state: "ACTOR_STATE_SUSPENDED",
      sourceHandoff: "pending",
      portable: false,
    });
    expect(f.suspends()).toBe(1);
    expect(await f.source.available(f.workspaceID)).toBe(false);
    await expect(f.controller.start(f.projectID, f.userID)).rejects.toThrow(
      "Reconcile the startup outcome",
    );
    expect(f.resumes()).toBe(1);
    await f.controller.stop(f.attemptID);
    expect(f.suspends()).toBe(1);
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_source SET preservation=NULL WHERE workspace_id=${f.workspaceID}`,
      ),
    ).rejects.toThrow("stays fenced");
    expect(await f.database.client`SELECT workspace_id FROM factory.workspace_source`).toHaveLength(
      0,
    );
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test.each(["corrupt", "disconnected", "revoked"])(
  "initial preservation cannot bypass current private archive/liveness/permission fences: %s",
  async (scenario) => {
    const f = await fixture();
    try {
      if (scenario === "revoked") {
        let once = false;
        f.onRead(async () => {
          if (!once) {
            once = true;
            await f.database
              .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
          }
        });
        await expect(f.source.preservationEndpoint(f.request(), f.attemptID)).rejects.toThrow();
        expect((await f.source.lease(f.workspaceID))?.preservation).toBeNull();
      } else {
        expect((await f.source.preservationEndpoint(f.request(), f.attemptID)).status).toBe(200);
        if (scenario === "corrupt") f.stored.set(`${f.prefix}/chunk-0`, new Uint8Array([0]));
        else f.connect(false);
        await expect(f.controller.stop(f.attemptID)).rejects.toThrow(
          scenario === "corrupt"
            ? "preservation is unconfirmed"
            : "No native checkpoint was dispatched",
        );
        expect(f.suspends()).toBe(0);
      }
      expect(await f.source.lease(f.workspaceID)).toMatchObject({
        owner: "actor",
        writable: false,
        generation: 0,
        checkpoint: null,
      });
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("interrupted committed native pause reconciles its exact snapshot without a live Parent or another filesystem checkpoint", async () => {
  const f = await fixture();
  try {
    expect((await f.source.preservationEndpoint(f.request(), f.attemptID)).status).toBe(200);
    const snapshotUID = f.interruptedCommittedPause();
    f.connect(false);
    const result = await f.controller.stop(f.attemptID);
    expect(result?.state).toBe("paused");
    expect(result?.native?.sourceHandoff).toBe("pending");
    const [saved] = await f.database
      .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
    expect(saved?.["checkpoint"].uuid).toBe(snapshotUID);
    expect(saved?.["checkpoint"].generation).toBe(1);
    expect(f.checkpoints()).toBe(1);
    expect(f.suspends()).toBe(1);
    expect(await f.source.lease(f.workspaceID)).toMatchObject({
      owner: "actor",
      writable: false,
      generation: 0,
      checkpoint: null,
    });
  } finally {
    await f.dispose();
  }
}, 60_000);

test("an interrupted PENDING native pause does not redispatch Suspend even with complete Source preservation", async () => {
  const f = await fixture();
  try {
    expect((await f.source.preservationEndpoint(f.request(), f.attemptID)).status).toBe(200);
    f.interruptedCommittedPause(false);
    f.connect(false);
    await expect(f.controller.stop(f.attemptID)).rejects.toThrow("not confirmed durable");
    expect(f.suspends()).toBe(0);
    expect(f.checkpoints()).toBe(1);
    const [saved] = await f.database
      .client`SELECT a.state,b.checkpoint FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id WHERE a.id=${f.attemptID}`;
    expect(saved?.["state"]).toBe("pausing");
    expect(saved?.["checkpoint"]).toBeNull();
    expect(await f.source.lease(f.workspaceID)).toMatchObject({
      owner: "actor",
      writable: false,
      generation: 0,
      checkpoint: null,
    });
  } finally {
    await f.dispose();
  }
}, 60_000);
