import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { createUIPreferenceController } from "../../apps/factory/src/preferences/controller";
import { defaultExecutionPolicy } from "../../packages/conversation-domain/src/execution-policy";
import { createDatabase, drizzleTransaction } from "../../packages/db/src/client";
import { baselineDigest, readMigration, shippedMigrations } from "../../packages/db/src/migrations";
import * as schema from "../../packages/db/src/schema";
import { desktopBackgroundKeys } from "../../packages/interface-domain/src/background";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

test("personal backgrounds save every catalog choice and reject unknown keys in PostgreSQL", async () => {
  const server = await ownedPostgresServer();
  const original = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = server.identity.url;
  const database = createDatabase(1);
  if (original === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = original;
  const preferences = createUIPreferenceController(database);
  const userID = crypto.randomUUID();
  try {
    await database.db.insert(schema.authUser).values({
      id: userID,
      name: "Owned artwork catalog",
      email: `${userID}@artwork.test`,
    });
    for (const key of desktopBackgroundKeys) {
      await database.db
        .insert(schema.userUIPreference)
        .values({ userId: userID, desktopBackgroundKey: key })
        .onConflictDoUpdate({
          target: schema.userUIPreference.userId,
          set: { desktopBackgroundKey: key },
        });
      expect(await preferences.get(userID)).toEqual({ desktopBackgroundKey: key });
      for (const invalid of ["custom-theme", "https://example.invalid/artwork.jpg"])
        await expect(
          Promise.resolve().then(
            () => database.client`UPDATE factory.user_ui_preference
              SET desktop_background_key=${invalid} WHERE user_id=${userID}`,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint_name: "user_ui_preference_desktop_background_key_check",
        });
      expect(await preferences.get(userID)).toEqual({ desktopBackgroundKey: key });
    }
  } finally {
    await database.client.end({ timeout: 2 });
    await server.dispose();
  }
}, 60_000);

test("Runtime Attempt ownership keeps all forty NULL/value combinations equivalent", async () => {
  const server = await ownedPostgresServer();
  const client = postgres(server.identity.url, { max: 1 });
  let accepted = 0;
  try {
    // Copy the installed checks without foreign keys or lifecycle triggers so every
    // ownership shape reaches PostgreSQL's real CHECK evaluator independently.
    await client.unsafe(`CREATE TEMP TABLE runtime_attempt_owner_cases
      (LIKE factory.runtime_attempt INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    const checks = await client<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid='factory.runtime_attempt'::regclass AND contype='c'
        AND conname IN ('runtime_attempt_native_owner','runtime_attempt_owner_shape_check',
          'runtime_attempt_verification_shape_check') ORDER BY conname`;
    expect([...checks]).toEqual([{ name: "runtime_attempt_native_owner" }]);
    for (const workspace of [null, crypto.randomUUID()])
      for (const change of [null, crypto.randomUUID()])
        for (const kind of [null, "verification", "prebuild", "staging", "publication"])
          for (const verification of [null, crypto.randomUUID()]) {
            const [previous] = await client<{ allowed: boolean }[]>`
              WITH shape AS (SELECT ${workspace}::uuid AS workspace_id,${change}::uuid AS change_id,
                ${kind}::factory.isolated_runtime_kind AS isolated_kind,${verification}::uuid AS verification_id)
              SELECT (
                (((workspace_id IS NOT NULL AND isolated_kind IS NULL AND verification_id IS NULL)
                  OR (workspace_id IS NULL AND change_id IS NULL AND isolated_kind='verification'
                    AND verification_id IS NOT NULL)
                  OR (workspace_id IS NULL AND change_id IS NULL
                    AND isolated_kind IN ('prebuild','staging','publication') AND verification_id IS NULL))
                  IS NOT FALSE)
                AND (((workspace_id IS NOT NULL AND isolated_kind IS NULL)
                  OR (change_id IS NOT NULL AND workspace_id IS NOT NULL AND isolated_kind IS NULL)
                  OR (change_id IS NULL AND workspace_id IS NULL AND isolated_kind IS NOT NULL))
                  IS NOT FALSE)
                AND (((isolated_kind='verification')=(verification_id IS NOT NULL)) IS NOT FALSE)
              ) AS allowed FROM shape`;
            const allowed =
              workspace !== null
                ? kind === null && verification === null
                : change === null &&
                  (kind === "verification"
                    ? verification !== null
                    : kind !== null && verification === null);
            expect(previous?.allowed).toBe(allowed);
            const insert = async () => {
              await client`INSERT INTO runtime_attempt_owner_cases
                (id,project_id,workspace_id,change_id,isolated_kind,verification_id,generation,revision,
                  state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
                VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${workspace},${change},${kind},
                  ${verification},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},
                  ${"c".repeat(64)},now(),${crypto.randomUUID()})`;
            };
            if (allowed) {
              await insert();
              accepted++;
            } else
              await expect(insert()).rejects.toMatchObject({
                code: "23514",
                constraint_name: "runtime_attempt_native_owner",
              });
          }
    expect(accepted).toBe(6);
    expect(await client`SELECT id FROM runtime_attempt_owner_cases`).toHaveLength(6);
  } finally {
    await client.end({ timeout: 2 });
    await server.dispose();
  }
}, 60_000);

test("usage and policy commands remain immutable through the existing shared update routine", async () => {
  const server = await ownedPostgresServer();
  const client = postgres(server.identity.url, { max: 1 });
  const actor = crypto.randomUUID();
  const command = crypto.randomUUID();
  const operation = `owned:immutable:${command}`;
  try {
    const triggers = await client<{ name: string; routine: string }[]>`
      SELECT t.tgname AS name,p.proname AS routine
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid IN ('factory.execution_policy_command'::regclass,'factory.usage_entry'::regclass)
        AND NOT t.tgisinternal ORDER BY t.tgname`;
    expect([...triggers]).toEqual([
      { name: "execution_policy_command_immutable", routine: "reject_mutation" },
      { name: "guard_usage_entry", routine: "reject_mutation" },
    ]);
    expect([
      ...(await client`SELECT to_regprocedure('factory.guard_usage_entry()') AS duplicate`),
    ]).toEqual([{ duplicate: null }]);
    await client`INSERT INTO auth."user"(id,name,email)
      VALUES(${actor},'Owned immutable journal',${`${actor}@journal.test`})`;
    await client`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
      VALUES(${command},'factory',${actor},'{}','{}')`;
    await client`INSERT INTO factory.usage_operation(id,purpose,engine,provider,model)
      VALUES(${operation},'probe','mastra','owned','exact')`;
    await client`INSERT INTO factory.usage_entry
      (operation_id,event_id,source,outcome,counters,nano_usd,known_nano_usd,occurred_at)
      VALUES(${operation},'step:1','step','completed',
        '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"reasoning":0}',0,0,now())`;
    const retained =
      await client`SELECT to_jsonb(c) AS value FROM factory.execution_policy_command c
      WHERE command_id=${command}
      UNION ALL SELECT to_jsonb(e) FROM factory.usage_entry e WHERE operation_id=${operation}`;
    for (const update of [
      () =>
        client`UPDATE factory.execution_policy_command SET result='{"changed":true}' WHERE command_id=${command}`,
      () =>
        client`UPDATE factory.execution_policy_command SET result=result WHERE command_id=${command}`,
      () => client`UPDATE factory.usage_entry SET nano_usd=1 WHERE operation_id=${operation}`,
      () =>
        client`UPDATE factory.usage_entry SET nano_usd=nano_usd WHERE operation_id=${operation}`,
    ])
      await expect(Promise.resolve().then(update)).rejects.toThrow("immutable");
    expect(
      await client`SELECT to_jsonb(c) AS value FROM factory.execution_policy_command c
        WHERE command_id=${command}
        UNION ALL SELECT to_jsonb(e) FROM factory.usage_entry e WHERE operation_id=${operation}`,
    ).toEqual(retained);
    await client`UPDATE factory.usage_operation SET settled_at=now(),outcome='completed' WHERE id=${operation}`;
    await expect(
      Promise.resolve().then(
        () => client`UPDATE factory.usage_operation SET outcome='failed' WHERE id=${operation}`,
      ),
    ).rejects.toThrow("immutable");
  } finally {
    await client.end({ timeout: 2 });
    await server.dispose();
  }
}, 60_000);

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

test("reserved connection queries retain the owning connection and manual rollback/commit", async () => {
  const server = await ownedPostgresServer();
  const client = postgres(server.identity.url, { max: 1 });
  drizzleTransaction(client);
  const reserved = await client.reserve();
  const id = crypto.randomUUID();
  const db = drizzleTransaction(reserved);
  try {
    const [original] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    if (!original) throw new Error("Owned reserved PostgreSQL connection is missing");
    await reserved`BEGIN`;
    await db.insert(schema.authUser).values({ id, name: "Reserved", email: `${id}@reserved.test` });
    const [observed] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    expect(observed?.pid).toBe(original.pid);
    expect(await db.select({ name: schema.authUser.name }).from(schema.authUser)).toEqual([
      { name: "Reserved" },
    ]);
    await reserved`ROLLBACK`;
    expect(await db.select({ id: schema.authUser.id }).from(schema.authUser)).toHaveLength(0);
    await reserved`BEGIN`;
    await db
      .insert(schema.authUser)
      .values({ id, name: "Committed", email: `${id}@reserved.test` });
    await reserved`COMMIT`;
    expect([...(await reserved`SELECT name FROM auth."user" WHERE id=${id}`)]).toEqual([
      { name: "Committed" },
    ]);
  } finally {
    await reserved`ROLLBACK`.catch(() => {});
    reserved.release();
    await client.end({ timeout: 2 });
    await server.dispose();
  }
});

test("a fresh coordination pool retains native JSON objects in its first typed transaction", async () => {
  const server = await ownedPostgresServer();
  const original = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = server.identity.url;
  const database = createDatabase(1);
  if (original === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = original;
  const connection = database.coordination();
  const id = crypto.randomUUID();
  const policy = { ...defaultExecutionPolicy(), codingUSD: 2, values: ["α", "second"] };
  try {
    await connection.begin(async (transaction) => {
      const db = drizzleTransaction(transaction);
      await db
        .insert(schema.authUser)
        .values({ id, name: "Coordination", email: `${id}@test.invalid` });
      await db.insert(schema.executionPolicy).values({
        scope: "factory",
        version: 1,
        policy,
        timezone: "UTC",
        updatedBy: id,
      });
      const [native] = await transaction<{ kind: string; policy: unknown }[]>`
        SELECT jsonb_typeof(policy) AS kind,policy FROM factory.execution_policy`;
      expect(native).toEqual({ kind: "object", policy });
      const [typed] = await db
        .select({ policy: schema.executionPolicy.policy })
        .from(schema.executionPolicy);
      expect(typed?.policy).toEqual(policy);
    });
  } finally {
    await connection.end({ timeout: 2 });
    await database.client.end({ timeout: 2 });
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
    const modeledColumns: string[] = [];
    const modeledForeignKeys: string[] = [];
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const config = getTableConfig(table);
      modeledColumns.push(
        ...config.columns.map((column) => `${config.schema}.${config.name}.${column.name}`),
      );
      for (const key of config.foreignKeys) {
        const reference = key.reference();
        const target = getTableConfig(reference.foreignTable);
        modeledForeignKeys.push(
          `${config.schema}.${config.name}.${key.getName()}:${reference.columns
            .map((column) => column.name)
            .join(",")}=>${target.schema}.${target.name}:${reference.foreignColumns
            .map((column) => column.name)
            .join(",")}`,
        );
      }
      await sql.unsafe(
        `SELECT ${config.columns.map((column) => `"${column.name}"`).join(",")} FROM "${config.schema}"."${config.name}" LIMIT 0`,
      );
    }
    const catalogColumns = await sql<{ schema: string; table: string; name: string }[]>`
      SELECT n.nspname AS schema,c.relname AS "table",a.attname AS name
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('auth','factory') AND c.relkind='r'
        AND a.attnum>0 AND NOT a.attisdropped`;
    expect(modeledColumns.sort()).toEqual(
      catalogColumns.map((column) => `${column.schema}.${column.table}.${column.name}`).sort(),
    );
    const catalogForeignKeys = await sql<
      {
        schema: string;
        table: string;
        name: string;
        columns: string[];
        targetSchema: string;
        targetTable: string;
        targetColumns: string[];
      }[]
    >`
      SELECT n.nspname AS schema,t.relname AS "table",c.conname AS name,
        ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(id,ordinal)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.id ORDER BY k.ordinal) AS columns,
        rn.nspname AS "targetSchema",rt.relname AS "targetTable",
        ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(id,ordinal)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.id ORDER BY k.ordinal) AS "targetColumns"
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_class rt ON rt.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=rt.relnamespace
      WHERE n.nspname IN ('auth','factory') AND c.contype='f'`;
    expect(modeledForeignKeys.sort()).toEqual(
      catalogForeignKeys
        .map(
          (key) =>
            `${key.schema}.${key.table}.${key.name}:${key.columns.join(",")}=>${key.targetSchema}.${key.targetTable}:${key.targetColumns.join(",")}`,
        )
        .sort(),
    );
    expect(await sql`SELECT singleton FROM factory.installation_maintenance`).toHaveLength(1);
    expect(
      await sql`SELECT table_name FROM information_schema.columns
      WHERE table_schema='factory' AND table_name IN ('runtime_attempt','development_workspace')
      AND column_name='substrate'`,
    ).toHaveLength(0);
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
