import { expect, test } from "bun:test";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client";
import { readMigration, shippedMigrations } from "../../packages/db/src/migrations";
import { fixture } from "../fixtures/change-agent-turns";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

for (const version of [15, 18])
  test(`owned v${version} upgrade retains old Workspace/worker/Attempt identities through v19`, async () => {
    const server = await ownedPostgresServer();
    const target = await ownedTestDatabase(
      server.identity,
      crypto.randomUUID(),
      false,
      "template0",
    );
    const sql = postgres(target.url, { max: 1 });
    const beforeURL = process.env["DATABASE_URL"];
    let owned: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const files = await shippedMigrations();
      for (const migration of files.filter((f) => f.version <= version))
        await sql.unsafe(await readMigration(migration));
      process.env["DATABASE_URL"] = target.url;
      owned = await fixture(undefined, undefined, createDatabase());
      const retained =
        () => sql`SELECT 'worker' AS kind,to_jsonb(w)-'node_identity' AS value FROM factory.factorybox_worker w
        UNION ALL SELECT 'workspace',to_jsonb(w)-'substrate' FROM factory.development_workspace w
      UNION ALL SELECT 'attempt',to_jsonb(a)-'substrate' FROM factory.runtime_attempt a ORDER BY kind`;
      const before = await retained();
      for (const migration of files.filter((f) => f.version > version))
        await sql.unsafe(await readMigration(migration));
      expect(await retained()).toEqual(before);
      expect(await sql`SELECT runtime_attempt_id FROM factory.substrate_binding`).toHaveLength(0);
      await expect(
        sql.begin(async (tx) => {
          await tx`UPDATE factory.runtime_attempt SET substrate=true,factorybox_worker_id=NULL,factorybox_admission_id=NULL WHERE id=${owned?.attemptID ?? ""}`;
        }),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          sql`UPDATE factory.runtime_attempt SET factorybox_worker_id=NULL WHERE id=${owned.attemptID}`,
        ),
      ).rejects.toThrow();
    } finally {
      await owned?.dispose();
      if (beforeURL === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = beforeURL;
      await sql.end();
      await target.dispose();
      await server.dispose();
    }
  }, 60_000);
