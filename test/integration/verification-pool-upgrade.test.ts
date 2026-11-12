import { expect, test } from "bun:test";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client";
import { readMigration, shippedMigrations } from "../../packages/db/src/migrations";
import { fixture } from "../fixtures/change-agent-turns";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { ownedFactoryboxProfile } from "../fixtures/runtime-configuration";

test("migration 16 to 17 preserves original admissions and Source references while adding immutable remote Verification bindings", async () => {
  const server = await ownedPostgresServer();
  const database = await ownedTestDatabase(
    server.identity,
    crypto.randomUUID(),
    false,
    "template0",
  );
  const sql = postgres(database.url, { max: 1 });
  const previous = process.env["DATABASE_URL"];
  let owned: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const files = await shippedMigrations();
    for (const file of files.filter((f) => f.version <= 16))
      await sql.unsafe(await readMigration(file));
    process.env["DATABASE_URL"] = database.url;
    owned = await fixture(undefined, undefined, createDatabase());
    const retained = () => sql`SELECT * FROM (
      SELECT 'worker' AS kind,to_jsonb(worker)-'node_identity' AS value FROM factory.factorybox_worker worker
      UNION ALL SELECT 'admission',to_jsonb(admission) FROM factory.factorybox_worker_admission admission
      UNION ALL SELECT 'workspace',to_jsonb(workspace) FROM factory.development_workspace workspace
      UNION ALL SELECT 'attempt',to_jsonb(attempt) FROM factory.runtime_attempt attempt
    ) original ORDER BY kind,value->>'id'`;
    const before = await retained();
    const upgrade = files.find((f) => f.version === 17);
    if (!upgrade) throw new Error("Verification pool migration is missing");
    await sql.unsafe(await readMigration(upgrade));
    expect(await retained()).toEqual(before);
    const remote = crypto.randomUUID();
    const profile = {
      ...ownedFactoryboxProfile,
      nodeName: "owned-remote",
      resources: { cpuMilli: 3000, memoryMiB: 3072 },
    };
    const nodeIdentity = {
      uid: "owned-node-uid",
      bootID: "owned-boot",
      architecture: "amd64",
      operatingSystem: "linux",
    };
    await sql`INSERT INTO factory.factorybox_worker(id,singleton,node_name,node_identity)
      VALUES(${remote},false,'owned-remote',${JSON.stringify(nodeIdentity)}::text::jsonb)`;
    await sql`INSERT INTO factory.factorybox_worker_admission(id,worker_id,profile,runtime_host_image)
      VALUES(${remote},${remote},${JSON.stringify(profile)}::text::jsonb,${`example.invalid/host@sha256:${"a".repeat(64)}`})`;
    expect(await sql`SELECT id FROM factory.factorybox_worker`).toHaveLength(2);
    const [original] = await sql<
      Array<{ id: string }>
    >`SELECT factory.ensure_factorybox_worker() AS id`;
    expect(original?.id).not.toBe(remote);
    await expect(
      Promise.resolve(
        sql`UPDATE factory.factorybox_worker SET node_identity='{}'::jsonb WHERE id=${remote}`,
      ),
    ).rejects.toThrow("immutable");
    await expect(
      Promise.resolve(sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,factorybox_worker_id,factorybox_admission_id)
      VALUES(${crypto.randomUUID()},${owned.projectID},'staging',1,${"d".repeat(40)},'create-intended',
        ${"b".repeat(64)},${"c".repeat(64)},now(),${owned.userID},${remote},${remote})`),
    ).rejects.toThrow("fresh isolated Verification");
    expect(await sql`SELECT * FROM factory.verification_compute_placement`).toHaveLength(0);
  } finally {
    await owned?.dispose();
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
    await sql.end();
    await database.dispose();
    await server.dispose();
  }
}, 60_000);
