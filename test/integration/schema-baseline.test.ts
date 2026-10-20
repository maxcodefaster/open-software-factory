import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "../../packages/db/src/schema";
import { factoryProcess } from "../fixtures/factory-process";

const digest = (sql: string) => createHash("sha256").update(sql).digest("hex");

async function dump(container: string, database: string) {
  const process = Bun.spawn(
    [
      "docker",
      "exec",
      container,
      "pg_dump",
      "-U",
      "factory",
      "-d",
      database,
      "--schema-only",
      "--schema=auth",
      "--schema=factory",
      "--no-owner",
      "--no-acl",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) throw new Error(`Owned schema dump failed: ${error}`);
  return output
    .split("\n")
    .filter((line) => !line.startsWith("--") && !line.startsWith("\\") && !line.startsWith("SET "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

test("clean Factory baseline preserves the final schema, publication and fresh/repeated install invariants", async () => {
  const factory = await factoryProcess();
  const database = factory.connect(1);
  const candidateURL = new URL(factory.databaseURL);
  const probeName = `baseline_probe_${factory.id.replaceAll("-", "")}`;
  candidateURL.pathname = `/${probeName}`;
  const candidate = postgres(candidateURL.toString(), { max: 1 });
  let created = false;
  try {
    const shared = process.env["FACTORY_TEST_POSTGRES"];
    const container = shared
      ? `factory-test-postgres-${(JSON.parse(shared) as { owner: string }).owner}`
      : `factory-owned-commit-process-${factory.id}`;
    const original = await dump(container, new URL(factory.databaseURL).pathname.slice(1));
    const publications = await database.client<{ schemaname: string; tablename: string }[]>`
      SELECT schemaname,tablename FROM pg_publication_tables
      WHERE pubname='factory_zero_publication' ORDER BY schemaname,tablename`;
    expect(publications).toHaveLength(6);
    await database.client.unsafe(`CREATE DATABASE ${probeName}`);
    created = true;
    const sql = await readFile(
      process.env["FACTORY_BASELINE_CANDIDATE"] ?? "packages/db/migrations/0000_baseline.sql",
      "utf8",
    );
    await candidate.unsafe(sql);
    expect(digest(await dump(container, probeName))).toBe(
      "1ea24d98676787c858b7ae3c93123ce90b96bbf74ddb2fb8810f54f4decbac86",
    );
    const freshPublication = await candidate<{ schemaname: string; tablename: string }[]>`
      SELECT schemaname,tablename FROM pg_publication_tables
      WHERE pubname='factory_zero_publication' ORDER BY schemaname,tablename`;
    expect([...freshPublication]).toEqual([...publications]);
    expect([...(await candidate`SELECT version FROM factory.schema_migration`)]).toEqual([
      { version: 0 },
    ]);
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const config = getTableConfig(table);
      await candidate.unsafe(
        `SELECT ${config.columns.map((column) => `"${column.name}"`).join(",")} FROM "${config.schema}"."${config.name}" LIMIT 0`,
      );
    }
    let migratedDigest = "";
    for (let run = 0; run < 2; run++) {
      const migration = Bun.spawn([process.execPath, "packages/db/src/migrate.ts"], {
        env: { ...process.env, DATABASE_URL: candidateURL.toString() },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [error, status] = await Promise.all([
        new Response(migration.stderr).text(),
        migration.exited,
      ]);
      if (status !== 0) throw new Error(`Repeated owned migration failed: ${error}`);
      const currentDigest = digest(await dump(container, probeName));
      if (run === 0) migratedDigest = currentDigest;
      else expect(currentDigest).toBe(migratedDigest);
    }
    expect(digest(await dump(container, probeName))).toBe(migratedDigest);
    expect(migratedDigest).toBe(digest(original));
    const versions = (await readdir("packages/db/migrations"))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .map((file) => ({ version: Number(file.slice(0, 4)) }))
      .sort((a, b) => a.version - b.version);
    expect([
      ...(await candidate`SELECT version FROM factory.schema_migration ORDER BY version`),
    ]).toEqual(versions);
    await candidate`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES ('01994a7d-0000-7000-8000-000000000001','Owned baseline invariant probe','baseline@test.invalid',true)`;
    const invariants = Bun.spawn([process.execPath, "scripts/integration/postgres.ts"], {
      env: { ...process.env, DATABASE_URL: candidateURL.toString() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, status] = await Promise.all([
      new Response(invariants.stdout).text(),
      new Response(invariants.stderr).text(),
      invariants.exited,
    ]);
    if (status !== 0) throw new Error(`Fresh owned baseline invariants failed: ${error}`);
    expect(output).toContain("clean baseline invariants passed");
    console.log(
      JSON.stringify({
        schemaBaselineDigest: digest(original),
        bytes: original.length,
        publicationTables: publications.length,
      }),
    );
  } finally {
    await candidate.end({ timeout: 2 });
    if (created) await database.client.unsafe(`DROP DATABASE ${probeName} WITH (FORCE)`);
    await database.client.end({ timeout: 2 });
    await factory.dispose();
  }
}, 60000);
