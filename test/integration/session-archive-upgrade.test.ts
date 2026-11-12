import { expect, test } from "bun:test";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client";
import {
  pendingMigrations,
  readMigration,
  shippedMigrations,
} from "../../packages/db/src/migrations";
import { fixture } from "../fixtures/change-agent-turns";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

test("upgrade from migration 15 preserves existing worker, attempt and Source identities", async () => {
  const server = await ownedPostgresServer();
  const database = await ownedTestDatabase(
    server.identity,
    crypto.randomUUID(),
    false,
    "template0",
  );
  const sql = postgres(database.url, { max: 1 });
  let owned: Awaited<ReturnType<typeof fixture>> | undefined;
  const previousURL = process.env["DATABASE_URL"];
  try {
    const files = await shippedMigrations();
    for (const file of files.filter((file) => file.version <= 15))
      await sql.unsafe(await readMigration(file));
    process.env["DATABASE_URL"] = database.url;
    owned = await fixture(undefined, undefined, createDatabase());
    async function identities() {
      return sql`SELECT * FROM (SELECT 'worker' AS kind,to_jsonb(worker)-'node_identity' AS value FROM factory.factorybox_worker worker
        UNION ALL SELECT 'admission',to_jsonb(admission) FROM factory.factorybox_worker_admission admission
        UNION ALL SELECT 'attempt',to_jsonb(attempt)-'substrate' FROM factory.runtime_attempt attempt
        UNION ALL SELECT 'workspace',to_jsonb(workspace)-'substrate' FROM factory.development_workspace workspace) retained
        ORDER BY kind,value->>'id'`;
    }
    const original = await identities();
    const pending = pendingMigrations(
      files,
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(pending.map((file) => file.version)).toEqual([
      16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    ]);
    for (const file of pending) await sql.unsafe(await readMigration(file));
    expect(await identities()).toEqual(original);
    expect(await sql`SELECT turn_id FROM factory.session_archive`).toHaveLength(0);
    expect(
      (await sql`SELECT max(version) AS version FROM factory.schema_migration`)[0]?.["version"],
    ).toBe(26);
    expect(await sql`SELECT id FROM factory.runtime_attempt WHERE substrate`).toHaveLength(0);
    expect(await sql`SELECT id FROM factory.development_workspace WHERE substrate`).toHaveLength(0);
  } finally {
    await owned?.dispose();
    if (previousURL === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousURL;
    await sql.end();
    await database.dispose();
    await server.dispose();
  }
}, 60_000);
