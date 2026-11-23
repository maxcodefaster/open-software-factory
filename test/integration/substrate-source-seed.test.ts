import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  confirmInitialSourcePublication,
  initialSourceActorIn,
} from "../../apps/factory/src/workspace/source-initialization";
import type { DatabaseTransaction } from "../../packages/db/src/client";
import { substrateSource } from "../../packages/db/src/schema/runtime";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { substrateFixture } from "../fixtures/substrate";

type Fixture = Awaited<ReturnType<typeof substrateFixture>>;
type SQL = Fixture["database"]["client"] | DatabaseTransaction;

function seedFor(f: Fixture, revision = "a".repeat(40)) {
  return {
    version: 1 as const,
    id: crypto.randomUUID(),
    workspaceID: f.workspaceID,
    projectID: f.projectID,
    repositoryURL: "https://example.invalid/fixture.git",
    revision,
    branch: "main",
  };
}

function insertSeed(
  f: Fixture,
  seed: ReturnType<typeof seedFor>,
  changes: Partial<typeof substrateSource.$inferInsert> = {},
) {
  return f.database.db
    .insert(substrateSource)
    .values({
      workspaceId: f.workspaceID,
      actorUid: null,
      owner: "service",
      seed,
      serviceBase: seed.id,
      ...changes,
    })
    .execute();
}

async function freeze(f: Fixture, epoch: number) {
  const id = crypto.randomUUID();
  await f.database.client`UPDATE factory.substrate_source
    SET writable=false,writer_epoch=${epoch},checkpoint_id=${id} WHERE workspace_id=${f.workspaceID}`;
  return id;
}

// Complete controlled Source manifests exercise DB ownership, not native snapshot
// or object-publication acceptance. No ROOTFS observation is fabricated here.
function manifest(
  f: Fixture,
  id: string,
  actorUID: string | null,
  epoch: number,
  generation: number,
) {
  const bytes = Buffer.from("owned Source database contract");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    id,
    workspaceID: f.workspaceID,
    actorUID,
    writerEpoch: epoch,
    generation,
    bundle: { version: 1, bytes: bytes.length, sha256, chunks: [sha256] },
  };
}

async function confirm(f: Fixture, checkpoint: unknown, generation: number) {
  await f.database.client`UPDATE factory.substrate_source
    SET generation=${generation},checkpoint=${JSON.stringify(checkpoint)}::jsonb
    WHERE workspace_id=${f.workspaceID}`;
}

