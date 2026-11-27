import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { nativeSnapshot } from "#runtime-kubernetes/substrate-control";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

let server: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
let target: Awaited<ReturnType<typeof ownedTestDatabase>> | undefined;
let client: postgres.Sql;

beforeAll(async () => {
  const inherited = process.env["FACTORY_TEST_POSTGRES"];
  server = inherited ? undefined : await ownedPostgresServer();
  const identity = inherited ? JSON.parse(inherited) : server?.identity;
  if (!identity) throw new Error("Owned PostgreSQL identity is missing");
  target = await ownedTestDatabase(identity, crypto.randomUUID());
  client = postgres(target.url, { max: 1 });
  // Exercise the native source owner directly while main regenerates the sealed
  // baseline. Replace only this function, only in our disposable database.
  const source = await readFile(
    new URL("../../packages/db/native/19-runtime-functions.sql", import.meta.url),
    "utf8",
  );
  const guard = source.match(
    /CREATE FUNCTION factory\.protect_substrate_source\(\) RETURNS trigger[\s\S]*?END \$\$;/,
  )?.[0];
  if (!guard) throw new Error("Native Source transfer guard is missing");
  await client.unsafe(guard.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
}, 60_000);

afterAll(async () => {
  try {
    await client?.end({ timeout: 1 });
  } finally {
    try {
      await target?.dispose();
    } finally {
      await server?.dispose();
    }
  }
}, 60_000);

async function sourceFixture(
  sql: postgres.TransactionSql,
  fidelity = "SNAPSHOT_FIDELITY_MEMORY",
  protocol = "2",
) {
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    workspaceID = crypto.randomUUID(),
    attemptID = crypto.randomUUID(),
    actorUID = crypto.randomUUID(),
    templateUID = crypto.randomUUID(),
    checkpointID = crypto.randomUUID();
  const atespace = `fa-${attemptID.replaceAll("-", "")}`;
  const snapshot = nativeSnapshot.parse({
    uuid: crypto.randomUUID(),
    generation: 1,
    owner: "SNAPSHOT_OWNER_ACTOR",
    fidelity,
    actorTemplateUid: templateUID,
    sandboxRuntime: {
      sandboxClass: "gvisor",
      version: {
        schemaVersion: "v1",
        attributes: [{ key: "architecture", value: "amd64" }],
      },
    },
    durableSnapshot: {
      state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
      object: { snapshotUri: "s3://owned/pending-identity" },
    },
  });
  snapshot.durableSnapshot.object.snapshotUri = `s3://owned/atespaces/${atespace}/actors/${actorUID}/snapshots/${snapshot.uuid}`;
  const checkpoint = { actorUID, templateUID, ...snapshot };
  const observation = {
    metadata: {
      uid: actorUID,
      name: `runtime-${attemptID.replaceAll("-", "")}`,
      atespace,
      version: "2",
    },
    status: {
      state: "ACTOR_STATE_SUSPENDED",
      lastAssignedGeneration: 1,
      snapshots: [snapshot],
    },
  };
  await sql`INSERT INTO auth."user"(id,name,email,email_verified)
    VALUES(${userID},'Owned snapshot guard',${`${userID}@factory.invalid`},true)`;
  await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
    VALUES(${projectID},${`snapshot-${projectID}`},'Owned snapshot guard',
      'https://example.invalid/fixture.git','main','.factory/actor-template.json',${userID})`;
  await sql`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
    VALUES(${workspaceID},${projectID},'personal',${userID},'main',${"a".repeat(40)},${userID})`;
  await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
      parent_connector_token_hash,create_intended_at,created_by,
      atespace,actor_name,binding_intent,actor_uid,create_attempted_at,observation,checkpoint)
    VALUES(${attemptID},${projectID},${workspaceID},1,${"a".repeat(40)},'create-intended',
      ${"b".repeat(64)},now(),${userID},
      ${atespace},${observation.metadata.name},
      ${JSON.stringify({ sourceRestoreProtocol: protocol, workspaceID, generation: 1, templateUID })}::text::jsonb,
      ${actorUID},now(),${JSON.stringify(observation)}::text::jsonb,${JSON.stringify(checkpoint)}::text::jsonb)`;
  await sql`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${attemptID}`;
  await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
    VALUES(${workspaceID},${actorUID})`;
  await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${checkpointID}
    WHERE workspace_id=${workspaceID}`;
  await sql`UPDATE factory.substrate_source SET generation=1,
    checkpoint=${JSON.stringify({ id: checkpointID, workspaceID, actorUID, generation: 1, writerEpoch: 2 })}::text::jsonb
    WHERE workspace_id=${workspaceID}`;
  return {
    attemptID,
    workspaceID,
    actorUID,
    checkpoint,
    observation,
    async transfer(owner: "actor" | "service" = "service", connection = sql) {
      const rows =
        await connection`UPDATE factory.substrate_source SET owner=${owner},writable=true,
        writer_epoch=writer_epoch+1,service_base=CASE WHEN ${owner}='service' THEN checkpoint_id ELSE service_base END,
        checkpoint_id=NULL WHERE workspace_id=${workspaceID}
        RETURNING actor_uid::text AS uid,owner,writable,generation::int,writer_epoch::int AS epoch`;
      return [...rows];
    },
    async freezeService() {
      const id = crypto.randomUUID();
      await sql`UPDATE factory.substrate_source SET writable=false,writer_epoch=4,checkpoint_id=${id}
        WHERE workspace_id=${workspaceID}`;
      await sql`UPDATE factory.substrate_source SET generation=2,
        checkpoint=${JSON.stringify({ id, workspaceID, actorUID, generation: 2, writerEpoch: 4 })}::text::jsonb
        WHERE workspace_id=${workspaceID}`;
    },
  };
}

test.each(["SNAPSHOT_FIDELITY_ROOTFS", "SNAPSHOT_FIDELITY_MEMORY"])(
  "%s keeps independent Source writable after pause and requires its exact dispatched resume to transfer back",
  async (fidelity) => {
    await client.begin(async (sql) => {
      const f = await sourceFixture(sql, fidelity);
      expect(await f.transfer()).toEqual([
        { uid: f.actorUID, owner: "service", writable: true, generation: 1, epoch: 3 },
      ]);
      await f.freezeService();
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
      await expect(sql.savepoint((tx) => f.transfer("actor", tx))).rejects.toThrow(
        "durable paused ROOTFS",
      );
      // The persisted operation must identify this exact checkpoint, not a label.
      const wrongCheckpoint = { ...f.checkpoint, uuid: crypto.randomUUID() };
      await expect(
        sql.savepoint(async (tx) => {
          await tx`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
            VALUES(${crypto.randomUUID()},'runtime.actor_rpc','runtime_attempt',${f.attemptID},
              ${`runtime.actor_rpc:${f.attemptID}:resume:${wrongCheckpoint.uuid}`},'attempted',
              jsonb_build_object(
                'runtimeAttemptId',${f.attemptID}::text,'action','resume','originKey',${wrongCheckpoint.uuid}::text,
                'actorUid',${f.actorUID}::text,'nativeVersion','2',
                'originCheckpoint',${JSON.stringify(wrongCheckpoint)}::text::jsonb,
                'stopId',NULL,'attemptedAt',now()))`;
          await f.transfer("actor", tx);
        }),
      ).rejects.toThrow("durable paused ROOTFS");
      await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
        VALUES(${crypto.randomUUID()},'runtime.actor_rpc','runtime_attempt',${f.attemptID},
          ${`runtime.actor_rpc:${f.attemptID}:resume:${f.checkpoint.uuid}`},'intended',
          jsonb_build_object(
            'runtimeAttemptId',${f.attemptID}::text,'action','resume','originKey',${f.checkpoint.uuid}::text,
            'actorUid',${f.actorUID}::text,'nativeVersion','2',
            'originCheckpoint',${JSON.stringify(f.checkpoint)}::text::jsonb,
            'stopId',NULL))`;
      await expect(sql.savepoint((tx) => f.transfer("actor", tx))).rejects.toThrow(
        "durable paused ROOTFS",
      );
      await sql`UPDATE factory.operation
        SET state='attempted',payload=payload || jsonb_build_object('attemptedAt',now()),updated_at=now()
        WHERE kind='runtime.actor_rpc' AND scope_type='runtime_attempt' AND scope_id=${f.attemptID}
          AND payload->>'action'='resume'`;
      expect(await f.transfer("actor")).toEqual([
        { uid: f.actorUID, owner: "actor", writable: true, generation: 2, epoch: 5 },
      ]);
      expect([
        ...(await sql`SELECT checkpoint FROM factory.runtime_attempt WHERE id=${f.attemptID}`),
      ]).toEqual([{ checkpoint: f.checkpoint }]);
    });
  },
);

test.each([
  "missing-checkpoint",
  "pending-durable",
  "missing-durable",
  "unknown-fidelity",
  "filesystem-fidelity",
  "different-actor",
  "different-generation",
  "running-actor",
  "suspending-actor",
  "ready-attempt",
  "pausing-attempt",
])("native MEMORY Source cannot transfer on %s", async (scenario) => {
  await client.begin(async (sql) => {
    const f = await sourceFixture(sql);
    let checkpoint: unknown = f.checkpoint;
    if (scenario === "missing-checkpoint") checkpoint = null;
    if (scenario === "pending-durable")
      checkpoint = {
        ...f.checkpoint,
        durableSnapshot: {
          ...f.checkpoint.durableSnapshot,
          state: "SNAPSHOT_STORAGE_STATE_PENDING",
        },
      };
    if (scenario === "missing-durable") checkpoint = { ...f.checkpoint, durableSnapshot: null };
    if (scenario === "unknown-fidelity")
      checkpoint = { ...f.checkpoint, fidelity: "SNAPSHOT_FIDELITY_UNKNOWN" };
    if (scenario === "filesystem-fidelity")
      checkpoint = { ...f.checkpoint, fidelity: "SNAPSHOT_FIDELITY_FILESYSTEM" };
    if (scenario === "different-actor")
      checkpoint = { ...f.checkpoint, actorUID: crypto.randomUUID() };
    if (scenario === "different-generation") checkpoint = { ...f.checkpoint, generation: 2 };
    if (scenario === "running-actor") f.observation.status.state = "ACTOR_STATE_RUNNING";
    if (scenario === "suspending-actor") f.observation.status.state = "ACTOR_STATE_SUSPENDING";
    if (scenario === "ready-attempt" || scenario === "pausing-attempt")
      await sql`UPDATE factory.runtime_attempt SET state=${scenario === "ready-attempt" ? "ready" : "pausing"}
        WHERE id=${f.attemptID}`;
    await sql`UPDATE factory.runtime_attempt SET checkpoint=${JSON.stringify(checkpoint)}::text::jsonb,
      observation=${JSON.stringify(f.observation)}::text::jsonb WHERE id=${f.attemptID}`;
    await expect(sql.savepoint((tx) => f.transfer("service", tx))).rejects.toThrow(
      "durable paused ROOTFS",
    );
    expect([
      ...(await sql`SELECT owner,writable FROM factory.substrate_source WHERE workspace_id=${f.workspaceID}`),
    ]).toEqual([{ owner: "actor", writable: false }]);
  });
});

test("native MEMORY resume cannot bypass Source protocol, actor identity or confirmed writer generation", async () => {
  await client.begin(async (sql) => {
    const f = await sourceFixture(sql, "SNAPSHOT_FIDELITY_MEMORY", "1");
    await f.transfer();
    await f.freezeService();
    await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
    await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'runtime.actor_rpc','runtime_attempt',${f.attemptID},
        ${`runtime.actor_rpc:${f.attemptID}:resume:${f.checkpoint.uuid}`},'attempted',
        jsonb_build_object(
          'runtimeAttemptId',${f.attemptID}::text,'action','resume','originKey',${f.checkpoint.uuid}::text,
          'actorUid',${f.actorUID}::text,'nativeVersion','2',
          'originCheckpoint',${JSON.stringify(f.checkpoint)}::text::jsonb,
          'stopId',NULL,'attemptedAt',now()))`;
    await expect(sql.savepoint((tx) => f.transfer("actor", tx))).rejects.toThrow(
      "durable paused ROOTFS",
    );
    await expect(
      sql.savepoint(async (tx) => {
        await tx`UPDATE factory.substrate_source SET owner='actor',actor_uid=${crypto.randomUUID()},
        writable=true,writer_epoch=5,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
      }),
    ).rejects.toThrow("confirmed stopped predecessor");
    await expect(
      sql.savepoint(async (tx) => {
        await tx`UPDATE factory.substrate_source SET owner='actor',writable=true,writer_epoch=6,
        checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
      }),
    ).rejects.toThrow("identity/epoch/generation");
    await expect(
      sql.savepoint(async (tx) => {
        await tx`UPDATE factory.substrate_source SET owner='actor',writable=true,writer_epoch=5,
        generation=3,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
      }),
    ).rejects.toThrow("checkpoint confirmation differs");
  });
});

test("final Stop alone may retain confirmed Source without a native checkpoint, never transfer it back to execution", async () => {
  await client.begin(async (sql) => {
    const f = await sourceFixture(sql);
    await sql`UPDATE factory.runtime_attempt SET checkpoint=NULL,
      observation=jsonb_set(observation,'{status,state}','"ACTOR_STATE_RUNNING"')
      WHERE id=${f.attemptID}`;
    await expect(sql.savepoint((tx) => f.transfer("service", tx))).rejects.toThrow(
      "durable paused ROOTFS",
    );
    await sql`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
      WHERE id=${f.attemptID}`;
    expect((await f.transfer())[0]?.["owner"]).toBe("service");
    await f.freezeService();
    await expect(sql.savepoint((tx) => f.transfer("actor", tx))).rejects.toThrow(
      "durable paused ROOTFS",
    );
    await expect(
      sql.savepoint(async (tx) => {
        await tx`UPDATE factory.runtime_attempt SET state='starting',stop_intended_at=NULL
        WHERE id=${f.attemptID}`;
      }),
    ).rejects.toThrow("cannot be cleared");
  });
});
