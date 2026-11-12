import { expect, test } from "bun:test";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client";
import { readMigration, shippedMigrations } from "../../packages/db/src/migrations";
import { fixture } from "../fixtures/change-agent-turns";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

test("17 to 18 retains existing workers, Source and executions and pins the exact native Verification job", async () => {
  const server = await ownedPostgresServer();
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID(), false, "template0");
  const sql = postgres(target.url, { max: 1 });
  const previous = process.env["DATABASE_URL"];
  let owned: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const files = await shippedMigrations();
    for (const migration of files.filter((file) => file.version <= 17))
      await sql.unsafe(await readMigration(migration));
    process.env["DATABASE_URL"] = target.url;
    owned = await fixture(undefined, undefined, createDatabase());
    const id = crypto.randomUUID();
    await sql`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,created_by)
      VALUES(${id},${owned.changeID},${"d".repeat(40)},1,'owned-job-upgrade',4,${owned.userID})`;
    const retained =
      () => sql`SELECT 'worker' AS kind,to_jsonb(worker) AS value FROM factory.factorybox_worker worker
      UNION ALL SELECT 'workspace',to_jsonb(workspace) FROM factory.development_workspace workspace
      UNION ALL SELECT 'attempt',to_jsonb(attempt) FROM factory.runtime_attempt attempt
      UNION ALL SELECT 'verification',to_jsonb(verification)-'runner_job_handle' FROM factory.verification verification`;
    const before = await retained();
    const migration = files.find((file) => file.version === 18);
    if (!migration) throw new Error("Native Verification job migration missing");
    await sql.unsafe(await readMigration(migration));
    expect(await retained()).toEqual(before);
    await sql`UPDATE factory.verification SET runner_job_handle='owned-exact-job' WHERE id=${id}`;
    for (const query of [
      sql`UPDATE factory.verification SET runner_job_handle='foreign-job' WHERE id=${id}`,
      sql`UPDATE factory.verification SET action_run_id=5 WHERE id=${id}`,
      sql`UPDATE factory.verification SET commit_sha=${"e".repeat(40)} WHERE id=${id}`,
    ]) {
      await expect(Promise.resolve(query)).rejects.toThrow("immutable");
    }
  } finally {
    await owned?.dispose();
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
    await sql.end();
    await target.dispose();
    await server.dispose();
  }
}, 60_000);
