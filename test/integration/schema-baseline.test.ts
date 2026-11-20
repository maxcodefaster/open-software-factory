import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { drizzleTransaction } from "../../packages/db/src/client";
import { baselineDigest, readMigration, shippedMigrations } from "../../packages/db/src/migrations";
import * as schema from "../../packages/db/src/schema";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

test("typed and native queries share commit, rollback and nested savepoints on the same connection", async () => {
  const server = await ownedPostgresServer();
  const client = postgres(server.identity.url, { max: 2 });
  const id = crypto.randomUUID();
  try {
    await expect(
      client.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        await db.insert(schema.authUser).values({
          id,
          name: "Typed transaction",
          email: `typed-${id}@baseline.test`,
        });
        expect([...(await transaction`SELECT name FROM auth."user" WHERE id=${id}`)]).toEqual([
          { name: "Typed transaction" },
        ]);
        await expect(
          db.transaction(async (nested) => {
            await nested
              .update(schema.authUser)
              .set({ name: "Rolled-back savepoint" })
              .where(eq(schema.authUser.id, id));
            throw new Error("Owned savepoint rollback");
          }),
        ).rejects.toThrow("Owned savepoint rollback");
        expect(await db.select({ name: schema.authUser.name }).from(schema.authUser)).toEqual([
          { name: "Typed transaction" },
        ]);
        throw new Error("Owned outer rollback");
      }),
    ).rejects.toThrow("Owned outer rollback");
    expect(await client`SELECT id FROM auth."user" WHERE id=${id}`).toHaveLength(0);
    await client.begin(async (transaction) => {
      const db = drizzleTransaction(transaction);
      await db.insert(schema.authUser).values({
        id,
        name: "Committed transaction",
        email: `typed-${id}@baseline.test`,
      });
      await transaction`UPDATE auth."user" SET name='Native update' WHERE id=${id}`;
      expect(
        await db
          .select({ name: schema.authUser.name })
          .from(schema.authUser)
          .where(eq(schema.authUser.id, id)),
      ).toEqual([{ name: "Native update" }]);
    });
    expect([...(await client`SELECT name FROM auth."user" WHERE id=${id}`)]).toEqual([
      { name: "Native update" },
    ]);
  } finally {
    await client.end({ timeout: 2 });
    await server.dispose();
  }
});

