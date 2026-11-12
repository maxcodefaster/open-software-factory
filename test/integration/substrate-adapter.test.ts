import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import type { RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
} from "../../packages/runtime-domain/src/identity";
import {
  type NativeActor,
  nativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test("native Source forwarding uses current personal grants and the runtime lock without waking compute", async () => {
  const f = await substrateFixture();
  let actor: NativeActor | null = null;
  const calls: string[] = [];
  const c = f.controller(async (method) => {
    calls.push(method);
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
      actor.status.state = "ACTOR_STATE_RUNNING";
      actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      actor.metadata.version = "2";
      return { actor };
    }
    throw new Error(`Unexpected ${method}`);
  });
  const forwarded: Array<{ attemptID: string; path: string; epoch: string | null }> = [];
  const source = createWorkspaceSourceController(
    f.database,
    "owned-native-secret",
    undefined,
    undefined,
    f.projectID,
    {
      sourceConnected: () => true,
      async request(attemptID, channel, request, path) {
        expect(channel).toBe("source");
        forwarded.push({ attemptID, path, epoch: request.headers.get("X-Factory-Writer-Epoch") });
        return Response.json({ confirmed: true });
      },
    },
  );
  const lock = f.database.coordination();
  let held = false;
  try {
    await c.start(f.projectID, f.userID);
    for (const role of ["parent", "child"] as const) {
      const socket = {
        data: { kind: "connector", role, attemptID: f.attemptID, generation: 1 },
        send: () => 1,
        close() {},
      } as unknown as ServerWebSocket<RuntimeSocketData>;
      f.hub.open(socket);
      f.hub.message(socket, JSON.stringify({ type: "hello", role, channels: [] }));
    }
    await c.status(f.attemptID, "ready");
    for (const phase of ["starting", "child-started", "reconnecting", "disconnected"]) {
      await c.status(f.attemptID, phase);
      // Progress and an old reconnect notice cannot turn a connected, ready
      // native Workspace into a failure that rejects its authenticated App.
      expect(await c.get(f.attemptID)).toMatchObject({ state: "ready", failure: null });
    }
    expect((await source.ensurePersonal(f.projectID, f.userID)).state).toBe("ready");
    const request = () =>
      new Request("https://factory.test/source/write", {
        method: "POST",
        headers: { "X-Factory-Writer-Epoch": "999" },
        body: JSON.stringify({ path: "private.txt", content: "b3duZWQ=" }),
      });
    expect((await source.forward(f.workspaceID, f.userID, "write", request())).status).toBe(200);
    expect(forwarded).toEqual([
      { attemptID: f.attemptID, path: `/v1/workspaces/${f.workspaceID}/write`, epoch: "1" },
    ]);
    const other = crypto.randomUUID();
    await f.database
      .client`INSERT INTO auth."user"(id,name,email) VALUES(${other},'Other native owner',${`${other}@factory.local`})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${f.projectID},${other},'developer',${f.userID})`;
    await expect(source.forward(f.workspaceID, other, "write", request())).rejects.toThrow(
      "Workspace not found",
    );
    await lock`SELECT pg_advisory_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
    held = true;
    const pending = source.forward(f.workspaceID, f.userID, "write", request());
    const observed = pending.then(
      () => "unexpectedly admitted",
      (error: Error) => error.message,
    );
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${f.workspaceID}`}))`;
    held = false;
    expect(await observed).not.toBe("unexpectedly admitted");
    expect(forwarded).toHaveLength(1);
    await f.database
      .client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${f.attemptID}`;
    const before = [...calls];
    await expect(source.forward(f.workspaceID, f.userID, "read", request())).rejects.toThrow(
      "compute was not started",
    );
    expect(calls).toEqual(before);
    expect(forwarded).toHaveLength(1);
    expect(await f.database.client`SELECT workspace_id FROM factory.workspace_source`).toHaveLength(
      0,
    );
    await expect(source.stop(f.workspaceID, f.userID)).rejects.toThrow("no data was released");
  } finally {
    if (held) await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${f.workspaceID}`}))`;
    await lock.end({ timeout: 1 });
    await source.close();
    await f.dispose();
  }
}, 60_000);