async function transfer(f: Fixture, actorUID: string, sql: SQL = f.database.client) {
  await sql`UPDATE factory.substrate_source SET owner='actor',actor_uid=${actorUID},
    writer_epoch=writer_epoch+1,writable=true,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
}

async function admitActor(
  f: Fixture,
  sql: SQL,
  generation = 1,
  intentChanges: Record<string, unknown> = {},
  provisionChanges: Record<string, unknown> = {},
) {
  const attemptID = runtimeIdentity(f.workspaceID, generation).attemptID;
  const actorUID = crypto.randomUUID();
  const atespace = `fa-${attemptID.replaceAll("-", "")}`;
  const actorName = `runtime-${attemptID.replaceAll("-", "")}`;
  const space = {
    metadata: {
      ...f.space.metadata,
      name: atespace,
      uid: generation === 1 ? f.config.atespaceUID : crypto.randomUUID(),
    },
  };
  const template = {
    metadata: {
      ...f.template.metadata,
      atespace,
      uid: generation === 1 ? f.config.templateUID : crypto.randomUUID(),
    },
  };
  const provision = {
    revision: "a".repeat(40),
    branch: "main",
    repositoryURL: "https://example.invalid/fixture.git",
    templateSHA256: f.config.templateSHA256,
    ...provisionChanges,
  };
  await sql`INSERT INTO factory.substrate_workspace(workspace_id,generation,intent,
      atespace_attempted_at,atespace,policy_attempted_at,policy,template_attempted_at,template)
    VALUES(${f.workspaceID},${generation},${JSON.stringify(provision)}::jsonb,
      now(),${JSON.stringify(space)}::jsonb,now(),'{}'::jsonb,
      now(),${JSON.stringify(template)}::jsonb)`;
  await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
    VALUES(${attemptID},${f.projectID},${f.workspaceID},${generation},${"a".repeat(40)},
      'create-intended','owned-parent-hash','owned-child-hash',now(),${f.userID})`;
  await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,
      create_attempted_at,actor_uid,observation)
    VALUES(${attemptID},${atespace},${actorName},
      ${JSON.stringify({
        ...f.config,
        generation,
        atespaceUID: space.metadata.uid,
        templateUID: template.metadata.uid,
        ...intentChanges,
      })}::jsonb,now(),${actorUID},
      ${JSON.stringify({ metadata: { uid: actorUID, name: actorName, atespace } })}::jsonb)`;
  return { attemptID, actorUID };
}

test("Source publication confirmation survives a requesting file transaction rollback", async () => {
  const f = await substrateFixture();
  const seed = seedFor(f);
  try {
    await insertSeed(f, seed);
    await expect(
      f.database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
        await confirmInitialSourcePublication(f.database, f.workspaceID, seed.id);
        throw new Error("owned file transaction rolled back after publication");
      }),
    ).rejects.toThrow("owned file transaction rolled back");
    const [row] = await f.database.db
      .select({
        confirmed: substrateSource.seedConfirmedAt,
      })
      .from(substrateSource);
    expect(row?.confirmed).toBeInstanceOf(Date);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("first Actor authorization rejects a mismatched identity before freezing editable Source", async () => {
  const f = await substrateFixture();
  const seed = seedFor(f);
  try {
    await insertSeed(f, seed);
    await f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=now()
      WHERE workspace_id=${f.workspaceID}`;
    const actor = await f.database.client.begin((sql) => admitActor(f, sql));
    expect(await initialSourceActorIn(f.database.client, seed, actor.actorUID)).toHaveLength(1);
    for (const [candidate, uid] of [
      [seed, crypto.randomUUID()],
      [{ ...seed, projectID: crypto.randomUUID() }, actor.actorUID],
      [{ ...seed, revision: "b".repeat(40) }, actor.actorUID],
      [{ ...seed, branch: "other" }, actor.actorUID],
      [{ ...seed, repositoryURL: "https://example.invalid/other.git" }, actor.actorUID],
    ] as const)
      expect(await initialSourceActorIn(f.database.client, candidate, uid)).toHaveLength(0);
    expect(
      await f.database.db
        .select({
          writable: substrateSource.writable,
          epoch: substrateSource.writerEpoch,
        })
        .from(substrateSource),
    ).toEqual([{ writable: true, epoch: 1 }]);
  } finally {
    await f.dispose();
  }
}, 60_000);