async function initialize(url: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "packages/db/src/migrate.ts"], {
    env: { ...verificationEnvironment(process.env), DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { status, stderr, stdout };
}

async function dump(container: string, database: string) {
  const child = Bun.spawn(
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
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Owned schema dump failed: ${error}`);
  return output
    .split("\n")
    .filter((line) => !line.startsWith("--") && !line.startsWith("\\") && !line.startsWith("SET "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fingerprint() {
  const file = (await shippedMigrations())[0];
  if (!file) throw new Error("Missing native baseline");
  return baselineDigest(await readMigration(file));
}

test("fresh concurrent initialization and repeated startup preserve the native schema, Source and approvals", async () => {
  const server = await ownedPostgresServer();
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID(), false, "template0");
  const sql = postgres(target.url, { max: 1 });
  const container = `factory-test-postgres-${server.identity.owner}`;
  const name = new URL(target.url).pathname.slice(1);
  const actorID = crypto.randomUUID(),
    projectID = crypto.randomUUID();
  const workspaceID = crypto.randomUUID(),
    actorUID = crypto.randomUUID();
  const ticketID = crypto.randomUUID(),
    revisionID = crypto.randomUUID(),
    approvalID = crypto.randomUUID();
  const attemptID = runtimeIdentity(workspaceID, 1).attemptID;
  try {
    const installs = await Promise.all([initialize(target.url), initialize(target.url)]);
    for (const install of installs) expect(install).toEqual({ status: 0, stderr: "", stdout: "" });
    const originalSchema = await dump(container, name);
    expect([...(await sql`SELECT version,source_digest FROM factory.schema_migration`)]).toEqual([
      { version: 1, source_digest: await fingerprint() },
    ]);
    const publications = await sql<{ schemaname: string; tablename: string }[]>`
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
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const config = getTableConfig(table);
      await sql.unsafe(
        `SELECT ${config.columns.map((column) => `"${column.name}"`).join(",")} FROM "${config.schema}"."${config.name}" LIMIT 0`,
      );
    }
    expect(await sql`SELECT singleton FROM factory.installation_maintenance`).toHaveLength(1);
    expect(await sql`SELECT id FROM factory.attachment_storage`).toHaveLength(1);
    for (const table of [
      "factorybox_worker",
      "factorybox_worker_admission",
      "factorybox_runtime",
      "factorybox_lifecycle_operation",
      "execution_slot",
      "workspace_source",
      "runtime_artifact_intent",
      "verification_compute_placement",
    ])
      expect([...(await sql`SELECT to_regclass(${`factory.${table}`}) AS relation`)]).toEqual([
        { relation: null },
      ]);
    expect(
      await sql`
      SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='factory'
        AND (column_name LIKE '%factorybox%' OR (table_name='substrate_source' AND column_name='preservation')
          OR (table_name IN ('runtime_attempt','development_workspace')
          AND column_name IN ('kubernetes_namespace','namespace_uid','pod_uid','claim_uid',
            'volume_name','cleanup_job_name','cleanup_job_uid')))`,
    ).toHaveLength(0);
    const functions = await sql<{ definition: string }[]>`
      WITH scoped AS MATERIALIZED (
        SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='factory' AND p.prokind='f')
      SELECT pg_get_functiondef(oid) AS definition FROM scoped`;
    expect(
      functions.filter(({ definition }) =>
        /factorybox|execution_slot|workspace_source|runtime_artifact_intent|verification_compute_placement|protect_execution_template_initial_health|protect_substrate_source_preservation/i.test(
          definition,
        ),
      ),
    ).toHaveLength(0);

    await sql.begin(async (tx) => {
      await tx`INSERT INTO auth."user"(id,name,email)
        VALUES(${actorID},'Owned native baseline',${`${actorID}@baseline.test`})`;
      await tx`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`baseline-${projectID}`},'Owned native baseline',
          'https://example.invalid/baseline.git','main','.devcontainer/devcontainer.json',${actorID})`;
      await tx`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
        VALUES(${workspaceID},${projectID},'personal',${actorID},'main',${"a".repeat(40)},${actorID})`;
      await tx`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${workspaceID},'{}')`;
      await tx`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${attemptID},${projectID},${workspaceID},1,${"a".repeat(40)},'create-intended',
          ${"b".repeat(64)},${"c".repeat(64)},now(),${actorID})`;
      await tx`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at)
        VALUES(${attemptID},${`fa-${attemptID.replaceAll("-", "")}`},${`runtime-${attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
      await tx`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${attemptID}`;
      await tx`INSERT INTO factory.substrate_source(workspace_id,actor_uid) VALUES(${workspaceID},${actorUID})`;
      await tx`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${crypto.randomUUID()}
        WHERE workspace_id=${workspaceID}`;
      await tx`INSERT INTO factory.ticket(id,project_id,title,created_by)
        VALUES(${ticketID},${projectID},'Approved saved requirement',${actorID})`;
      const content = '{"summary":"Keep this approval pinned"}';
      await tx`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        VALUES(${revisionID},${ticketID},1,${content},${createHash("sha256").update(content).digest("hex")},${actorID})`;
      await tx`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
        VALUES(${approvalID},${ticketID},${revisionID},${actorID})`;
    });
    const records = () => sql`SELECT 'account' AS kind,to_jsonb(a) AS value FROM auth."user" a
      UNION ALL SELECT 'project',to_jsonb(p) FROM factory.project p
      UNION ALL SELECT 'workspace',to_jsonb(w) FROM factory.development_workspace w
      UNION ALL SELECT 'provision',to_jsonb(p) FROM factory.substrate_workspace p
      UNION ALL SELECT 'attempt',to_jsonb(a) FROM factory.runtime_attempt a
      UNION ALL SELECT 'binding',to_jsonb(b) FROM factory.substrate_binding b
      UNION ALL SELECT 'source',to_jsonb(s) FROM factory.substrate_source s
      UNION ALL SELECT 'requirement',to_jsonb(r) FROM factory.requirement_revision r
      UNION ALL SELECT 'approval',to_jsonb(a) FROM factory.requirement_approval a
      UNION ALL SELECT 'attachment-storage',to_jsonb(s) FROM factory.attachment_storage s
      ORDER BY kind`;
    const retained = await records();
    for (let run = 0; run < 2; run++) {
      expect(await initialize(target.url)).toEqual({ status: 0, stderr: "", stdout: "" });
      expect(await dump(container, name)).toBe(originalSchema);
      expect(await records()).toEqual(retained);
      expect([...(await sql`SELECT version,source_digest FROM factory.schema_migration`)]).toEqual([
        { version: 1, source_digest: await fingerprint() },
      ]);
    }
  } finally {
    await sql.end({ timeout: 2 });
    await target.dispose();
    await server.dispose();
  }
}, 60_000);