test("Factory Start retains native binding before gRPC; lost Create and Delete replies never allocate a second Actor", async () => {
  const f = await substrateFixture();
  let actor: ReturnType<typeof f.actor> | null = null,
    creates = 0,
    deletes = 0;
  const setNativeState = (state: string) => {
    if (!actor) throw new Error("Native fixture Actor missing");
    actor.status.state = state;
  };
  const c = f.controller(async (method, request) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      creates++;
      const [saved] = await f.database
        .client`SELECT a.substrate,a.factorybox_worker_id,b.create_attempted_at FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id WHERE a.id=${f.attemptID}`;
      expect(saved?.["substrate"]).toBe(true);
      expect(saved?.["factorybox_worker_id"]).toBeNull();
      expect(saved?.["create_attempted_at"]).not.toBeNull();
      actor = f.actor();
      throw new SubstrateRPCError("Unavailable", "lost Create reply");
    }
    if (method === "ResumeActor") {
      if (!actor) throw new Error("missing");
      actor.status.state = "ACTOR_STATE_RUNNING";
      actor.metadata.version = "2";
      actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      return { actor };
    }
    if (method === "DeleteActor") {
      expect(request).toEqual({
        actor: { atespace: f.atespace, name: actor?.metadata.name },
        options: { uid: actor?.metadata.uid, version: "2" },
      });
      deletes++;
      actor = null;
      throw new SubstrateRPCError("Unavailable", "lost Delete reply");
    }
    throw new Error(`Unexpected ${method}`);
  });
  try {
    expect(creates).toBe(0);
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    const sources = createWorkspaceSourceController(f.database, "owned-native-secret");
    try {
      expect((await sources.ensure(f.workspaceID, f.userID)).state).toBe("preparing");
    } finally {
      await sources.close();
    }
    await expect(
      Promise.resolve(
        f.database
          .client`INSERT INTO factory.workspace_source(workspace_id,state,files_image,capability_hash) VALUES(${f.workspaceID},'create-intended',${`example.invalid/files@sha256:${"a".repeat(64)}`},${"b".repeat(64)})`,
      ),
    ).rejects.toThrow("Source handoff is not enabled");
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("lost Create reply");
    const started = await c.start(f.projectID, f.userID);
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
    expect(started?.native?.coldRestart).toBe(true);
    expect(started?.native?.portable).toBe(false);
    expect(
      runtimeAttemptSchema.parse(JSON.parse(JSON.stringify(started))).native?.sourceHandoff,
    ).toBe("pending");
    expect(creates).toBe(1);
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    const tokens = runtimeConnectorTokens("owned-native-secret", f.attemptID, 1);
    const headers = {
      authorization: `Bearer ${tokens.parent}`,
      "x-factory-runtime-attempt": f.attemptID,
      "x-factory-runtime-generation": "1",
      "x-factory-connector-role": "parent",
      "x-factory-runtime-actor-uid": started?.native?.actorUID ?? "",
    };
    const request = () => new Request("https://factory.test/internal/runtime-connect", { headers });
    expect(f.hub.authorize(request(), hashConnectorToken)).not.toBeNull();
    expect(await c.authorizeConnector(request())).toBe(true);
    setNativeState("ACTOR_STATE_CRASHED");
    expect(await c.authorizeConnector(request())).toBe(false);
    setNativeState("ACTOR_STATE_RUNNING");
    headers["x-factory-runtime-actor-uid"] = crypto.randomUUID();
    expect(f.hub.authorize(request(), hashConnectorToken)).toBeNull();
    expect(await c.authorizeConnector(request())).toBe(false);
    headers["x-factory-runtime-actor-uid"] = started?.native?.actorUID ?? "";
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID}`;
    expect(await c.authorizeConnector(request())).toBe(false);
    await f.database
      .client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${f.projectID}`;
    await expect(c.stop(f.attemptID)).rejects.toThrow("lost Delete reply");
    expect(await c.authorizeConnector(request())).toBe(false);
    expect((await c.stop(f.attemptID))?.state).toBe("stopped");
    expect(deletes).toBe(1);
    expect(creates).toBe(1);
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("retired");
    await expect(
      Promise.resolve(
        f.database
          .client`DELETE FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`,
      ),
    ).rejects.toThrow("cannot be reused");
  } finally {
    await f.dispose();
  }
}, 60_000);

