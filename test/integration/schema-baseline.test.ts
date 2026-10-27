import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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

test("fresh and repeated installs preserve typed schema, allowed Zero tables and database invariants", async () => {
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
    expect(publications.map((table) => `${table.schemaname}.${table.tablename}`)).toEqual([
      "factory.epic",
      "factory.knowledge_page",
      "factory.knowledge_page_outline",
      "factory.project",
      "factory.project_membership",
      "factory.read_version",
      "factory.ticket",
      "factory.ticket_dependency",
    ]);
    await database.client.unsafe(`CREATE DATABASE ${probeName}`);
    created = true;
    const sql = await readFile("packages/db/migrations/0001_baseline.sql", "utf8");
    await candidate.unsafe(sql);
    const baselineDigest = digest(await dump(container, probeName));
    const freshPublication = await candidate<{ schemaname: string; tablename: string }[]>`
      SELECT schemaname,tablename FROM pg_publication_tables
      WHERE pubname='factory_zero_publication' ORDER BY schemaname,tablename`;
    expect([...freshPublication]).toEqual([...publications]);
    expect([...(await candidate`SELECT version FROM factory.schema_migration`)]).toEqual([
      { version: 1 },
    ]);
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const config = getTableConfig(table);
      await candidate.unsafe(
        `SELECT ${config.columns.map((column) => `"${column.name}"`).join(",")} FROM "${config.schema}"."${config.name}" LIMIT 0`,
      );
    }
    for (let run = 0; run < 2; run++) {
      const migration = Bun.spawn(
        [process.execPath, "--no-env-file", "packages/db/src/migrate.ts"],
        {
          env: { ...process.env, DATABASE_URL: candidateURL.toString() },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [error, status] = await Promise.all([
        new Response(migration.stderr).text(),
        migration.exited,
      ]);
      if (status !== 0) throw new Error(`Repeated owned migration failed: ${error}`);
      expect(digest(await dump(container, probeName))).toBe(baselineDigest);
    }
    expect(baselineDigest).toBe(digest(original));
    const versions = (await readdir("packages/db/migrations"))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .map((file) => ({ version: Number(file.slice(0, 4)) }))
      .sort((a, b) => a.version - b.version);
    expect([
      ...(await candidate`SELECT version FROM factory.schema_migration ORDER BY version`),
    ]).toEqual(versions);
    await candidate`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES ('01994a7d-0000-7000-8000-000000000001','Owned baseline invariant probe','baseline@test.invalid',true)`;
    const invariants = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/integration/postgres.ts"],
      {
        env: { ...process.env, DATABASE_URL: candidateURL.toString() },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, status] = await Promise.all([
      new Response(invariants.stdout).text(),
      new Response(invariants.stderr).text(),
      invariants.exited,
    ]);
    if (status !== 0) throw new Error(`Fresh owned baseline invariants failed: ${error}`);
    expect(output).toContain("clean baseline invariants passed");
    expect(await candidate`SELECT singleton FROM factory.installation_maintenance`).toHaveLength(1);
    expect(await candidate`SELECT id FROM factory.attachment_storage`).toHaveLength(1);
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

test.each(["historical versions", "partial schema"] as const)(
  "Greenfield install refuses %s without deleting or rewriting existing data",
  async (state) => {
    const factory = await factoryProcess();
    const database = factory.connect(1);
    const userID = crypto.randomUUID();
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Retained owner',${`${userID}@baseline.test`})`;
      if (state === "historical versions")
        await database.client`UPDATE factory.schema_migration SET version=0 WHERE version=1`;
      else await database.client`DROP TABLE factory.schema_migration`;
      const child = Bun.spawn([process.execPath, "--no-env-file", "packages/db/src/migrate.ts"], {
        env: { ...process.env, DATABASE_URL: factory.databaseURL },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(status).not.toBe(0);
      expect(error).toContain("Greenfield baseline");
      expect([...(await database.client`SELECT name FROM auth."user" WHERE id=${userID}`)]).toEqual(
        [{ name: "Retained owner" }],
      );
      if (state === "historical versions")
        expect([...(await database.client`SELECT version FROM factory.schema_migration`)]).toEqual([
          { version: 0 },
        ]);
      else {
        const [schema] = await database.client<{ relation: string | null }[]>`
          SELECT to_regclass('factory.schema_migration')::text AS relation`;
        expect(schema?.relation).toBeNull();
      }
    } finally {
      await database.client.end({ timeout: 2 });
      await factory.dispose();
    }
  },
  60_000,
);
