import { expect, test } from "bun:test";
import type { DatabaseTransaction } from "../../packages/db/src/client";
import { runtimeConnectorTokens } from "../../packages/runtime-domain/src/identity";
import {
  type NativeActor,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

test("native Drizzle admission commits typed JSON and database-clock intent before Create dispatch", async () => {
  const f = await substrateFixture();
  f.config.environment = { version: 0, secretKey: null };
  f.config.declaredApps = ["web", "api"];
  let actor: NativeActor | undefined;
  let creates = 0;
  const execution = f.execution(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      creates++;
      const [saved] = await f.database.client`
        SELECT a.workspace_id,a.change_id,a.generation,a.revision,a.declared_apps,
          a.create_intended_at::text,b.create_attempted_at::text,b.actor_uid,b.create_rejected,
          b.intent,e.environment,e.version,e.secret_key
        FROM factory.runtime_attempt a
        JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
        JOIN factory.runtime_environment_intent e ON e.runtime_attempt_id=a.id
        WHERE a.id=${f.attemptID}`;
      expect(saved).toMatchObject({
        workspace_id: f.workspaceID,
        change_id: null,
        generation: "1",
        revision: "a".repeat(40),
        declared_apps: ["web", "api"],
        actor_uid: null,
        create_rejected: false,
        intent: { environment: f.config.environment, declaredApps: ["web", "api"] },
        environment: "development",
        version: "0",
        secret_key: null,
      });
      expect(Number.isFinite(Date.parse(saved?.["create_intended_at"]))).toBe(true);
      expect(Number.isFinite(Date.parse(saved?.["create_attempted_at"]))).toBe(true);
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
    if (method === "GetActorEgressPolicy")
      return {
        metadata: { ...f.space.metadata, atespace: f.atespace, name: "default" },
        rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
      };
    throw Error(`Unexpected controlled native operation ${method}`);
  });
  try {
    expect(await execution.start(f.userID)).toBe(f.attemptID);
    const [saved] = await f.database.client`
      SELECT actor_uid,observation,checkpoint FROM factory.substrate_binding
      WHERE runtime_attempt_id=${f.attemptID}`;
    expect(saved).toMatchObject({
      actor_uid: actor?.metadata.uid,
      observation: actor,
      checkpoint: null,
    });
    expect(await execution.start(f.userID)).toBe(f.attemptID);
    expect(creates).toBe(1);
    expect(
      await execution.authorizeConnector(
        new Request("https://factory.test/internal/runtime-connect", {
          headers: {
            authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent}`,
            "x-factory-runtime-attempt": f.attemptID,
            "x-factory-runtime-generation": "1",
            "x-factory-runtime-actor-uid": actor?.metadata.uid ?? "",
            "x-factory-connector-role": "parent",
          },
        }),
      ),
    ).toBe(true);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native Drizzle admission rolls back with its existing Postgres.js transaction before dispatch", async () => {
  const f = await substrateFixture();
  f.config.environment = { version: 0, secretKey: null };
  const coordination = f.database.coordination;
  f.database.coordination = () => {
    const connection = coordination();
    const begin = connection.begin.bind(connection);
    connection.begin = ((action: (transaction: DatabaseTransaction) => Promise<unknown>) =>
      begin(async (transaction) => {
        const result = await action(transaction);
        const [intent] = await transaction`
          SELECT b.runtime_attempt_id FROM factory.substrate_binding b
          JOIN factory.runtime_environment_intent e ON e.runtime_attempt_id=b.runtime_attempt_id
          WHERE b.runtime_attempt_id=${f.attemptID}`;
        if (intent) throw Error("Owned admission transaction interrupted");
        return result;
      })) as typeof connection.begin;
    return connection;
  };
  let calls = 0;
  const execution = f.execution(async (method) => {
    calls++;
    throw Error(`Unexpected pre-admission native operation ${method}`);
  });
  try {
    await expect(execution.start(f.userID)).rejects.toThrow("admission transaction interrupted");
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(
      await f.database.client`SELECT runtime_attempt_id FROM factory.substrate_binding`,
    ).toHaveLength(0);
    expect(
      await f.database.client`SELECT runtime_attempt_id FROM factory.runtime_environment_intent`,
    ).toHaveLength(0);
    expect(calls).toBe(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native Drizzle observation treats an empty guarded RETURNING as a lost UID fence", async () => {
  const f = await substrateFixture();
  const competingUID = crypto.randomUUID();
  let resumes = 0;
  const execution = f.execution(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") throw new SubstrateRPCError("NotFound", "absent");
    if (method === "CreateActor") {
      const actor = await f.createdActor();
      // This separate connection changes the UID after the adapter's binding
      // read. Its guarded typed UPDATE must return no row, never trust the reply.
      await f.database.client`UPDATE factory.substrate_binding SET actor_uid=${competingUID}
        WHERE runtime_attempt_id=${f.attemptID}`;
      return actor;
    }
    if (method === "ResumeActor") resumes++;
    throw Error(`Unexpected controlled native operation ${method}`);
  });
  try {
    await expect(execution.start(f.userID)).rejects.toThrow("Actor UID binding changed");
    const [saved] = await f.database.client`
      SELECT actor_uid,observation,checkpoint FROM factory.substrate_binding
      WHERE runtime_attempt_id=${f.attemptID}`;
    expect(saved).toEqual({ actor_uid: competingUID, observation: null, checkpoint: null });
    expect(resumes).toBe(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native Drizzle pause CASE keeps initial failure, clears ready failure, and Stop retains diagnosis", async () => {
  const f = await substrateFixture();
  let actor: NativeActor | undefined;
  let deletes = 0;
  const execution = f.execution(async (method, request) => {
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
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        ...actor.status,
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    if (method === "SuspendActor" && actor) {
      const uuid = crypto.randomUUID();
      const generation = (actor.status.lastAssignedGeneration ?? 0) + 1;
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        state: "ACTOR_STATE_SUSPENDED",
        lastAssignedGeneration: generation,
        snapshots: [
          {
            uuid,
            generation,
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
      expect(request).toEqual({
        actor: { atespace: f.atespace, name: actor.metadata.name },
        options: { uid: actor.metadata.uid, version: actor.metadata.version },
      });
      deletes++;
      actor = undefined;
      return {};
    }
    if (method === "GetActorEgressPolicy")
      return {
        metadata: { ...f.space.metadata, atespace: f.atespace, name: "default" },
        rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
      };
    throw Error(`Unexpected controlled native operation ${method}`);
  });
  try {
    await execution.start(f.userID);
    await f.database.client`UPDATE factory.runtime_attempt SET failure='initial failure'
      WHERE id=${f.attemptID}`;
    await execution.suspend();
    const [initial] = await f.database.client`
      SELECT a.state,a.failure,b.checkpoint FROM factory.runtime_attempt a
      JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id WHERE a.id=${f.attemptID}`;
    expect(initial).toMatchObject({
      state: "paused",
      failure: "initial failure",
      checkpoint: { actorUID: actor?.metadata.uid, generation: 1 },
    });
    await execution.resume(f.userID);
    await f.database
      .client`UPDATE factory.runtime_attempt SET ready_at=now(),failure='ready failure'
      WHERE id=${f.attemptID}`;
    await execution.suspend();
    const [ready] = await f.database.client`
      SELECT state,failure FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(ready).toEqual({ state: "paused", failure: null });
    await f.database.client`UPDATE factory.runtime_attempt SET failure='retained diagnosis'
      WHERE id=${f.attemptID}`;
    await execution.stop();
    await execution.stop();
    const [stopped] = await f.database.client`
      SELECT a.state,a.failure,a.stop_intended_at::text,a.stopped_at::text,b.deleted_at::text
      FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      WHERE a.id=${f.attemptID}`;
    expect(stopped).toMatchObject({ state: "stopped", failure: "retained diagnosis" });
    expect(Number.isFinite(Date.parse(stopped?.["stop_intended_at"]))).toBe(true);
    expect(Number.isFinite(Date.parse(stopped?.["stopped_at"]))).toBe(true);
    expect(Number.isFinite(Date.parse(stopped?.["deleted_at"]))).toBe(true);
    expect(deletes).toBe(1);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native Drizzle wait deletion preserves non-capacity reasons and stopped or inactive attempts", async () => {
  const f = await substrateFixture();
  try {
    const runtime = await startSubstrateFixtureWorkspace(f);
    for (const reason of [
      "accounting-incomplete",
      "coding-budget-used",
      "finish-reserve-used",
      "compute-capacity",
    ]) {
      await f.database.client`INSERT INTO factory.runtime_compute_wait(attempt_id,reason)
        VALUES(${f.attemptID},${reason}) ON CONFLICT(attempt_id) DO UPDATE SET reason=EXCLUDED.reason`;
      await runtime.get(f.attemptID);
      const rows = await f.database.client`
        SELECT reason FROM factory.runtime_compute_wait WHERE attempt_id=${f.attemptID}`;
      expect([...rows]).toEqual(reason === "compute-capacity" ? [] : [{ reason }]);
    }
    await f.database.client`INSERT INTO factory.runtime_compute_wait(attempt_id,reason)
      VALUES(${f.attemptID},'compute-capacity')`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
    await runtime.get(f.attemptID);
    expect(await f.database.client`SELECT reason FROM factory.runtime_compute_wait`).toHaveLength(
      1,
    );
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='starting',stop_intended_at=now()
      WHERE id=${f.attemptID}`;
    await runtime.get(f.attemptID);
    expect(await f.database.client`SELECT reason FROM factory.runtime_compute_wait`).toHaveLength(
      1,
    );
  } finally {
    await f.dispose();
  }
}, 60_000);