test("Factory Suspend rejects local-only/async snapshots, independently checks generation, and retains the last good ROOTFS checkpoint", async () => {
  const f = await substrateFixture();
  let actor: NativeActor | null = null,
    durable = true,
    mismatch = false;
  let lostSuspendReply = true;
  let suspends = 0;
  let checkpoints = 0;
  const c = f.controller(async (method, request) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = nativeActor.parse(f.actor());
      return actor;
    }
    if (method === "ResumeActor") {
      if (!actor) throw new Error("missing");
      actor.status.state = "ACTOR_STATE_RUNNING";
      actor.metadata.version = String(Number(actor.metadata.version) + 1);
      actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      return { actor };
    }
    if (method === "SuspendActor" && actor) {
      suspends++;
      expect(request).toEqual({
        actor: { atespace: f.atespace, name: actor.metadata.name },
        options: { mode: "DURABILITY_MODE_SYNCHRONOUS" },
      });
      if (actor.status.state === "ACTOR_STATE_SUSPENDING") {
        actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
        actor.status.state = "ACTOR_STATE_SUSPENDED";
        for (const value of actor.status.snapshots ?? []) {
          const snapshot = value as { durableSnapshot: { state: string } };
          snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_COMPLETED";
        }
        return { actor: structuredClone(actor) };
      }
      checkpoints++;
      const uuid = crypto.randomUUID();
      actor.metadata.version = String(Number(actor.metadata.version) + 1);
      actor.status.state = "ACTOR_STATE_SUSPENDED";
      actor.status.lastAssignedGeneration = (actor.status.lastAssignedGeneration ?? 0) + 1;
      actor.status.snapshots = [
        {
          uuid,
          generation: actor.status.lastAssignedGeneration,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: f.config.templateUID,
          sandboxRuntime: f.config.runtime,
          durableSnapshot: {
            state: durable ? "SNAPSHOT_STORAGE_STATE_COMPLETED" : "SNAPSHOT_STORAGE_STATE_PENDING",
            object: {
              snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
            },
          },
        },
      ];
      const reply = structuredClone(actor);
      if (mismatch) actor.status.lastAssignedGeneration++;
      if (lostSuspendReply) {
        lostSuspendReply = false;
        throw new SubstrateRPCError("Unavailable", "lost Suspend reply");
      }
      return { actor: reply };
    }
    throw new Error(`Unexpected ${method}`);
  });
  try {
    await c.start(f.projectID, f.userID);
    await expect(c.pause(f.attemptID)).rejects.toThrow("lost Suspend reply");
    const pending = nativeActor.parse(actor);
    actor = pending;
    pending.status.state = "ACTOR_STATE_RESUMING";
    pending.metadata.version = String(BigInt(pending.metadata.version) + 1n);
    await expect(c.pause(f.attemptID)).rejects.toThrow("unsettled");
    expect(suspends).toBe(1);
    pending.status.state = "ACTOR_STATE_SUSPENDING";
    for (const value of pending.status.snapshots ?? []) {
      const snapshot = value as { durableSnapshot: { state: string } };
      snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_PENDING";
    }
    pending.metadata.version = String(BigInt(pending.metadata.version) + 1n);
    await expect(c.pause(f.attemptID)).rejects.toThrow("not confirmed durable");
    expect(suspends).toBe(1);
    expect(checkpoints).toBe(1);
    for (const value of pending.status.snapshots ?? []) {
      const snapshot = value as { durableSnapshot: { state: string } };
      snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_COMPLETED";
    }
    pending.metadata.version = String(BigInt(pending.metadata.version) + 1n);
    expect((await c.pause(f.attemptID))?.state).toBe("paused");
    expect(suspends).toBe(2);
    expect(checkpoints).toBe(1);
    expect((await c.pause(f.attemptID))?.state).toBe("paused");
    expect(suspends).toBe(2);
    const [good] = await f.database
      .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
    expect(good?.["checkpoint"].generation).toBe(1);
    await c.resumeForApp(f.attemptID, f.userID);
    durable = false;
    await expect(c.pause(f.attemptID)).rejects.toThrow();
    await expect(c.resumeForApp(f.attemptID, f.userID)).rejects.toThrow();
    expect(
      (
        await f.database
          .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`
      )[0]?.["checkpoint"],
    ).toEqual(good?.["checkpoint"]);
    durable = true;
    // The independently observed upload completes before an explicit Resume;
    // a pending snapshot is never upgraded by repeating Suspend.
    const completed = nativeActor.parse(actor);
    for (const value of completed.status.snapshots ?? []) {
      const snapshot = value as { durableSnapshot: { state: string } };
      snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_COMPLETED";
    }
    completed.metadata.version = String(BigInt(completed.metadata.version) + 1n);
    actor = completed;
    await c.resumeForApp(f.attemptID, f.userID);
    mismatch = true;
    await expect(c.pause(f.attemptID)).rejects.toThrow("generation");
    expect(
      (
        await f.database
          .client`SELECT checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`
      )[0]?.["checkpoint"],
    ).toEqual(good?.["checkpoint"]);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native observation rejects stale version and recreated UID; AlreadyExists is never later adopted", async () => {
  const f = await substrateFixture();
  let actor: ReturnType<typeof f.actor> | null = null;
  const c = f.controller(async (method) => {
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
      actor.status.state = "ACTOR_STATE_RUNNING";
      actor.metadata.version = "3";
      actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      return { actor };
    }
    throw new Error(`Unexpected ${method}`);
  });
  try {
    await c.start(f.projectID, f.userID);
    if (!actor) throw new Error("fixture not created");
    const observed = actor as ReturnType<typeof f.actor>;
    observed.metadata.version = "2";
    await expect(c.get(f.attemptID)).rejects.toThrow("Stale");
    observed.metadata.version = "4";
    observed.metadata.uid = crypto.randomUUID();
    await expect(c.get(f.attemptID)).rejects.toThrow("binding");
  } finally {
    await f.dispose();
  }
  const rejected = await substrateFixture();
  let existing = false,
    creates = 0;
  const refused = rejected.controller(async (method) => {
    if (method === "GetAtespace") return rejected.space;
    if (method === "GetActorTemplate") return rejected.template;
    if (method === "GetActor") {
      if (existing) return rejected.actor();
      throw new SubstrateRPCError("NotFound", "absent");
    }
    if (method === "CreateActor") {
      creates++;
      existing = true;
      throw new SubstrateRPCError("AlreadyExists", "racing foreign Actor");
    }
    throw new Error(`Unexpected ${method}`);
  });
  try {
    await expect(refused.start(rejected.projectID, rejected.userID)).rejects.toThrow(
      "racing foreign",
    );
    await expect(refused.start(rejected.projectID, rejected.userID)).rejects.toThrow(
      "never adopted",
    );
    expect(creates).toBe(1);
  } finally {
    await rejected.dispose();
  }
}, 60_000);

test("Factory refuses preexisting Actors, unauthorized users and changed template identity without Create", async () => {
  const f = await substrateFixture();
  let calls = 0,
    foreign = true;
  const c = f.controller(async (method) => {
    calls++;
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor" && foreign) return f.actor();
    throw new Error(`Must not dispatch ${method}`);
  });
  try {
    await expect(c.start(f.projectID, crypto.randomUUID())).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("already-existing");
    foreign = false;
    f.template.metadata.uid = crypto.randomUUID();
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("binding changed");
    const [saved] = await f.database
      .client`SELECT create_attempted_at,actor_uid FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
    expect(saved?.["create_attempted_at"]).toBeNull();
    expect(saved?.["actor_uid"]).toBeNull();
  } finally {
    await f.dispose();
  }
}, 60_000);
