import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runtimeConnectorTokens } from "#runtime-domain/identity";
import { SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { runtimeAttemptSchema } from "../../apps/factory/src/runtime/contracts";
import { objectDigest, type PrivateObjects } from "../../apps/factory/src/storage/objects";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { substrateFixture } from "../fixtures/substrate";

test.each(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"])(
  "native durable pause retains the sole Actor Source without a writer transfer (%s)",
  async (fidelity) => {
    const f = await substrateFixture();
    let actor: ReturnType<typeof f.actor> | undefined;
    const effects: string[] = [];
    const controller = await f.controller(
      async (method) => {
        if (method === "GetAtespace") return f.space;
        if (method === "GetActorTemplate") return f.template;
        if (method === "GetActor") {
          if (!actor) throw new SubstrateRPCError("NotFound", "absent");
          return structuredClone(actor);
        }
        effects.push(method);
        if (method === "CreateActor") {
          actor = await f.createdActor();
          return structuredClone(actor);
        }
        if (method === "ResumeActor" && actor) {
          actor.metadata.version = String(Number(actor.metadata.version) + 1);
          actor.status = {
            ...actor.status,
            state: "ACTOR_STATE_RUNNING",
            ...(actor.status.snapshots?.length ? { lastAssignedGeneration: 1 } : {}),
            workerAssignment: { sandboxRuntime: f.config.runtime },
          };
          return { actor: structuredClone(actor) };
        }
        if (method === "SuspendActor" && actor) {
          const uuid = crypto.randomUUID();
          actor.metadata.version = String(Number(actor.metadata.version) + 1);
          actor.status = {
            state: "ACTOR_STATE_SUSPENDED",
            lastAssignedGeneration: 1,
            snapshots: [
              {
                uuid,
                generation: 1,
                owner: "SNAPSHOT_OWNER_ACTOR",
                fidelity,
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
        throw new Error(`Unexpected native effect ${method}`);
      },
      {
        async attach(_workspaceID, actorUID, sql) {
          const [current] = await sql<{ actorUID: string }[]>`
            SELECT actor_uid AS "actorUID" FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`;
          if (current) expect(current.actorUID).toBe(actorUID);
          else await f.admitActorSource(actorUID, sql);
        },
        async resume() {},
        async freezeActor() {
          throw new Error("ordinary Pause must not freeze/copy Source");
        },
        async makeIndependent() {
          throw new Error("ordinary Pause must not transfer Source");
        },
        async requireIndependent() {
          throw new Error("native Actor remains canonical");
        },
      },
    );
    try {
      await controller.start(f.projectID, f.userID);
      f.hub.sourceConnected = () => true;
      const before = [
        ...(await f.database
          .client`SELECT * FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
      ];
      await controller.pause(f.attemptID);
      expect((await controller.get(f.attemptID))?.state).toBe("paused");
      expect([
        ...(await f.database
          .client`SELECT * FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
      ]).toEqual(before);
      await controller.start(f.projectID, f.userID);
      expect([
        ...(await f.database
          .client`SELECT * FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
      ]).toEqual(before);
      expect(effects).toEqual(["CreateActor", "ResumeActor", "SuspendActor", "ResumeActor"]);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("final Stop hands off a confirmed Source export without ROOTFS and cannot reopen execution", async () => {
  const f = await substrateFixture();
  let actor: ReturnType<typeof f.actor> | undefined;
  const effects: string[] = [];
  const source = createSubstrateSources(f.database, f.hub, memoryPrivateObjects());
  const controller = await f.controller(
    async (method) => {
      if (method === "GetAtespace") return f.space;
      if (method === "GetActorTemplate") return f.template;
      if (method === "GetActor") {
        if (!actor) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(actor);
      }
      effects.push(method);
      if (method === "CreateActor") {
        actor = await f.createdActor();
        return structuredClone(actor);
      }
      if (method === "ResumeActor" && actor) {
        actor.metadata.version = "2";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        return { actor: structuredClone(actor) };
      }
      throw new Error(`Unexpected native effect ${method}`);
    },
    {
      ...source,
      async attach(workspaceID, actorUID, sql) {
        // Controlled already-granted Source, independent of cold import proof.
        await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${workspaceID},${actorUID})`;
      },
    },
  );
  const bytes = new TextEncoder().encode("controlled complete Source export");
  const bundle = {
    version: 1,
    bytes: bytes.length,
    sha256: objectDigest(bytes),
    chunks: [objectDigest(bytes)],
  };
  try {
    await controller.start(f.projectID, f.userID);
    const uid = actor?.metadata.uid;
    if (!uid) throw new Error("Original native Actor is missing");
    f.hub.sourceConnected = () => true;
    const writerDrains: string[] = [];
    let denyWorkDrain = true;
    f.hub.childOperation = async (_id, operation) => {
      expect(operation["action"]).toBe("source-drain");
      if (denyWorkDrain) throw new Error("owned Work writer barrier unavailable");
      writerDrains.push("work");
    };
    f.hub.parentOperation = async (_id, operation) => {
      expect(operation.action).toBe("source-drain");
      expect(operation["data"]).toBe(operation.operationId);
      expect(writerDrains.at(-1)).toBe("work");
      writerDrains.push("control");
      return {};
    };
    f.hub.request = async (_id, _channel, _request, path) => {
      expect(writerDrains.slice(-2)).toEqual(["work", "control"]);
      return path.endsWith("/checkpoint") ? Response.json(bundle) : new Response(bytes);
    };
    await expect(source.freezeActor(f.workspaceID, f.attemptID, f.database.client)).rejects.toThrow(
      "owned Work writer barrier unavailable",
    );
    expect(writerDrains).toEqual([]);
    expect(effects).toEqual(["CreateActor", "ResumeActor"]);
    denyWorkDrain = false;
    await source.freezeActor(f.workspaceID, f.attemptID, f.database.client);
    const transfer = async () =>
      await f.database.client`UPDATE factory.substrate_source
      SET owner='service',writable=true,writer_epoch=writer_epoch+1,service_base=checkpoint_id,checkpoint_id=NULL
      WHERE workspace_id=${f.workspaceID}`;
    await expect(transfer()).rejects.toThrow("durable paused ROOTFS");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${f.attemptID}`;
    const request = (role: "parent" | "child") =>
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
    await transfer();
    expect(await controller.authorizeConnector(request("parent"))).toBe(false);
    expect(await source.lease(f.workspaceID)).toMatchObject({
      actorUID: uid,
      owner: "service",
      writable: true,
      generation: 1,
    });
    const [saved] = await f.database
      .client`SELECT checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(saved?.["checkpoint"]).toBeNull();
    expect(effects).toEqual(["CreateActor", "ResumeActor"]);
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.runtime_attempt SET stop_intended_at=NULL,state='ready' WHERE id=${f.attemptID}`,
      ),
    ).rejects.toThrow("cannot be cleared");
    await expect(controller.start(f.projectID, f.userID)).rejects.toThrow("retired");
    await expect(controller.pause(f.attemptID)).rejects.toThrow("stopping");
  } finally {
    await source.close();
    await f.dispose();
  }
}, 60_000);

test("native Ticket Source uses the Change writer fence, not storage ownership, and handoff cannot deadlock a save", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const actorUID = crypto.randomUUID();
  const calls: { operation: string; epoch: string | null; body: Record<string, unknown> }[] = [];
  f.hub.sourceConnected = () => true;
  f.hub.request = async (_attempt, channel, request, path) => {
    expect(channel).toBe("source");
    calls.push({
      operation: path.split("/").at(-1) ?? "",
      epoch: request.headers.get("X-Factory-Writer-Epoch"),
      body: await request.json(),
    });
    return Response.json({ confirmed: true });
  };
  const native = createSubstrateSources(f.database, f.hub);
  const source = createWorkspaceSourceController(f.database, f.hub, native);
  const lifecycle = f.database.coordination();
  let held = false;
  try {
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${f.workspaceID},'workspace','{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,create_intended_at,created_by,atespace,actor_name,binding_intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},now(),${f.userID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`UPDATE factory.change_writer SET state='human',epoch=42,user_id=${f.userID} WHERE change_id=${f.changeID}`;
    });
    await f.admitActorSource(actorUID);
    const request = () =>
      new Request("https://factory.test/source/write", {
        method: "POST",
        headers: { "X-Factory-Writer-Epoch": "999" },
        body: '{"path":"owned","content":"eA=="}',
      });
    expect((await source.forward(f.workspaceID, f.userID, "write", request())).status).toBe(200);
    expect(calls).toEqual([
      { operation: "fence", epoch: null, body: { writerEpoch: 42, writable: true } },
      { operation: "write", epoch: "42", body: { path: "owned", content: "eA==" } },
    ]);
    await source.fenceChange(f.changeID, "43", false);
    expect(calls.at(-1)?.body).toEqual({ writerEpoch: 43, writable: false });
    expect((await native.lease(f.workspaceID))?.writerEpoch).toBe(1);
    await lifecycle`SELECT pg_advisory_lock(hashtext(${`source:${f.workspaceID}`}))`;
    held = true;
    await expect(source.fenceChange(f.changeID, "44", false)).rejects.toThrow(
      "Source owner is busy",
    );
    await lifecycle`SELECT pg_advisory_unlock(hashtext(${`source:${f.workspaceID}`}))`;
    held = false;
    await f.database
      .client`UPDATE factory.change_writer SET state='unassigned',user_id=NULL,epoch=44 WHERE change_id=${f.changeID}`;
    await expect(source.forward(f.workspaceID, f.userID, "write", request())).rejects.toThrow(
      "observation-only",
    );
    const count = calls.length;
    expect((await source.forward(f.workspaceID, f.userID, "read", request())).status).toBe(200);
    expect(calls).toHaveLength(count + 1);
    await f.database
      .client`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`;
    await expect(source.fenceChange(f.changeID, "45", true)).rejects.toThrow(
      "Source owner is frozen",
    );
    await expect(source.forward(f.workspaceID, f.userID, "read", request())).rejects.toThrow(
      "frozen or unavailable",
    );
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source,
        to_regclass('factory.factorybox_worker') AS worker`),
    ]).toEqual([{ source: null, worker: null }]);
  } finally {
    if (held) await lifecycle`SELECT pg_advisory_unlock(hashtext(${`source:${f.workspaceID}`}))`;
    await lifecycle.end({ timeout: 1 });
    await source.close();
    await f.dispose();
  }
}, 60_000);

test("native editor metadata queues brief contention under the existing exclusive lock but still refuses a long lifecycle operation", async () => {
  const f = await substrateFixture();
  const actorUID = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  f.hub.sourceConnected = () => true;
  f.hub.request = async () => {
    calls++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (calls === 1) {
      entered.resolve();
      await release.promise;
    }
    active--;
    return Response.json({ content: "eA==", version: "owned-current-version" });
  };
  const native = createSubstrateSources(f.database, f.hub);
  const source = createWorkspaceSourceController(f.database, f.hub, native);
  const lifecycle = f.database.coordination();
  let held = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reads: Promise<Response>[] = [];
  const request = () =>
    new Request("https://factory.test/source/read", {
      method: "POST",
      body: '{"path":"package.json"}',
    });
  try {
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${f.workspaceID},'workspace','{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,create_intended_at,created_by,atespace,actor_name,binding_intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},now(),${f.userID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
    });
    await f.admitActorSource(actorUID);
    reads.push(source.forward(f.workspaceID, f.userID, "read", request()));
    await entered.promise;
    for (let i = 0; i < 3; i++)
      reads.push(source.forward(f.workspaceID, f.userID, "read", request()));
    const completed = Promise.all(reads);
    timer = setTimeout(() => release.resolve(), 200);
    for (const response of await completed) expect(response.status).toBe(200);
    expect(calls).toBe(4);
    expect(maximumActive).toBe(1);
    await lifecycle`SELECT pg_advisory_lock(hashtext(${`source:${f.workspaceID}`}))`;
    held = true;
    await expect(source.forward(f.workspaceID, f.userID, "read", request())).rejects.toThrow(
      "Source owner is busy",
    );
    expect(calls).toBe(4);
    expect(await native.lease(f.workspaceID)).toMatchObject({
      owner: "actor",
      writable: true,
      writerEpoch: 1,
      generation: 0,
    });
  } finally {
    release.resolve();
    if (timer) clearTimeout(timer);
    await Promise.allSettled(reads);
    if (held) await lifecycle`SELECT pg_advisory_unlock(hashtext(${`source:${f.workspaceID}`}))`;
    await lifecycle.end({ timeout: 1 });
    await source.close();
    await f.dispose();
  }
}, 60_000);

test("Source lease/confirmed generation survives lost upload reply, rejects stale transfer and retains the original writer until durable ROOTFS", async () => {
  const f = await substrateFixture();
  let actor: ReturnType<typeof f.actor> | null = null;
  const controller = await f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = await f.createdActor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      actor.status.state = "ACTOR_STATE_RUNNING";
      actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
      actor.metadata.version = "2";
      return { actor };
    }
    throw new Error("Unexpected native fixture operation");
  });
  const bytes = new TextEncoder().encode("bounded immutable export protocol fixture");
  const bundle = {
    version: 1,
    bytes: bytes.length,
    sha256: objectDigest(bytes),
    chunks: [objectDigest(bytes)],
  };
  const stored = new Map<string, Uint8Array>();
  let lost = true;
  let checkpointFailure: string | undefined;
  let removed = 0;
  const drained: string[] = [];
  const objects: PrivateObjects = {
    async put(key, data) {
      const old = stored.get(key);
      if (old && objectDigest(old) !== objectDigest(data))
        throw new Error("immutable object changed");
      stored.set(key, new Uint8Array(data));
      if (lost && key.endsWith("chunk-0")) {
        lost = false;
        throw new Error("lost upload reply");
      }
    },
    async read(key) {
      const data = stored.get(key);
      if (!data) throw new Error("missing owned Source object");
      return new Uint8Array(data);
    },
    async remove() {
      removed++;
    },
    async open() {
      throw new Error("not used");
    },
  };
  f.hub.parentOperation = async (_id, operation) => {
    expect(operation["data"]).toBe(operation.operationId);
    expect(workDrained.at(-1)).toBe(operation.operationId);
    drained.push(operation.operationId);
    return {};
  };
  const workDrained: string[] = [];
  f.hub.childOperation = async (_id, operation) => {
    expect(operation["action"]).toBe("source-drain");
    workDrained.push(operation["operationId"] ?? "");
  };
  f.hub.sourceConnected = () => true;
  f.hub.request = async (_attempt, channel, request, path) => {
    expect(channel).toBe("source");
    const body = await request.json();
    expect(body.writerEpoch).toBe(2);
    if (path.endsWith("/checkpoint") && checkpointFailure)
      return Response.json(
        { error: "private error text must not be forwarded" },
        {
          status: 503,
          headers: { "X-Factory-Source-Checkpoint-Failure": checkpointFailure },
        },
      );
    return path.endsWith("/checkpoint") ? Response.json(bundle) : new Response(bytes);
  };
  const source = createSubstrateSources(f.database, f.hub, objects);
  let publication: ReturnType<typeof createSubstrateSources> | undefined;
  let stateDirectory: string | undefined;
  try {
    await controller.start(f.projectID, f.userID);
    const uid = (await controller.get(f.attemptID))?.native?.actorUID;
    if (!uid) throw new Error("original Actor fixture UID missing");
    await f.admitActorSource(uid);
    const token = runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent;
    const request = (extra: Record<string, string> = {}) =>
      new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
        headers: {
          authorization: `Bearer ${token}`,
          "X-Factory-Runtime-Actor-UID": uid,
          "X-Factory-Runtime-Generation": "1",
          ...extra,
        },
      });
    // A granted Actor must never replay its initial import over later writes.
    expect((await source.restoreEndpoint(request(), f.attemptID)).status).toBe(403);
    expect(
      (
        await source.restoreEndpoint(
          request({ "X-Factory-Runtime-Actor-UID": crypto.randomUUID() }),
          f.attemptID,
        )
      ).status,
    ).toBe(403);
    expect(
      (await source.restoreEndpoint(request({ "X-Factory-Runtime-Generation": "2" }), f.attemptID))
        .status,
    ).toBe(403);
    checkpointFailure = "ownership-mode";
    await expect(source.freezeActor(f.workspaceID, f.attemptID, f.database.client)).rejects.toThrow(
      "Complete Source checkpoint is unavailable (HTTP 503; ownership-mode); original owner remains fenced",
    );
    checkpointFailure = "private-source-name-sensitive-capability";
    await expect(source.freezeActor(f.workspaceID, f.attemptID, f.database.client)).rejects.toThrow(
      "Complete Source checkpoint is unavailable (HTTP 503); original owner remains fenced",
    );
    checkpointFailure = undefined;
    await expect(source.freezeActor(f.workspaceID, f.attemptID, f.database.client)).rejects.toThrow(
      "lost upload reply",
    );
    const frozen = await source.lease(f.workspaceID);
    expect(frozen).toMatchObject({
      owner: "actor",
      writerEpoch: 2,
      writable: false,
      generation: 0,
      checkpoint: null,
    });
    if (!frozen?.checkpointID) throw new Error("Frozen Source checkpoint identity missing");
    // postgres-js queries are lazy thenables. Assimilate them before Bun's
    // rejection matcher so these safety assertions actually dispatch the SQL.
    const move = async () =>
      await f.database
        .client`UPDATE factory.substrate_source SET owner='service',writer_epoch=3,writable=true,service_base=checkpoint_id,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
    await expect(move()).rejects.toThrow("completely confirmed");
    await source.freezeActor(f.workspaceID, f.attemptID, f.database.client);
    const confirmed = await source.lease(f.workspaceID);
    expect(confirmed).toMatchObject({
      owner: "actor",
      writerEpoch: 2,
      writable: false,
      generation: 1,
    });
    expect(confirmed?.checkpoint?.id).toBe(frozen?.checkpointID);
    expect(new Set(drained).size).toBe(1);
    expect(stored.size).toBe(2);
    expect(removed).toBe(0);
    await source.freezeActor(f.workspaceID, f.attemptID, f.database.client);
    expect(drained).toHaveLength(4);
    await expect(move()).rejects.toThrow("durable paused ROOTFS");
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_source SET writer_epoch=1 WHERE workspace_id=${f.workspaceID}`,
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_source SET actor_uid=${crypto.randomUUID()} WHERE workspace_id=${f.workspaceID}`,
      ),
    ).rejects.toThrow();
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='pausing' WHERE id=${f.attemptID}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET checkpoint=${JSON.stringify({ actorUID: uid, fidelity: "SNAPSHOT_FIDELITY_ROOTFS", generation: 1, durableSnapshot: { state: "SNAPSHOT_STORAGE_STATE_COMPLETED" } })}::text::jsonb,observation=${JSON.stringify({ status: { state: "ACTOR_STATE_SUSPENDED", lastAssignedGeneration: 1 } })}::text::jsonb WHERE id=${f.attemptID}`;
    await move();
    const suspended = actor as ReturnType<typeof f.actor> | null;
    if (!suspended) throw new Error("Owned Actor observation missing");
    const snapshot = {
      uuid: crypto.randomUUID(),
      generation: 1,
      owner: "SNAPSHOT_OWNER_ACTOR",
      fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
      actorTemplateUid: f.config.templateUID,
      sandboxRuntime: f.config.runtime,
      durableSnapshot: { state: "SNAPSHOT_STORAGE_STATE_COMPLETED", object: { snapshotUri: "" } },
    };
    snapshot.durableSnapshot.object.snapshotUri = `s3://owned/prefix/atespaces/${f.atespace}/actors/${uid}/snapshots/${snapshot.uuid}`;
    suspended.status = {
      state: "ACTOR_STATE_SUSPENDED",
      lastAssignedGeneration: 1,
      snapshots: [snapshot],
    };
    suspended.metadata.version = "3";
    await f.database
      .client`UPDATE factory.runtime_attempt SET checkpoint=${JSON.stringify({ actorUID: uid, templateUID: f.config.templateUID, ...snapshot })}::text::jsonb,observation=${JSON.stringify(suspended)}::text::jsonb WHERE id=${f.attemptID}`;
    const pausedView = await controller.get(f.attemptID);
    expect(pausedView?.native).toMatchObject({
      sourceHandoff: "confirmed-same-node",
      portable: false,
      state: "ACTOR_STATE_SUSPENDED",
    });
    expect(
      runtimeAttemptSchema.parse(JSON.parse(JSON.stringify(pausedView))).native?.sourceHandoff,
    ).toBe("confirmed-same-node");
    // Neither a pending snapshot nor a different UUID inherits confirmation.
    snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_PENDING";
    suspended.metadata.version = "4";
    await expect(controller.get(f.attemptID)).rejects.toThrow();
    snapshot.durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_COMPLETED";
    const originalSnapshot = snapshot.uuid;
    snapshot.uuid = crypto.randomUUID();
    snapshot.durableSnapshot.object.snapshotUri = `s3://owned/prefix/atespaces/${f.atespace}/actors/${uid}/snapshots/${snapshot.uuid}`;
    suspended.metadata.version = "5";
    await expect(controller.get(f.attemptID)).rejects.toThrow("snapshot identity differs");
    snapshot.uuid = originalSnapshot;
    snapshot.durableSnapshot.object.snapshotUri = `s3://owned/prefix/atespaces/${f.atespace}/actors/${uid}/snapshots/${snapshot.uuid}`;
    suspended.metadata.version = "6";
    expect(await source.lease(f.workspaceID)).toMatchObject({
      owner: "service",
      writerEpoch: 3,
      writable: true,
      generation: 1,
      serviceBase: frozen?.checkpointID,
    });
    const lifecycle = f.database.coordination();
    try {
      await lifecycle`SELECT pg_advisory_lock(hashtext(${`source:${f.workspaceID}`}))`;
      // Status cannot start another Source process during an ownership change.
      expect(await source.available(f.workspaceID)).toBe(false);
    } finally {
      await lifecycle`SELECT pg_advisory_unlock(hashtext(${`source:${f.workspaceID}`}))`;
      await lifecycle.end({ timeout: 1 });
    }
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_source SET owner='actor',writer_epoch=4 WHERE workspace_id=${f.workspaceID}`,
      ),
    ).rejects.toThrow();
    expect((await source.restoreEndpoint(request(), f.attemptID)).status).toBe(403);
    expect(removed).toBe(0);
    await mkdir(".factory/test-results", { recursive: true });
    stateDirectory = await mkdtemp(resolve(".factory/test-results/source-publication-"));
    const priorState = process.env["FACTORY_STATE_DIRECTORY"];
    const priorBinary = process.env["FACTORY_SOURCE_SERVICE_BINARY"];
    try {
      process.env["FACTORY_STATE_DIRECTORY"] = stateDirectory;
      process.env["FACTORY_SOURCE_SERVICE_BINARY"] = join(stateDirectory, "unavailable-connector");
      publication = createSubstrateSources(f.database, f.hub, objects);
    } finally {
      if (priorState === undefined) delete process.env["FACTORY_STATE_DIRECTORY"];
      else process.env["FACTORY_STATE_DIRECTORY"] = priorState;
      if (priorBinary === undefined) delete process.env["FACTORY_SOURCE_SERVICE_BINARY"];
      else process.env["FACTORY_SOURCE_SERVICE_BINARY"] = priorBinary;
    }
    const base = join(stateDirectory, "workspace-source", f.workspaceID, frozen.checkpointID);
    await expect(publication.available(f.workspaceID)).rejects.toThrow();
    // Failed extraction never publishes a canonical directory without its
    // confirmation. Unknown older trees are preserved rather than adopted.
    await expect(lstat(base)).rejects.toThrow();
    await mkdir(join(base, "project"), { recursive: true });
    await writeFile(join(base, "project", "private.txt"), "retained private file", { mode: 0o600 });
    await expect(publication.available(f.workspaceID)).rejects.toThrow(
      "Unconfirmed existing Source was preserved",
    );
    const savedCheckpoint = (await source.lease(f.workspaceID))?.checkpoint;
    if (!savedCheckpoint) throw new Error("Confirmed Source checkpoint missing");
    await writeFile(
      join(base, "confirmed.json"),
      JSON.stringify({ ...savedCheckpoint, workspaceID: crypto.randomUUID() }),
      { mode: 0o600 },
    );
    await expect(publication.available(f.workspaceID)).rejects.toThrow(
      "Source materialization identity changed",
    );
    expect(await readFile(join(base, "project", "private.txt"), "utf8")).toBe(
      "retained private file",
    );
    expect(await source.lease(f.workspaceID)).toMatchObject({
      owner: "service",
      writable: true,
      generation: 1,
    });
  } finally {
    await publication?.close();
    await source.close();
    await f.dispose();
    if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
  }
}, 60_000);

test("native Ticket Source forwards Change writer epochs and handoff fences, never storage ownership as human authority", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const uid = crypto.randomUUID();
  const calls: { operation: string; epoch: string | null; body: Record<string, unknown> }[] = [];
  let fenceConfirmed = true;
  f.hub.sourceConnected = () => true;
  f.hub.request = async (_attempt, channel, request, path) => {
    expect(channel).toBe("source");
    const operation = path.split("/").at(-1) ?? "";
    calls.push({
      operation,
      epoch: request.headers.get("X-Factory-Writer-Epoch"),
      body: await request.json(),
    });
    return Response.json(
      { confirmed: fenceConfirmed },
      { status: operation === "fence" && !fenceConfirmed ? 409 : 200 },
    );
  };
  const native = createSubstrateSources(f.database, f.hub);
  const source = createWorkspaceSourceController(f.database, f.hub, native);
  const lifecycle = f.database.coordination();
  try {
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${f.workspaceID},'workspace','{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,create_intended_at,created_by,atespace,actor_name,binding_intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},now(),${f.userID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${uid},now())`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change_writer SET state='human',epoch=42,user_id=${f.userID} WHERE change_id=${f.changeID}`;
      await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${f.workspaceID},${uid})`;
    });
    const request = () =>
      new Request("https://factory.test/source", {
        method: "POST",
        headers: { "X-Factory-Writer-Epoch": "1" },
        body: JSON.stringify({ path: "owned.txt", content: "eA==" }),
      });
    expect((await source.forward(f.workspaceID, f.userID, "write", request())).status).toBe(200);
    expect(
      calls.map((c) => ({
        operation: c.operation,
        epoch: c.epoch,
        writerEpoch: c.body["writerEpoch"],
      })),
    ).toEqual([
      { operation: "fence", epoch: null, writerEpoch: 42 },
      { operation: "write", epoch: "42", writerEpoch: undefined },
    ]);
    expect((await native.lease(f.workspaceID))?.writerEpoch).toBe(1);
    await source.fenceChange(f.changeID, "43", false);
    expect(calls.at(-1)).toMatchObject({
      operation: "fence",
      body: { writerEpoch: 43, writable: false },
    });
    fenceConfirmed = false;
    await expect(source.fenceChange(f.changeID, "44", false)).rejects.toThrow("unconfirmed");
    fenceConfirmed = true;
    await lifecycle`SELECT pg_advisory_lock(hashtext(${`source:${f.workspaceID}`}))`;
    try {
      await expect(source.fenceChange(f.changeID, "44", false)).rejects.toThrow("busy");
    } finally {
      await lifecycle`SELECT pg_advisory_unlock(hashtext(${`source:${f.workspaceID}`}))`;
    }
    await f.database
      .client`UPDATE factory.change_writer SET state='unassigned',user_id=NULL,epoch=44 WHERE change_id=${f.changeID}`;
    const count = calls.length;
    await expect(source.forward(f.workspaceID, f.userID, "write", request())).rejects.toThrow(
      "observation-only",
    );
    expect(calls).toHaveLength(count);
    expect((await source.forward(f.workspaceID, f.userID, "read", request())).status).toBe(200);
    expect([
      ...(await f.database.client`SELECT to_regclass('factory.workspace_source') AS source`),
    ]).toEqual([{ source: null }]);
  } finally {
    await lifecycle.end({ timeout: 1 });
    await source.close();
    await f.dispose();
  }
}, 60_000);