test("unknown history, missing registration and mismatched fingerprints refuse startup without modifying retained data", async () => {
  const server = await ownedPostgresServer();
  try {
    for (const state of [
      "historical versions",
      "missing fingerprint",
      "partial schema",
      "mismatched fingerprint",
    ]) {
      const target = await ownedTestDatabase(
        server.identity,
        crypto.randomUUID(),
        false,
        "template0",
      );
      const sql = postgres(target.url, { max: 1 });
      const container = `factory-test-postgres-${server.identity.owner}`;
      const name = new URL(target.url).pathname.slice(1);
      try {
        if (state === "mismatched fingerprint") {
          expect((await initialize(target.url)).status).toBe(0);
          await sql`UPDATE factory.schema_migration SET source_digest=${"0".repeat(64)} WHERE version=1`;
          await sql`INSERT INTO auth."user"(id,name,email)
            VALUES(${crypto.randomUUID()},'Retained owner','retained@baseline.test')`;
        } else {
          // A stand-in for unknown history, not a supported upgrade fixture.
          await sql.unsafe(`CREATE SCHEMA auth; CREATE SCHEMA factory;
            CREATE TABLE auth."user"(id text PRIMARY KEY,name text);
            INSERT INTO auth."user" VALUES('retained','Retained owner');`);
          if (state === "historical versions") {
            await sql.unsafe(
              "CREATE TABLE factory.schema_migration(version integer,source_digest text)",
            );
            await sql`INSERT INTO factory.schema_migration(version,source_digest) VALUES(1,${await fingerprint()}),(37,'unknown')`;
          } else if (state === "missing fingerprint") {
            await sql.unsafe(
              "CREATE TABLE factory.schema_migration(version integer); INSERT INTO factory.schema_migration VALUES(1)",
            );
          }
        }
        const before = await dump(container, name);
        const account = await sql`SELECT * FROM auth."user"`;
        const registered =
          state === "partial schema"
            ? []
            : [...(await sql`SELECT * FROM factory.schema_migration`)];
        for (let run = 0; run < 2; run++) {
          const result = await initialize(target.url);
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            state === "mismatched fingerprint" ? "baseline differs" : "Greenfield baseline",
          );
          expect(await sql`SELECT * FROM auth."user"`).toEqual(account);
          expect(await dump(container, name)).toBe(before);
          if (state !== "partial schema")
            expect([...(await sql`SELECT * FROM factory.schema_migration`)]).toEqual(registered);
        }
      } finally {
        await sql.end({ timeout: 2 });
        await target.dispose();
      }
    }
  } finally {
    await server.dispose();
  }
}, 60_000);
