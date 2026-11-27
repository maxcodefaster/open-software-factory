import { expect, test } from "bun:test";
import type { DatabaseTransaction } from "#db/client";
import { runtimeConnectorTokens } from "#runtime-domain/identity";
import { type NativeActor, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { agentConfiguration } from "../../apps/factory/src/runtime/agent-configuration";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

test("runtime model projection keeps the first admission's version and reasoning, never personal settings", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const connectionID = crypto.randomUUID();
  const configuration = () =>
    agentConfiguration(
      f.database,
      f.changeID,
      "owned-model-projection",
      f.attemptID,
      1,
      `registry.invalid/browser@sha256:${"d".repeat(64)}`,
      f.config,
    );
  try {
    await f.database
      .client`INSERT INTO factory.model_settings(scope_type,scope_key,project_id,user_id,version,settings)
      VALUES('personal',${`${f.projectID}:${f.userID}`},${f.projectID},${f.userID},1,${JSON.stringify({ planningModelId: null, buildModelId: "private-model-not-for-background" })}::jsonb)`;
    const fallback = await configuration();
    expect(fallback.modelID).not.toBe("private-model-not-for-background");
    expect(fallback.provider).toBe("openai");
    expect(fallback).not.toHaveProperty("reasoningEffort");
    await f.database.client.begin(async (sql) => {
      for (const version of [1, 2]) {
        const commandID = crypto.randomUUID();
        const provider = version === 2 ? "anthropic" : "deepseek";
        const secretKey = `owned-model-${connectionID}-${version}`;
        await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
          VALUES(${commandID},'models.connection_write','connection',${connectionID},${`models.connection_write:${secretKey}`},${`models.connection_write:${connectionID}`},'write-intended',
            ${JSON.stringify({ connectionID, baseVersion: version - 1, provider, endpoint: "https://example.invalid/v1", fingerprint: "b".repeat(64), secretKey })}::jsonb,${f.userID})`;
        await sql`INSERT INTO factory.model_connection_version(connection_id,version,provider,endpoint,secret_key,created_by)
          VALUES(${connectionID},${version},${provider},'https://example.invalid/v1',${secretKey},${f.userID})`;
        await sql`UPDATE factory.operation SET state='committed',active_key=NULL,completed_at=now(),updated_at=now()
          WHERE id=${commandID} AND kind='models.connection_write'`;
      }
      const [approval] = await sql<{ revisionID: string }[]>`
        SELECT requirement_revision_id AS "revisionID" FROM factory.requirement_approval
        WHERE ticket_id=${f.ticketID}`;
      if (!approval) throw Error("Owned requirement approval is missing");
      // Equal transaction clocks exercise the stable ID tie-breaker as well.
      for (const [id, modelID, version, reasoning] of [
        ["22222222-2222-4222-8222-222222222222", "later-model", 1, "high"],
        ["11111111-1111-4111-8111-111111111111", "admitted-model", 2, "max"],
      ] as const) {
        await sql`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,state)
          VALUES(${id},${crypto.randomUUID()},${f.projectID},${f.ticketID},${f.changeID},${f.userID},
            '{"kind":"change-start"}',${"a".repeat(64)},
            ${JSON.stringify({
              mode: "build",
              requirementRevisionId: approval.revisionID,
              modelId: modelID,
              modelConnection: { connectionID, version },
              codingReasoning: reasoning,
            })}::jsonb,'completed')`;
      }
    });
    const admitted = await configuration();
    expect(admitted).toMatchObject({
      modelID: "admitted-model",
      modelIDs: ["admitted-model"],
      provider: "anthropic",
      reasoningEffort: "max",
      modelBaseURL: `https://factory.test/internal/model/${f.attemptID}/v1`,
    });
    expect(await configuration()).toEqual(admitted);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.agent_turn`).toHaveLength(2);
  } finally {
    await f.dispose();
  }
}, 60_000);

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
          a.create_intended_at::text,a.create_attempted_at::text,a.actor_uid,a.create_rejected,
          a.binding_intent AS intent,e.payload->>'environment' AS environment,e.payload->>'version' AS version,
          e.payload->>'secretKey' AS secret_key
        FROM factory.runtime_attempt a
        JOIN factory.operation e ON e.kind='runtime.environment_intent'
          AND e.scope_type='runtime_attempt' AND e.scope_id=a.id::text
          AND e.idempotency_key='runtime.environment_intent:' || a.id::text
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
      SELECT actor_uid,observation,checkpoint FROM factory.runtime_attempt
      WHERE id=${f.attemptID}`;
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
          SELECT a.id FROM factory.runtime_attempt a
          JOIN factory.operation e ON e.kind='runtime.environment_intent'
            AND e.scope_type='runtime_attempt' AND e.scope_id=a.id::text
            AND e.idempotency_key='runtime.environment_intent:' || a.id::text
          WHERE a.id=${f.attemptID} AND a.atespace IS NOT NULL`;
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
      await f.database.client`SELECT scope_id FROM factory.operation
        WHERE kind='runtime.environment_intent'`,
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
      await f.database.client`UPDATE factory.runtime_attempt SET actor_uid=${competingUID}
        WHERE id=${f.attemptID}`;
      return actor;
    }
    if (method === "ResumeActor") resumes++;
    throw Error(`Unexpected controlled native operation ${method}`);
  });
  try {
    await expect(execution.start(f.userID)).rejects.toThrow("Actor UID binding changed");
    const [saved] = await f.database.client`
      SELECT actor_uid,observation,checkpoint FROM factory.runtime_attempt
      WHERE id=${f.attemptID}`;
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
      SELECT state,failure,checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
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
      SELECT state,failure,stop_intended_at::text,deleted_at::text
      FROM factory.runtime_attempt
      WHERE id=${f.attemptID}`;
    expect(stopped).toMatchObject({ state: "stopped", failure: "retained diagnosis" });
    expect(Number.isFinite(Date.parse(stopped?.["stop_intended_at"]))).toBe(true);
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
      await f.database.client`INSERT INTO factory.operation(
        id,kind,scope_type,scope_id,idempotency_key,state,payload)
        VALUES(${crypto.randomUUID()},'runtime.compute_wait','runtime_attempt',${f.attemptID},
          ${`runtime.compute_wait:${f.attemptID}`},'waiting',jsonb_build_object('reason',${reason}::text))
        ON CONFLICT(idempotency_key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`;
      await runtime.get(f.attemptID);
      const rows = await f.database.client`
        SELECT payload->>'reason' AS reason FROM factory.operation
        WHERE kind='runtime.compute_wait' AND scope_type='runtime_attempt'
          AND scope_id=${f.attemptID}`;
      expect([...rows]).toEqual(reason === "compute-capacity" ? [] : [{ reason }]);
    }
    await f.database.client`INSERT INTO factory.operation(
      id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'runtime.compute_wait','runtime_attempt',${f.attemptID},
        ${`runtime.compute_wait:${f.attemptID}`},'waiting',jsonb_build_object('reason','compute-capacity'))`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
    await runtime.get(f.attemptID);
    expect(
      await f.database.client`SELECT payload->>'reason' AS reason FROM factory.operation
        WHERE kind='runtime.compute_wait'`,
    ).toHaveLength(1);
    await expect(
      f.database.client`UPDATE factory.runtime_attempt SET state='starting',stop_intended_at=now()
        WHERE id=${f.attemptID}`.execute(),
    ).rejects.toThrow("Final Stop intent cannot be cleared or reopen execution");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
      WHERE id=${f.attemptID}`;
    await runtime.get(f.attemptID);
    expect(
      await f.database.client`SELECT payload->>'reason' AS reason FROM factory.operation
        WHERE kind='runtime.compute_wait'`,
    ).toHaveLength(1);
    const [finalStop] = await f.database.client`
      SELECT state,stop_intended_at::text FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(finalStop?.["state"]).toBe("stopping");
    await expect(
      f.database.client`UPDATE factory.runtime_attempt SET stop_intended_at=NULL
        WHERE id=${f.attemptID}`.execute(),
    ).rejects.toThrow("Final Stop intent cannot be cleared or reopen execution");
    await expect(
      f.database.client`UPDATE factory.runtime_attempt
        SET stop_intended_at=stop_intended_at+interval '1 second'
        WHERE id=${f.attemptID}`.execute(),
    ).rejects.toThrow("Final Stop intent cannot be cleared or reopen execution");
    await expect(
      f.database.client`UPDATE factory.runtime_attempt SET state='starting'
        WHERE id=${f.attemptID}`.execute(),
    ).rejects.toThrow("Final Stop intent cannot be cleared or reopen execution");
    expect(
      (
        await f.database.client`
          SELECT state,stop_intended_at::text FROM factory.runtime_attempt WHERE id=${f.attemptID}`
      )[0],
    ).toEqual(finalStop);
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped'
      WHERE id=${f.attemptID}`;
    await runtime.get(f.attemptID);
    expect(
      await f.database.client`SELECT payload->>'reason' AS reason FROM factory.operation
        WHERE kind='runtime.compute_wait'`,
    ).toHaveLength(1);
    await expect(
      f.database.client`UPDATE factory.runtime_attempt SET state='ready'
        WHERE id=${f.attemptID}`.execute(),
    ).rejects.toThrow("Final Stop intent cannot be cleared or reopen execution");
  } finally {
    await f.dispose();
  }
}, 60_000);
