import { expect, test } from "bun:test";
import { CommandError } from "../../apps/factory/src/command-error";
import type { SubstrateSourceHandoff } from "../../apps/factory/src/workspace/substrate-source";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import {
  readResetResources,
  requireResetResourcesAbsent,
} from "../../scripts/factory/reset-resources";
import { substrateFixture } from "../fixtures/substrate";
import { requireOwnedProjectSourceRetention } from "../fixtures/editor-source-resources";

test("Workspace Stop requires independent Source, fences concurrent Start and reconciles one UID-bound Delete", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  let originalUID: string | undefined;
  let independent = false;
  let suspends = 0;
  let resumes = 0;
  let creates = 0;
  let deletes = 0;
  let gate: Promise<void> | undefined;
  const freezing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending: Promise<unknown>[] = [];
  // Controlled Source/native observations exercise the controller boundary.
  // The Linux Source service and official Substrate still need live proof.
  const sources: SubstrateSourceHandoff = {
    async attach(workspaceID, actorUID) {
      expect(workspaceID).toBe(f.workspaceID);
      originalUID = actorUID;
    },
    async freezeActor(workspaceID, attemptID) {
      expect(workspaceID).toBe(f.workspaceID);
      expect(attemptID).toBe(f.attemptID);
      if (gate) {
        freezing.resolve();
        await gate;
      }
    },
    async paused() {},
    async resume() {},
    async requireIndependent(workspaceID, actorUID) {
      expect(workspaceID).toBe(f.workspaceID);
      if (!originalUID) throw new Error("Original Source Actor is unavailable");
      expect(actorUID).toBe(originalUID);
      if (!independent) throw new CommandError("unavailable", "Independent Source is unconfirmed");
    },
  };
  const c = await f.controller(async (method, request) => {
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
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    if (method === "SuspendActor" && actor) {
      suspends++;
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
      expect(independent).toBe(true);
      expect(request).toEqual({
        actor: { atespace: f.atespace, name: actor.metadata.name },
        options: { uid: originalUID, version: "3" },
      });
      const [intent] = await f.database.client`
        SELECT a.state,a.stop_intended_at,b.delete_intended_at,b.deleted_at
        FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
        WHERE a.id=${f.attemptID}`;
      expect(intent?.["state"]).toBe("stopping");
      expect(intent?.["stop_intended_at"]).not.toBeNull();
      expect(intent?.["delete_intended_at"]).not.toBeNull();
      expect(intent?.["deleted_at"]).toBeNull();
      deletes++;
      actor = null;
      throw new SubstrateRPCError("Unavailable", "lost Delete reply");
    }
    throw new Error(`Unexpected native effect ${method}`);
  }, sources);
  try {
    await c.start(f.projectID, f.userID);
    await expect(requireOwnedProjectSourceRetention(f.database, f.projectID)).rejects.toThrow(
      "no data was released",
    );
    await f.database.client`UPDATE factory.runtime_attempt SET ready_at=now(),state='ready'
      WHERE id=${f.attemptID}`;
    await expect(c.stop(f.attemptID)).rejects.toThrow("Independent Source is unconfirmed");
    expect(deletes).toBe(0);
    expect((await c.get(f.attemptID))?.state).toBe("paused");
    expect(suspends).toBe(1);
    independent = true;
    gate = release.promise;
    const stopping = c.stop(f.attemptID);
    const stopResult = stopping.then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    pending.push(stopResult);
    await freezing.promise;
    const waking = c.start(f.projectID, f.userID);
    const startResult = waking.then(
      () => "unexpected restart",
      (error: Error) => error.message,
    );
    pending.push(startResult);
    release.resolve();
    expect(await stopResult).toBe("lost Delete reply");
    expect(await startResult).toContain("retired");
    expect((await c.stop(f.attemptID))?.state).toBe("stopped");
    expect((await c.get(f.attemptID))?.native?.state).toBe("deleted");
    expect(creates).toBe(1);
    expect(deletes).toBe(1);
    expect(suspends).toBe(1);
    expect(resumes).toBe(1);
    const [retained] = await f.database.client`
      SELECT actor_uid,deleted_at,checkpoint FROM factory.substrate_binding
      WHERE runtime_attempt_id=${f.attemptID}`;
    if (!retained) throw Error("Original native Stop binding disappeared");
    expect(retained?.["actor_uid"]).toBe(originalUID);
    expect(retained?.["deleted_at"]).not.toBeNull();
    expect(retained?.["checkpoint"].actorUID).toBe(originalUID);
    await requireOwnedProjectSourceRetention(f.database, f.projectID);
    // The same read-only guard used by live-fixture disposal must retain this
    // database even after confirmed Actor Stop. The native scope still owns
    // its template and snapshots; Stop is not installation deletion.
    const inventory = await readResetResources(f.database);
    expect(inventory.nativeScopes.some((scope) => scope.name === f.atespace)).toBe(true);
    const disposalReads: string[] = [];
    await expect(
      requireResetResourcesAbsent(
        inventory,
        async () => {
          throw Error("Stopped Actor must not allow unrelated Kubernetes inventory");
        },
        () => async (method, request) => {
          disposalReads.push(method);
          expect(request).toEqual({ atespace: { name: f.atespace } });
          return f.space;
        },
      ),
    ).rejects.toThrow("native scope");
    expect(disposalReads).toEqual(["GetAtespace"]);
    const [observed] = await f.database
      .client`SELECT actor_uid,deleted_at,checkpoint FROM factory.substrate_binding
      WHERE runtime_attempt_id=${f.attemptID}`;
    expect(observed).toEqual(retained);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await f.dispose();
  }
}, 60_000);