test.each([40, 64])(
  "initial service Source persists a %s-character seed before any Actor or Attempt",
  async (length) => {
    const revision = "a".repeat(length);
    const f = await substrateFixture(revision);
    const seed = seedFor(f, revision);
    try {
      await insertSeed(f, seed);
      expect(await f.database.db.select().from(substrateSource)).toEqual([
        {
          workspaceId: f.workspaceID,
          actorUid: null,
          owner: "service",
          writerEpoch: 1,
          writable: true,
          generation: 0,
          checkpointId: null,
          checkpoint: null,
          serviceBase: seed.id,
          seed,
          seedConfirmedAt: null,
        },
      ]);
      expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
      expect(
        await f.database.client`SELECT runtime_attempt_id FROM factory.substrate_binding`,
      ).toHaveLength(0);
      expect(
        await f.database.client`SELECT workspace_id FROM factory.substrate_workspace`,
      ).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  },
);

test("initial service Source rejects absent or malformed seed, fake Actors and mismatched Workspace identity", async () => {
  const f = await substrateFixture();
  const seed = seedFor(f);
  try {
    for (const changes of [
      { seed: null },
      { actorUid: crypto.randomUUID() },
      { owner: "actor" as const },
      { serviceBase: null },
      { serviceBase: crypto.randomUUID() },
      { writerEpoch: 2 },
      { writable: false },
      { generation: 1 },
      { checkpointId: crypto.randomUUID() },
      { checkpoint: {} },
      { seedConfirmedAt: new Date() },
    ]) {
      await expect(insertSeed(f, seed, changes)).rejects.toThrow();
    }
    for (const invalid of [
      null,
      [],
      {},
      "seed",
      { ...seed, version: 2 },
      { ...seed, version: "1" },
      { ...seed, id: "fake-seed-id" },
      { ...seed, workspaceID: crypto.randomUUID() },
      { ...seed, projectID: crypto.randomUUID() },
      { ...seed, branch: "other" },
      { ...seed, revision: "b".repeat(40) },
      { ...seed, revision: "a".repeat(41) },
      { ...seed, revision: "z".repeat(40) },
      { ...seed, repositoryURL: null },
      { ...seed, repositoryURL: {} },
      { ...seed, repositoryURL: "https://example.invalid/other.git" },
      { ...seed, unexpected: true },
      ...Object.keys(seed).map((key) =>
        Object.fromEntries(Object.entries(seed).filter(([name]) => name !== key)),
      ),
    ]) {
      await expect(insertSeed(f, seed, { seed: invalid })).rejects.toThrow();
    }
    await expect(
      f.database.client`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${f.workspaceID},${crypto.randomUUID()})`.execute(),
    ).rejects.toThrow("current original Actor binding");
    await f.database.client.begin((sql) => admitActor(f, sql));
    await expect(insertSeed(f, seed)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("before any Attempt") },
    });
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${f.attemptID}`;
    await expect(insertSeed(f, seed)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("before any Attempt") },
    });
    expect(await f.database.db.select().from(substrateSource)).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("Source seed and one-time publication confirmation cannot rewrite ownership facts", async () => {
  const f = await substrateFixture();
  const seed = seedFor(f);
  try {
    await insertSeed(f, seed);
    for (const changed of [
      null,
      { ...seed, id: crypto.randomUUID() },
      { ...seed, branch: "other" },
    ]) {
      await expect(
        f.database
          .client`UPDATE factory.substrate_source SET seed=${changed ? JSON.stringify(changed) : null}::jsonb
          WHERE workspace_id=${f.workspaceID}`.execute(),
      ).rejects.toThrow("seed is immutable");
    }
    await expect(
      f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=now(),
        writer_epoch=2,writable=false,checkpoint_id=${crypto.randomUUID()}
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("unchanged initialized service owner");
    await f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=now()
      WHERE workspace_id=${f.workspaceID}`;
    const saved = await f.database.db.select().from(substrateSource);
    expect(saved[0]?.seedConfirmedAt).toBeInstanceOf(Date);
    await f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=seed_confirmed_at
      WHERE workspace_id=${f.workspaceID}`;
    await expect(
      f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=NULL
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("seed confirmation is immutable");
    await expect(
      f.database
        .client`UPDATE factory.substrate_source SET seed_confirmed_at=seed_confirmed_at+interval '1 second'
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("seed confirmation is immutable");
    await expect(
      f.database.client`UPDATE factory.substrate_source SET service_base=${crypto.randomUUID()}
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("lease facts cannot change");
    expect(await f.database.db.select().from(substrateSource)).toEqual(saved);
  } finally {
    await f.dispose();
  }
});

test("first Actor bind requires confirmed seed, frozen Source and exact observed immutable generation-one binding", async () => {
  const f = await substrateFixture();
  const seed = seedFor(f);
  try {
    await insertSeed(f, seed);
    await expect(
      f.database.client.begin(async (sql) => {
        const actor = await admitActor(f, sql);
        await transfer(f, actor.actorUID, sql);
      }),
    ).rejects.toThrow("confirmed stopped predecessor");
    const id = await freeze(f, 2);
    const checkpoint = { ...manifest(f, id, null, 2, 1), seedID: seed.id };
    await expect(confirm(f, checkpoint, 1)).rejects.toThrow("differs from frozen writer");
    await expect(
      f.database.client.begin(async (sql) => {
        const actor = await admitActor(f, sql);
        await transfer(f, actor.actorUID, sql);
      }),
    ).rejects.toThrow("confirmed seed and exact generation-one native binding");
    await f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=now()
      WHERE workspace_id=${f.workspaceID}`;
    for (const invalid of [
      { ...checkpoint, id: crypto.randomUUID() },
      { ...checkpoint, workspaceID: crypto.randomUUID() },
      { ...checkpoint, actorUID: crypto.randomUUID() },
      { ...checkpoint, actorUID: undefined },
      { ...checkpoint, actorUID: "null" },
      { ...checkpoint, seedID: undefined },
      { ...checkpoint, seedID: null },
      { ...checkpoint, seedID: crypto.randomUUID() },
      { ...checkpoint, writerEpoch: 1 },
      { ...checkpoint, generation: 2 },
    ]) {
      await expect(confirm(f, invalid, 1)).rejects.toThrow("differs from frozen writer");
    }
    await expect(
      f.database.client.begin(async (sql) => {
        const actor = await admitActor(f, sql);
        await transfer(f, actor.actorUID, sql);
      }),
    ).rejects.toThrow("completely confirmed frozen generation");
    await confirm(f, checkpoint, 1);
    await expect(transfer(f, crypto.randomUUID())).rejects.toThrow("exact generation-one");
    for (const [intent, provision] of [
      [{ workspaceID: crypto.randomUUID() }, {}],
      [{ projectID: crypto.randomUUID() }, {}],
      [{ generation: 2 }, {}],
      [{ atespaceUID: crypto.randomUUID() }, {}],
      [{ templateUID: crypto.randomUUID() }, {}],
      [{ templateVersion: "2" }, {}],
      [{ templateSHA256: "b".repeat(64) }, {}],
      [{ templateUID: null }, {}],
      [{}, { templateSHA256: "b".repeat(64) }],
      [{}, { branch: "other" }],
      [{}, { repositoryURL: "https://example.invalid/other.git" }],
      [{}, { revision: "b".repeat(40) }],
    ] as const) {
      await expect(
        f.database.client.begin(async (sql) => {
          const actor = await admitActor(f, sql, 1, intent, provision);
          await transfer(f, actor.actorUID, sql);
        }),
      ).rejects.toThrow("exact generation-one native binding");
    }
    const actor = await f.database.client.begin((sql) => admitActor(f, sql));
    for (const fault of [
      async (sql: SQL) => {
        await sql`UPDATE factory.substrate_binding SET observation=NULL WHERE runtime_attempt_id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.substrate_binding SET observation=jsonb_set(observation,'{metadata,uid}',to_jsonb(${crypto.randomUUID()}::text)) WHERE runtime_attempt_id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.substrate_binding SET create_rejected=true WHERE runtime_attempt_id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.substrate_binding SET delete_intended_at=now() WHERE runtime_attempt_id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        const otherID = runtimeIdentity(f.workspaceID, 2).attemptID;
        await sql`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${actor.attemptID}`;
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
            parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          VALUES(${otherID},${f.projectID},${f.workspaceID},2,${"a".repeat(40)},
            'create-intended','owned-other-parent','owned-other-child',now(),${f.userID})`;
        await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
          VALUES(${otherID},${`fa-${otherID.replaceAll("-", "")}`},
            ${`runtime-${otherID.replaceAll("-", "")}`},
            ${JSON.stringify({ ...f.config, generation: 2 })}::jsonb)`;
        await sql`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${otherID}`;
        await sql`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${actor.attemptID}`;
      },
    ]) {
      await expect(
        f.database.client.begin(async (sql) => {
          await fault(sql);
          await transfer(f, actor.actorUID, sql);
        }),
      ).rejects.toThrow("exact generation-one native binding");
    }
    await expect(
      f.database
        .client`UPDATE factory.substrate_binding SET intent=jsonb_set(intent,'{templateUID}',to_jsonb(${crypto.randomUUID()}::text))
        WHERE runtime_attempt_id=${actor.attemptID}`.execute(),
    ).rejects.toThrow("identity and dispatch facts are immutable");
    await expect(
      f.database.client`UPDATE factory.substrate_workspace SET template='{}'::jsonb
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("identity and dispatch facts are immutable");
    await expect(
      f.database.client`UPDATE factory.substrate_binding SET create_attempted_at=NULL
        WHERE runtime_attempt_id=${actor.attemptID}`.execute(),
    ).rejects.toThrow("identity and dispatch facts are immutable");
    await expect(
      f.database.client.begin(async (sql) => {
        await sql`UPDATE factory.substrate_source SET writer_epoch=writer_epoch+1
          WHERE workspace_id=${f.workspaceID}`;
        await transfer(f, actor.actorUID, sql);
      }),
    ).rejects.toThrow("lease facts cannot change");
    await transfer(f, actor.actorUID);
    expect((await f.database.db.select().from(substrateSource))[0]).toMatchObject({
      actorUid: actor.actorUID,
      owner: "actor",
      writable: true,
      writerEpoch: 3,
      generation: 1,
      checkpoint,
      checkpointId: null,
      seed,
      serviceBase: seed.id,
      seedConfirmedAt: expect.any(Date),
    });
    // Retained provenance does not authorize another Actor or seed-produced export.
    await expect(
      f.database.client`UPDATE factory.substrate_source SET seed=NULL
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("seed is immutable");
    await expect(transfer(f, crypto.randomUUID())).rejects.toThrow("confirmed stopped predecessor");
    const nextID = await freeze(f, 4);
    const next = manifest(f, nextID, actor.actorUID, 4, 2);
    for (const invalid of [
      { ...next, actorUID: crypto.randomUUID() },
      { ...next, actorUID: null },
      { ...next, actorUID: null, seedID: seed.id },
      { ...next, seedID: seed.id },
      { ...next, seedID: null },
    ]) {
      await expect(confirm(f, invalid, 2)).rejects.toThrow("differs from frozen writer");
    }
    await confirm(f, next, 2);
    const independent = async () => {
      await f.database.client`UPDATE factory.substrate_source SET owner='service',writer_epoch=5,
        writable=true,service_base=checkpoint_id,checkpoint_id=NULL WHERE workspace_id=${f.workspaceID}`;
    };
    await expect(independent()).rejects.toThrow("durable paused ROOTFS or final Stop");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${actor.attemptID}`;
    await expect(independent()).rejects.toThrow("durable paused ROOTFS or final Stop");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
      WHERE id=${actor.attemptID}`;
    await independent();
    await expect(f.database.client.begin((sql) => admitActor(f, sql, 2))).rejects.toThrow(
      "exact cleanup and independent Source",
    );
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now()
      WHERE id=${actor.attemptID}`;
    await f.database
      .client`UPDATE factory.substrate_binding SET delete_intended_at=now(),deleted_at=now()
      WHERE runtime_attempt_id=${actor.attemptID}`;
    const successor = await f.database.client.begin((sql) => admitActor(f, sql, 2));
    const finalID = await freeze(f, 6);
    await confirm(f, manifest(f, finalID, actor.actorUID, 6, 3), 3);
    await expect(transfer(f, crypto.randomUUID())).rejects.toThrow("confirmed stopped predecessor");
    await transfer(f, successor.actorUID);
    expect((await f.database.db.select().from(substrateSource))[0]).toMatchObject({
      actorUid: successor.actorUID,
      owner: "actor",
      writerEpoch: 7,
      seed,
      checkpoint: { actorUID: actor.actorUID, generation: 3 },
    });
  } finally {
    await f.dispose();
  }
});

test("ordinary Actor-owned initial Source remains seedless and cannot add seed confirmation", async () => {
  const f = await substrateFixture();
  try {
    const actor = await f.database.client.begin((sql) => admitActor(f, sql));
    await f.database.db
      .insert(substrateSource)
      .values({ workspaceId: f.workspaceID, actorUid: actor.actorUID });
    await expect(
      f.database
        .client`UPDATE factory.substrate_source SET seed=${JSON.stringify(seedFor(f))}::jsonb
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("seed is immutable");
    await expect(
      f.database.client`UPDATE factory.substrate_source SET seed_confirmed_at=now()
        WHERE workspace_id=${f.workspaceID}`.execute(),
    ).rejects.toThrow("unchanged initialized service owner");
    expect((await f.database.db.select().from(substrateSource))[0]).toMatchObject({
      actorUid: actor.actorUID,
      owner: "actor",
      writerEpoch: 1,
      writable: true,
      generation: 0,
      checkpoint: null,
      seed: null,
      seedConfirmedAt: null,
    });
  } finally {
    await f.dispose();
  }
});
