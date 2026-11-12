import { expect, test } from "bun:test";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
} from "../../packages/runtime-domain/src/identity";
import {
  type NativeActor,
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test("failed personal bootstrap reconnect admits its retained Source Parent only, and still honors access revocation", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  const source = createSubstrateSources(f.database, f.hub);
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
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    throw new Error(`Unexpected failed-bootstrap effect: ${method}`);
  }, source);
  try {
    await f.database
      .client`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
    await controller.start(f.projectID, f.userID);
    const uid = nativeActor.parse(actor).metadata.uid;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='failed',failure='Original bootstrap failed' WHERE id=${f.attemptID}`;
    const request = (role: string) =>
      new Request("https://factory.test/internal/runtime-connect", {
        headers: {
          "x-factory-runtime-attempt": f.attemptID,
          "x-factory-runtime-generation": "1",
          "x-factory-runtime-actor-uid": uid,
          "x-factory-connector-role": role,
        },
      });
    expect(await controller.authorizeConnector(request("parent"))).toBe(true);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    await controller.recover();
    expect((await controller.get(f.attemptID))?.state).toBe("failed");
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
  } finally {
    await source.close();
    await f.dispose();
  }
}, 60_000);

test("a previously ready personal Workspace with its original frozen pause recovers only Source Parent authority, not Child execution", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: NativeActor | null = null;
  let resumes = 0;
  const source = createSubstrateSources(f.database, f.hub);
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
    throw Error(`Read-only pause recovery dispatched ${method}`);
  }, source);
  try {
    await f.database
      .client`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
    await controller.start(f.projectID, f.userID);
    const uid = nativeActor.parse(actor).metadata.uid;
    const checkpointID = crypto.randomUUID();
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='pausing',ready_at=now(),failure=NULL WHERE id=${f.attemptID}`;
    const request = (role: "parent" | "child") =>
      new Request("https://factory.test/internal/runtime-connect", {
        headers: {
          "x-factory-runtime-attempt": f.attemptID,
          "x-factory-runtime-generation": "1",
          "x-factory-runtime-actor-uid": uid,
          "x-factory-connector-role": role,
          authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1)[role]}`,
        },
      });
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
    await f.database
      .client`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${checkpointID} WHERE workspace_id=${f.workspaceID}`;
    expect(await controller.authorizeConnector(request("parent"))).toBe(true);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    f.hub.revoke(f.attemptID);
    expect(f.hub.authorize(request("parent"), hashConnectorToken)).toBeNull();
    const restored = Promise.withResolvers<void>();
    const allow = f.hub.allow.bind(f.hub);
    f.hub.allow = (...args) => {
      allow(...args);
      restored.resolve();
    };
    // Recovery activation deliberately follows listener readiness; observe its
    // real admission event rather than polling or starting another runtime.
    const activate = await controller.recover();
    activate();
    await restored.promise;
    expect(f.hub.authorize(request("parent"), hashConnectorToken)).not.toBeNull();
    expect(await controller.authorizeConnector(request("parent"))).toBe(true);
    expect(await controller.authorizeConnector(request("child"))).toBe(false);
    expect((await controller.get(f.attemptID))?.state).toBe("pausing");
    expect(await source.lease(f.workspaceID)).toMatchObject({
      owner: "actor",
      writable: false,
      writerEpoch: 2,
      checkpointID,
      generation: 0,
    });
    expect(resumes).toBe(1);
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
    expect(resumes).toBe(1);
  } finally {
    await source.close();
    await f.dispose();
  }
}, 60_000);

test.each(["starting", "failed"])(
  "unavailable initial Source blocks Suspend; an original completed pause is reconciled without replay: %s",
  async (initialState) => {
    const f = await substrateFixture();
    f.config.deployment = "fresh-workspaces";
    let actor: NativeActor | null = null;
    let suspends = 0;
    let resumes = 0;
    const source = createSubstrateSources(f.database, f.hub, {
      put: async () => {
        throw new Error("Bootstrap Source cannot be exported without its Parent");
      },
      read: async () => {
        throw new Error("No Source generation may be invented");
      },
      remove: async () => {
        throw new Error("No retained Source may be removed");
      },
      open: async () => {
        throw new Error("No Source generation may be invented");
      },
    });
    const call: SubstrateCall = async (method) => {
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
        throw new Error("Unavailable initial Source must not dispatch another native checkpoint");
      }
      throw new Error(`Unexpected bootstrap effect: ${method}`);
    };
    const controller = f.controller(call, source);
    try {
      await f.database
        .client`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
      await controller.start(f.projectID, f.userID);
      const uid = nativeActor.parse(actor).metadata.uid;
      expect(await source.lease(f.workspaceID)).toMatchObject({
        actorUID: uid,
        owner: "actor",
        writable: true,
        generation: 0,
        writerEpoch: 1,
      });
      if (initialState === "failed")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
      await expect(controller.stop(f.attemptID)).rejects.toThrow(
        "No native checkpoint was dispatched",
      );
      expect(suspends).toBe(0);
      expect((await source.lease(f.workspaceID))?.writerEpoch).toBe(1);
      // Controlled native observation of an earlier completed dispatch, not a
      // fresh Suspend or permission to restart the uncertain original bootstrap.
      const completed = nativeActor.parse(actor);
      const uuid = crypto.randomUUID();
      completed.metadata.version = "3";
      completed.status.state = "ACTOR_STATE_SUSPENDED";
      completed.status.lastAssignedGeneration = 1;
      completed.status.snapshots = [
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
              snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${uid}/snapshots/${uuid}`,
            },
          },
        },
      ];
      actor = completed;
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${f.attemptID}`;
      await expect(controller.start(f.projectID, f.userID)).rejects.toThrow(
        "Reconcile the startup outcome",
      );
      expect(resumes).toBe(1);
      expect((await controller.stop(f.attemptID))?.state).toBe("paused");
      expect((await controller.get(f.attemptID))?.native).toMatchObject({
        actorUID: uid,
        sourceHandoff: "pending",
        portable: false,
        state: "ACTOR_STATE_SUSPENDED",
      });
      expect(suspends).toBe(0);
      expect(await source.lease(f.workspaceID)).toMatchObject({
        actorUID: uid,
        owner: "actor",
        writable: true,
        generation: 0,
        writerEpoch: 1,
        checkpoint: null,
      });
      expect(
        await f.database.client`SELECT workspace_id FROM factory.workspace_source`,
      ).toHaveLength(0);
      expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
      expect((await controller.stop(f.attemptID))?.state).toBe("paused");
      expect(suspends).toBe(0);
      await controller.recover();
      expect(resumes).toBe(1);
      await expect(controller.start(f.projectID, f.userID)).rejects.toThrow(
        "Reconcile the startup outcome",
      );
      expect(resumes).toBe(1);
      const [savedBeforeCrash] = await f.database
        .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
      const crashed = nativeActor.parse(actor);
      crashed.metadata.version = String(BigInt(crashed.metadata.version) + 1n);
      crashed.status.state = "ACTOR_STATE_CRASHED";
      actor = crashed;
      const observedCrash = await controller.get(f.attemptID);
      expect(observedCrash?.state).toBe("failed");
      expect(observedCrash?.native?.sourceHandoff).toBe("pending");
      expect(observedCrash?.failure).toContain("not a confirmed recovery point");
      expect(
        (
          await f.database
            .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`
        )[0]?.["checkpoint"],
      ).toEqual(savedBeforeCrash?.["checkpoint"]);
      expect(suspends).toBe(0);
      expect(resumes).toBe(1);
      crashed.status.crash = {
        message: "killed for exceeding its memory limit",
        crashTime: new Date().toISOString(),
      };
      crashed.status.snapshots = [];
      actor = crashed;
      const observedMemoryFailure = await controller.get(f.attemptID);
      expect(observedMemoryFailure?.state).toBe("failed");
      expect(observedMemoryFailure?.failure).toContain("exceeded its memory limit");
      expect(observedMemoryFailure?.failure).not.toContain("pending snapshot");
      expect((await controller.get(f.attemptID))?.updatedAt).toBe(observedMemoryFailure?.updatedAt);
      const [retainedAfterMemoryFailure] = await f.database
        .client`SELECT checkpoint,observation#>>'{status,crash,message}' AS reason
        FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
      expect(retainedAfterMemoryFailure?.["checkpoint"]).toEqual(savedBeforeCrash?.["checkpoint"]);
      expect(retainedAfterMemoryFailure?.["reason"]).toBe("killed for exceeding its memory limit");
    } finally {
      await source.close();
      await f.dispose();
    }
  },
  60_000,
);

test.each(["previously-ready", "connected-parent", "frozen-source", "ticket"])(
  "retained-bootstrap pause cannot bypass normal Source or Coding fences: %s",
  async (scenario) => {
    const f = await substrateFixture("a".repeat(40), scenario === "ticket" ? "ticket" : "personal");
    f.config.deployment = "fresh-workspaces";
    let actor: NativeActor | null = null;
    let suspends = 0;
    const source = createSubstrateSources(f.database, f.hub);
    f.hub.sourceConnected = () => scenario === "connected-parent";
    f.hub.parentOperation = async () => {
      throw new Error("Source drain remains unconfirmed");
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
        actor.metadata.version = "2";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        return { actor: structuredClone(actor) };
      }
      if (method === "SuspendActor") {
        suspends++;
        throw new Error("Must not bypass Source settlement");
      }
      throw new Error(`Unexpected ${method}`);
    }, source);
    try {
      await f.database
        .client`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
      if (scenario === "ticket")
        await f.database
          .client`UPDATE factory.change_writer SET state='human',epoch=2,user_id=${f.userID} WHERE change_id=${f.changeID}`;
      await controller.start(f.projectID, f.userID);
      if (scenario === "previously-ready")
        await f.database
          .client`UPDATE factory.runtime_attempt SET ready_at=now() WHERE id=${f.attemptID}`;
      if (scenario === "frozen-source")
        await f.database
          .client`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
      await expect(controller.stop(f.attemptID)).rejects.toThrow(
        "Source drain remains unconfirmed",
      );
      expect(suspends).toBe(0);
      expect((await source.lease(f.workspaceID))?.owner).toBe("actor");
      expect(
        await f.database
          .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`,
      ).toMatchObject([{ checkpoint: null }]);
    } finally {
      await source.close();
      await f.dispose();
    }
  },
  60_000,
);
