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
    await candidate`INSERT INTO factory.factorybox_worker(
      profile,runtime_host_image,node_name,namespace_uid,source_claim_uid,claim_uid,pod_uid,create_attempted)
      VALUES('{"retained":"original"}'::jsonb,${`registry.invalid/runtime@sha256:${"a".repeat(64)}`},
        'owned-node','original-namespace','original-source','original-store','original-pod',true)`;
    const [retainedWorker] = await candidate`SELECT * FROM factory.factorybox_worker`;
    if (!retainedWorker) throw new Error("Missing retained baseline worker");
    const actorID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const attemptID = crypto.randomUUID();
    await candidate`INSERT INTO auth."user"(id,name,email)
      VALUES(${actorID},'Owned retained baseline',${`${actorID}@baseline.test`})`;
    await candidate`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,
      devcontainer_path,created_by,desktop_background_key)
      VALUES(${projectID},${`baseline-${projectID}`},'Owned retained baseline',
        'https://example.invalid/baseline.git','main','.devcontainer/devcontainer.json',
        ${actorID},'river-landscape')`;
    await candidate`INSERT INTO factory.runtime_attempt(
      id,project_id,isolated_kind,generation,revision,state,
      parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${attemptID},${projectID},'staging',1,${"a".repeat(40)},'failed',
        ${"b".repeat(64)},${"c".repeat(64)},now(),${actorID})`;
    const [retainedAttempt] =
      await candidate`SELECT * FROM factory.runtime_attempt WHERE id=${attemptID}`;
    if (!retainedAttempt) throw new Error("Missing retained baseline Runtime Attempt");
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const config = getTableConfig(table);
      await candidate.unsafe(
        `SELECT ${config.columns.map((column) => `"${column.name}"`).join(",")} FROM "${config.schema}"."${config.name}" LIMIT 0`,
      );
    }
    let upgradedDigest = "";
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
      const currentDigest = digest(await dump(container, probeName));
      if (run === 0) upgradedDigest = currentDigest;
      else expect(currentDigest).toBe(upgradedDigest);
      expect([...(await candidate`SELECT * FROM factory.factorybox_worker`)]).toEqual([
        retainedWorker,
      ]);
      const [upgradedAttempt] =
        await candidate`SELECT * FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!upgradedAttempt) throw new Error("Upgrade lost the retained Runtime Attempt");
      const { factorybox_admission_id, ...unchangedAttempt } = upgradedAttempt;
      expect(factorybox_admission_id).toBe(retainedWorker["id"]);
      expect(unchangedAttempt).toEqual(retainedAttempt);
      expect([
        ...(await candidate`SELECT id,worker_id,profile,runtime_host_image,claim_uid,pod_uid,
          identity,create_attempted,previous_id,retired_at FROM factory.factorybox_worker_admission`),
      ]).toEqual([
        {
          id: retainedWorker["id"],
          worker_id: retainedWorker["id"],
          profile: { retained: "original" },
          runtime_host_image: `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
          claim_uid: "original-store",
          pod_uid: "original-pod",
          identity: null,
          create_attempted: true,
          previous_id: null,
          retired_at: null,
        },
      ]);
    }
    expect(upgradedDigest).not.toBe(baselineDigest);
    expect(upgradedDigest).toBe(digest(original));
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
      const originalVersions = [
        ...(await database.client<{ version: number }[]>`
          SELECT version FROM factory.schema_migration ORDER BY version`),
      ];
      expect(originalVersions[0]?.version).toBe(1);
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
        expect([
          ...(await database.client`SELECT version FROM factory.schema_migration ORDER BY version`),
        ]).toEqual(
          originalVersions.map((row) => ({ version: row.version === 1 ? 0 : row.version })),
        );
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
