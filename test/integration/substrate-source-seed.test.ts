import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseTransaction } from "#db/client";
import { substrateSource } from "#db/schema/runtime";
import { hashConnectorToken, runtimeIdentity } from "#runtime-domain/identity";
import { createRuntimeEnvironmentEndpoint } from "../../apps/factory/src/environments/runtime";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import {
  confirmInitialSourcePublication,
  initialSourceActorIn,
} from "../../apps/factory/src/workspace/source-initialization";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { memoryPrivateObjects } from "../fixtures/private-objects";
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
    branch: f.branch,
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
    branch: f.branch,
    repositoryURL: "https://example.invalid/fixture.git",
    templateSHA256: f.config.templateSHA256,
    ...provisionChanges,
  };
  await sql`INSERT INTO factory.substrate_provision(owner_id,kind,generation,intent,resources)
    VALUES(${f.workspaceID},'workspace',${generation},${JSON.stringify(provision)}::text::jsonb,
      jsonb_build_object(
        'atespace',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify(space)}::text::jsonb),
        'policy',jsonb_build_object('attemptedAt',to_jsonb(now()),'value','{}'::jsonb),
        'template',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify(template)}::text::jsonb)))`;
  await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,
      parent_connector_token_hash,create_intended_at,created_by,
      atespace,actor_name,binding_intent,create_attempted_at,actor_uid,observation)
    VALUES(${attemptID},${f.projectID},${f.workspaceID},${f.kind === "ticket" ? f.changeID : null},${generation},${"a".repeat(40)},
      'create-intended',${hashConnectorToken("owned-source-parent")},now(),${f.userID},
      ${atespace},${actorName},
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

// Controlled Source-service transport: these tests exercise real Factory/SQL
// handoff and authentication, not native archive materialization acceptance.
async function independentSourceFixture(
  kind: "personal" | "ticket" = "personal",
  published = true,
) {
  const f = await substrateFixture("a".repeat(40), kind);
  const seed = seedFor(f);
  const directory = await mkdtemp(join(tmpdir(), "factory-source-commit-"));
  const binary = join(directory, "controlled-source");
  const content = Buffer.from("latest saved README\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  await writeFile(
    binary,
    `#!${process.execPath}
const input = JSON.parse(await Bun.stdin.text());
const bytes = Buffer.from(${JSON.stringify(content.toString("base64"))}, "base64");
const bundle = {version:1,bytes:bytes.length,sha256:${JSON.stringify(sha256)},chunks:[${JSON.stringify(sha256)}]};
const server = Bun.serve({unix:input.socket,fetch:async request => {
  if(request.headers.get("authorization") !== "Bearer "+input.access.token) return new Response(null,{status:403});
  const operation = new URL(request.url).pathname.split("/").at(-1);
  if(operation === "checkpoint") return Response.json(bundle);
  if(operation === "chunk") return new Response(bytes);
  if(operation === "read") return Response.json({content:bytes.toString("base64"),version:bundle.sha256});
  if(operation === "fence") return Response.json({confirmed:true});
  return Response.json({kind:"directory"});
}});
process.on("SIGTERM",async()=>{await server.stop(true);process.exit(0);});
`,
    { mode: 0o700 },
  );
  await insertSeed(f, seed);
  const base = join(directory, "workspace-source", f.workspaceID, seed.id);
  await mkdir(join(base, "project"), { recursive: true });
  await writeFile(join(base, "initial-source.json"), JSON.stringify(seed));
  if (published) await confirmInitialSourcePublication(f.database, f.workspaceID, seed.id);
  const priorState = process.env["FACTORY_STATE_DIRECTORY"];
  const priorBinary = process.env["FACTORY_SOURCE_SERVICE_BINARY"];
  process.env["FACTORY_STATE_DIRECTORY"] = directory;
  process.env["FACTORY_SOURCE_SERVICE_BINARY"] = binary;
  let source: ReturnType<typeof createSubstrateSources>;
  try {
    source = createSubstrateSources(f.database, f.hub, memoryPrivateObjects());
  } finally {
    if (priorState === undefined) delete process.env["FACTORY_STATE_DIRECTORY"];
    else process.env["FACTORY_STATE_DIRECTORY"] = priorState;
    if (priorBinary === undefined) delete process.env["FACTORY_SOURCE_SERVICE_BINARY"];
    else process.env["FACTORY_SOURCE_SERVICE_BINARY"] = priorBinary;
  }
  const actor = await f.database.client.begin((sql) =>
    admitActor(f, sql, 1, { sourceRestoreProtocol: 2 }),
  );
  if (kind === "ticket") {
    await f.database
      .client`UPDATE factory.change SET runtime_attempt_id=${actor.attemptID} WHERE id=${f.changeID}`;
    await f.database
      .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},epoch=2 WHERE change_id=${f.changeID}`;
  }
  await f.database.client`INSERT INTO factory.operation(
    id,kind,scope_type,scope_id,idempotency_key,state,payload)
    VALUES(${crypto.randomUUID()},'runtime.environment_intent','runtime_attempt',${actor.attemptID},
      ${`runtime.environment_intent:${actor.attemptID}`},'recorded',
      ${JSON.stringify({ environment: "development", version: 0, secretKey: null })}::jsonb)`;
  await f.database
    .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${actor.attemptID}`;
  const controller = createWorkspaceSourceController(f.database, f.hub, source);
  const request = (method: "GET" | "POST" = "GET", body?: unknown, query = "") =>
    new Request(`https://factory.test/internal/substrate-source/${actor.attemptID}${query}`, {
      method,
      headers: {
        authorization: "Bearer owned-source-parent",
        "X-Factory-Runtime-Actor-UID": actor.actorUID,
        "X-Factory-Runtime-Generation": "1",
        "X-Factory-Source-Protocol": "2",
        "X-Factory-Source-Writer-Epoch": "3",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = () =>
    controller.forward(
      f.workspaceID,
      f.userID,
      "read",
      new Request("https://factory.test/source/read", {
        method: "POST",
        body: '{"path":"README.md"}',
      }),
    );
  return {
    ...f,
    ...actor,
    seed,
    source,
    controller,
    request,
    read,
    content,
    async dispose() {
      await controller.close();
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each(["personal", "ticket"] as const)(
  "first %s Start publishes unopened Source before its initial checkpoint",
  async (kind) => {
    const f = await independentSourceFixture(kind, false);
    try {
      expect(await f.source.lease(f.workspaceID)).toMatchObject({
        owner: "service",
        writable: true,
        writerEpoch: 1,
        generation: 0,
        seedConfirmedAt: null,
      });
      await f.source.resume(f.workspaceID, f.attemptID, f.database.client);
      const prepared = await f.source.lease(f.workspaceID);
      expect(prepared).toMatchObject({
        owner: "service",
        actorUID: null,
        writable: false,
        writerEpoch: 2,
        generation: 1,
        seedConfirmedAt: expect.any(Date),
        checkpoint: { seedID: f.seed.id, actorUID: null, writerEpoch: 2 },
      });
      expect(prepared?.checkpointID).toBe(prepared?.checkpoint?.id);
      // Re-observation must not re-publish, checkpoint again or transfer files.
      await f.source.resume(f.workspaceID, f.attemptID, f.database.client);
      expect(await f.source.lease(f.workspaceID)).toEqual(prepared);
      const response = await f.source.restoreEndpoint(f.request(), f.attemptID);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        checkpointSeedID: f.seed.id,
        writerEpoch: 3,
        checkpoint: { id: prepared?.checkpointID },
      });
      expect((await f.source.lease(f.workspaceID))?.owner).toBe("service");
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("cold restore keeps Source readable during native Resume and grants execution only after exact import commit", async () => {
  const f = await independentSourceFixture();
  const lifecycle = f.database.coordination();
  try {
    await lifecycle`SELECT pg_advisory_lock(hashtext(${`runtime:${f.workspaceID}`}))`;
    await f.source.attach(f.workspaceID, f.actorUID, f.database.client);
    expect(await (await f.read()).json()).toMatchObject({
      content: f.content.toString("base64"),
    });
    const old = f.request();
    old.headers.delete("X-Factory-Source-Protocol");
    expect((await f.source.restoreEndpoint(old, f.attemptID)).status).toBe(403);
    const environment = createRuntimeEnvironmentEndpoint(f.database, {
      configured: true,
      read: async () => {
        throw new Error("Unadmitted environment was read");
      },
      create: async () => {
        throw new Error("Restore must not create credentials");
      },
    });
    expect((await environment(f.request(), f.attemptID)).status).toBe(401);
    const prepared = await f.source.restoreEndpoint(f.request(), f.attemptID);
    expect(prepared.status).toBe(200);
    const metadata = await prepared.json();
    expect(metadata).toMatchObject({
      version: 2,
      actorUID: f.actorUID,
      checkpointActorUID: null,
      checkpointSeedID: f.seed.id,
      writerEpoch: 3,
      changeWriterEpoch: 3,
      readOnly: false,
    });
    expect(await f.source.lease(f.workspaceID)).toMatchObject({
      owner: "service",
      actorUID: null,
      writable: false,
      writerEpoch: 2,
      checkpointID: metadata.checkpoint.id,
    });
    expect(await f.controller.get(f.workspaceID, f.userID)).toMatchObject({ state: "ready" });
    expect((await f.read()).status).toBe(200);
    await expect(
      f.controller.forward(
        f.workspaceID,
        f.userID,
        "write",
        new Request("https://factory.test/source/write", {
          method: "POST",
          body: '{"path":"README.md","content":"eA=="}',
        }),
      ),
    ).rejects.toThrow("frozen or unavailable");
    const chunk = await f.source.restoreEndpoint(
      f.request("GET", undefined, `?checkpoint=${metadata.checkpoint.id}&chunk=0`),
      f.attemptID,
    );
    expect(Buffer.from(await chunk.arrayBuffer())).toEqual(f.content);
    const receipt = { checkpointID: metadata.checkpoint.id, writerEpoch: metadata.writerEpoch };
    expect(
      (
        await f.source.restoreEndpoint(
          f.request("POST", { ...receipt, writerEpoch: 99 }),
          f.attemptID,
        )
      ).status,
    ).toBe(409);
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID}`;
    await expect(
      f.source.restoreEndpoint(f.request("POST", receipt), f.attemptID),
    ).rejects.toThrow();
    expect((await f.source.lease(f.workspaceID))?.owner).toBe("service");
    await f.database
      .client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${f.projectID}`;
    for (let i = 0; i < 2; i++) {
      const ack = await f.source.restoreEndpoint(f.request("POST", receipt), f.attemptID);
      expect(ack.status).toBe(200);
      expect(await ack.json()).toEqual({
        version: 2,
        actorUID: f.actorUID,
        ...receipt,
        changeWriterEpoch: 3,
        readOnly: false,
      });
    }
    expect(await f.source.lease(f.workspaceID)).toMatchObject({
      owner: "actor",
      actorUID: f.actorUID,
      writable: true,
      writerEpoch: 3,
      checkpointID: null,
    });
    expect((await environment(f.request(), f.attemptID)).status).toBe(200);
    const retainedSource = await f.source.lease(f.workspaceID);
    const retained = await f.source.restoreEndpoint(f.request(), f.attemptID);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toEqual({
      version: 2,
      retained: true,
      actorUID: f.actorUID,
      writerEpoch: 3,
      changeWriterEpoch: 3,
      readOnly: false,
      checkpoint: null,
    });
    expect(await f.source.lease(f.workspaceID)).toEqual(retainedSource);
  } finally {
    await lifecycle`SELECT pg_advisory_unlock(hashtext(${`runtime:${f.workspaceID}`}))`;
    await lifecycle.end({ timeout: 1 });
    await f.dispose();
  }
}, 60_000);

test("first and repeated import ACKs report the current Ticket writer role, not the earlier GET role", async () => {
  const f = await independentSourceFixture("ticket");
  try {
    const prepared = await f.source.restoreEndpoint(f.request(), f.attemptID);
    expect(prepared.status).toBe(200);
    const metadata = await prepared.json();
    expect(metadata).toMatchObject({ changeWriterEpoch: 2, readOnly: false });
    const receipt = { checkpointID: metadata.checkpoint.id, writerEpoch: metadata.writerEpoch };
    for (const epoch of [3, 4]) {
      await f.database
        .client`UPDATE factory.change_writer SET epoch=${epoch} WHERE change_id=${f.changeID}`;
      const ack = await f.source.restoreEndpoint(f.request("POST", receipt), f.attemptID);
      expect(ack.status).toBe(200);
      expect(await ack.json()).toMatchObject({
        ...receipt,
        changeWriterEpoch: epoch,
        readOnly: false,
      });
    }
    expect((await f.source.lease(f.workspaceID))?.writerEpoch).toBe(3);
    const retainedSource = await f.source.lease(f.workspaceID);
    const retained = await f.source.restoreEndpoint(f.request(), f.attemptID);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toEqual({
      version: 2,
      retained: true,
      actorUID: f.actorUID,
      writerEpoch: 3,
      changeWriterEpoch: 4,
      readOnly: false,
      checkpoint: null,
    });
    expect(await f.source.lease(f.workspaceID)).toEqual(retainedSource);
  } finally {
    await f.dispose();
  }
}, 60_000);

test.each([false, true])(
  "Stop before Source commit retains the saved independent tree (downloaded=%s)",
  async (downloaded) => {
    const f = await independentSourceFixture();
    try {
      await f.source.attach(f.workspaceID, f.actorUID, f.database.client);
      if (downloaded)
        expect((await f.source.restoreEndpoint(f.request(), f.attemptID)).status).toBe(200);
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${f.attemptID}`;
      await f.source.freezeActor(f.workspaceID, f.attemptID, f.database.client);
      await f.source.makeIndependent(f.workspaceID, f.database.client);
      await f.source.requireIndependent(f.workspaceID, f.actorUID, f.database.client);
      expect(await f.source.lease(f.workspaceID)).toMatchObject({
        owner: "service",
        actorUID: null,
        writable: true,
        serviceBase: f.seed.id,
      });
      expect((await f.read()).status).toBe(200);
      expect((await f.source.restoreEndpoint(f.request(), f.attemptID)).status).toBe(403);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("native attachment leaves saved Source independent until the recipient commits its import", async () => {
  const f = await substrateFixture();
  const seed = seedFor(f);
  const source = createSubstrateSources(f.database, f.hub);
  try {
    await insertSeed(f, seed);
    await confirmInitialSourcePublication(f.database, f.workspaceID, seed.id);
    const actor = await f.database.client.begin((sql) => admitActor(f, sql));
    const outcome = await source.attach(f.workspaceID, actor.actorUID, f.database.client).then(
      () => null,
      (error: Error) => error.message,
    );
    // A native Actor can still fail before it ever requests Source. Merely
    // creating it must not freeze the saved tree or remove its independent owner.
    expect(await source.lease(f.workspaceID)).toMatchObject({
      owner: "service",
      actorUID: null,
      writable: true,
      writerEpoch: 1,
      checkpointID: null,
      generation: 0,
      serviceBase: seed.id,
    });
    expect(outcome).toBeNull();
    expect(f.hub.sourceConnected(f.attemptID)).toBe(false);
  } finally {
    await source.close();
    await f.dispose();
  }
}, 60_000);

test.each(["v2", "unversioned", "undeleted"] as const)(
  "first Source recipient after a retired allocation requires its ungranted v2 proof (%s)",
  async (prior) => {
    const f = await substrateFixture();
    const seed = seedFor(f);
    try {
      await insertSeed(f, seed);
      await confirmInitialSourcePublication(f.database, f.workspaceID, seed.id);
      const original = await f.database.client.begin((sql) =>
        admitActor(f, sql, 1, prior === "unversioned" ? {} : { sourceRestoreProtocol: 2 }),
      );
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now()
        WHERE id=${original.attemptID}`;
      if (prior !== "undeleted")
        await f.database
          .client`UPDATE factory.runtime_attempt SET delete_intended_at=now(),deleted_at=now()
          WHERE id=${original.attemptID}`;
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${original.attemptID}`;
      const successor = () =>
        f.database.client.begin((sql) => admitActor(f, sql, 2, { sourceRestoreProtocol: 2 }));
      if (prior !== "v2") {
        await expect(successor()).rejects.toThrow("exact cleanup and independent Source");
        return;
      }
      const next = await successor();
      await f.database
        .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${next.attemptID}`;
      const admitted = await initialSourceActorIn(f.database.client, seed, next.actorUID);
      expect(admitted).toHaveLength(1);
      const id = await freeze(f, 2);
      const saved = { ...manifest(f, id, null, 2, 1), seedID: seed.id };
      await confirm(f, saved, 1);
      await transfer(f, next.actorUID);
      expect((await f.database.db.select().from(substrateSource))[0]).toMatchObject({
        owner: "actor",
        actorUid: next.actorUID,
        writerEpoch: 3,
      });
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

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
        await f.database
          .client`SELECT owner_id FROM factory.substrate_provision WHERE kind='workspace'`,
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
        await sql`UPDATE factory.runtime_attempt SET observation=NULL WHERE id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.runtime_attempt SET observation=jsonb_set(observation,'{metadata,uid}',to_jsonb(${crypto.randomUUID()}::text)) WHERE id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.runtime_attempt SET create_rejected=true WHERE id=${actor.attemptID}`;
      },
      async (sql: SQL) => {
        await sql`UPDATE factory.runtime_attempt SET delete_intended_at=now() WHERE id=${actor.attemptID}`;
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
            parent_connector_token_hash,create_intended_at,created_by,
            atespace,actor_name,binding_intent)
          VALUES(${otherID},${f.projectID},${f.workspaceID},2,${"a".repeat(40)},
            'create-intended','owned-other-parent',now(),${f.userID},
            ${`fa-${otherID.replaceAll("-", "")}`},
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
        .client`UPDATE factory.runtime_attempt SET binding_intent=jsonb_set(binding_intent,'{templateUID}',to_jsonb(${crypto.randomUUID()}::text))
        WHERE id=${actor.attemptID}`.execute(),
    ).rejects.toThrow("identity and dispatch facts are immutable");
    await expect(
      f.database
        .client`UPDATE factory.substrate_provision SET resources=jsonb_set(resources,'{template,value}','{}'::jsonb)
        WHERE owner_id=${f.workspaceID} AND kind='workspace'`.execute(),
    ).rejects.toThrow("identity and dispatch facts are immutable");
    await expect(
      f.database.client`UPDATE factory.runtime_attempt SET create_attempted_at=NULL
        WHERE id=${actor.attemptID}`.execute(),
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
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',
      delete_intended_at=now(),deleted_at=now() WHERE id=${actor.attemptID}`;
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
