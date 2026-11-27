import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { defaultExecutionPolicy } from "#conversation-domain/execution-policy";
import { createDatabase, drizzleTransaction } from "#db/client";
import { baselineDigest, readMigration, shippedMigrations } from "#db/migrations";
import * as schema from "#db/schema";
import { desktopBackgroundKeys } from "#interface-domain/background";
import { runtimeIdentity } from "#runtime-domain/identity";
import { createUIPreferenceController } from "../../apps/factory/src/preferences/controller";
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
        .insert(schema.operation)
        .values({
          id: crypto.randomUUID(),
          kind: "user.ui_preference",
          scopeType: "user",
          scopeId: userID,
          idempotencyKey: `user.ui_preference:${userID}`,
          state: "saved",
          payload: { userId: userID, desktopBackgroundKey: key },
        })
        .onConflictDoUpdate({
          target: schema.operation.idempotencyKey,
          set: { payload: { userId: userID, desktopBackgroundKey: key }, updatedAt: new Date() },
        });
      expect(await preferences.get(userID)).toEqual({ desktopBackgroundKey: key });
    }
    const projectID = crypto.randomUUID();
    await database.db.insert(schema.project).values({
      id: projectID,
      slug: `artwork-${projectID.slice(0, 8)}`,
      name: "Owned artwork project",
      repositoryUrl: "https://example.invalid/artwork.git",
      defaultBranch: "main",
      actorTemplatePath: ".factory/actor-template.json",
      createdBy: userID,
    });
    for (const invalid of ["custom-theme", "https://example.invalid/artwork.jpg"])
      await expect(
        Promise.resolve().then(
          () => database.client`UPDATE factory.project
            SET desktop_background_key=${invalid} WHERE id=${projectID}`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "project_desktop_background_key_check",
      });
  } finally {
    await database.client.end({ timeout: 2 });
    await server.dispose();
  }
}, 60_000);

test("Runtime Attempt ownership keeps all thirty-two surviving NULL/value combinations equivalent", async () => {
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
    expect([
      ...(await client`SELECT enumlabel AS kind FROM pg_enum
        WHERE enumtypid='factory.isolated_runtime_kind'::regtype ORDER BY enumsortorder`),
    ]).toEqual([{ kind: "staging" }, { kind: "verification" }, { kind: "publication" }]);
    await expect(client`SELECT 'prebuild'::factory.isolated_runtime_kind`).rejects.toMatchObject({
      code: "22P02",
    });
    for (const workspace of [null, crypto.randomUUID()])
      for (const change of [null, crypto.randomUUID()])
        for (const kind of [null, "verification", "staging", "publication"])
          for (const verification of [null, crypto.randomUUID()]) {
            const [previous] = await client<{ allowed: boolean }[]>`
              WITH shape AS (SELECT ${workspace}::uuid AS workspace_id,${change}::uuid AS change_id,
                ${kind}::factory.isolated_runtime_kind AS isolated_kind,${verification}::uuid AS verification_id)
              SELECT (
                (((workspace_id IS NOT NULL AND isolated_kind IS NULL AND verification_id IS NULL)
                  OR (workspace_id IS NULL AND change_id IS NULL AND isolated_kind='verification'
                    AND verification_id IS NOT NULL)
                  OR (workspace_id IS NULL AND change_id IS NULL
                    AND isolated_kind IN ('staging','publication') AND verification_id IS NULL))
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
                  state,parent_connector_token_hash,create_intended_at,created_by)
                VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${workspace},${change},${kind},
                  ${verification},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},
                  now(),${crypto.randomUUID()})`;
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
    expect(accepted).toBe(5);
    expect(await client`SELECT id FROM runtime_attempt_owner_cases`).toHaveLength(5);
  } finally {
    await client.end({ timeout: 2 });
    await server.dispose();
  }
}, 60_000);

for (const kind of ["staging", "publication", "verification"] as const)
  test(`native ${kind} keeps exact authority, binding dispatch and environment protections without producers`, async () => {
    const server = await ownedPostgresServer();
    const client = postgres(server.identity.url, { max: 1 });
    const actorID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const revision = "a".repeat(40);
    const ownerID =
      kind === "staging"
        ? runtimeIdentity(`staging:${projectID}`, 1).attemptID
        : crypto.randomUUID();
    const attemptID = runtimeIdentity(ownerID, 1).attemptID;
    const environment = kind === "staging" ? "main-preview" : "development";
    const secretKey = `owned/${projectID}/${environment}`;
    const frozenEnvironment = {
      environment,
      version: kind === "publication" ? 0 : 7,
      secretKey: kind === "publication" ? null : secretKey,
    };
    const intent = {
      configuration: { projectID, database: "factory" },
      repository: "https://example.invalid/baseline.git",
      actorTemplatePath: ".factory/actor-template.json",
      createdBy: actorID,
      revision,
      environment: frozenEnvironment,
      templateSHA256: "d".repeat(64),
      ...(kind === "staging" ? { declaration: { apps: [] } } : {}),
      ...(kind !== "staging"
        ? { jobHandle: "owned_exact_job", runnerUUID: crypto.randomUUID() }
        : {}),
      ...(kind === "publication" ? { version: "1.0.0" } : {}),
    };
    const space = { metadata: { uid: crypto.randomUUID() } };
    const template = { metadata: { uid: crypto.randomUUID(), version: "1" } };
    const binding = {
      projectID,
      generation: 1,
      atespaceUID: space.metadata.uid,
      templateUID: template.metadata.uid,
      templateVersion: template.metadata.version,
      templateSHA256: intent.templateSHA256,
      environment: frozenEnvironment,
      ...(kind === "verification"
        ? { verificationID: ownerID }
        : { isolatedID: ownerID, isolatedKind: kind }),
    };
    try {
      await client.begin(async (tx) => {
        const reject = async (
          probe: (savepoint: postgres.TransactionSql) => Promise<unknown>,
          message: string,
        ) => {
          await expect(tx.savepoint(probe)).rejects.toThrow(message);
        };
        await tx`INSERT INTO auth."user"(id,name,email)
          VALUES(${actorID},'Owned schema authority',${`${actorID}@baseline.test`})`;
        await tx`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
          VALUES(${projectID},${`baseline-${projectID}`},'Owned schema authority',
            ${intent.repository},'main',${intent.actorTemplatePath},${actorID})`;
        await tx`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
          VALUES(${projectID},${actorID},'developer',${actorID})`;
        // Logical grants only: the fixture never reads secrets or creates native resources.
        const manifest = {
          variables: [{ name: "PRIVATE_VALUE", runtime: true, verification: false }],
        };
        await tx`INSERT INTO factory.operation
          (id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by,completed_at)
          VALUES(${crypto.randomUUID()},'environments.write','project_environment',${`${projectID}:${environment}`},${`environments.write:${secretKey}`},'committed',
            ${tx.json({ projectID, environment, baseVersion: 6, fingerprint: "e".repeat(64), manifest, secretKey })},${actorID},now())`;
        await tx`INSERT INTO factory.operation
          (id,kind,scope_type,scope_id,idempotency_key,state,payload)
          VALUES(${crypto.randomUUID()},'environments.environment','project',${projectID},${`environments.environment:${projectID}:${environment}`},'saved',
            ${tx.json({ projectId: projectID, environment, version: 7, manifest, secretKey })})`;
        if (kind === "staging") {
          await tx`INSERT INTO factory.operation
            (id,kind,scope_type,scope_id,idempotency_key,state,payload)
            VALUES(${crypto.randomUUID()},'delivery.staging_preview','project',${projectID},${`delivery.staging_preview:${projectID}`},'pending',
              ${tx.json({ projectId: projectID, revision, runtimeAttemptId: null })})`;
        } else if (kind === "publication") {
          const releaseID = crypto.randomUUID();
          const attemptCommandID = crypto.randomUUID();
          await tx`INSERT INTO factory.project_release
            (id,project_id,command_id,version,commit_sha,notes,state,created_by)
            VALUES(${releaseID},${projectID},${crypto.randomUUID()},'1.0.0',${revision},'','running',${actorID})`;
          await tx`INSERT INTO factory.operation
            (id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload)
            VALUES(${ownerID},'releases.attempt','project_release',${releaseID},
              ${`releases.attempt:${attemptCommandID}`},${`releases.attempt.ordinal:${releaseID}:1`},'running',
              ${tx.json({
                id: ownerID,
                releaseId: releaseID,
                commandId: attemptCommandID,
                ordinal: 1,
                dispatchIntendedAt: new Date().toISOString(),
                runId: 1,
                runnerId: null,
                runnerUuid: intent.runnerUUID ?? null,
                runnerToken: "owned-token",
                jobHandle: intent.jobHandle ?? null,
                runtimeAttemptId: null,
                cleanedAt: null,
              })})`;
        } else {
          const ticketID = crypto.randomUUID();
          const changeID = crypto.randomUUID();
          const requirementID = crypto.randomUUID();
          const approvalID = crypto.randomUUID();
          const content = '{"summary":"Owned schema Verification"}';
          await tx`INSERT INTO factory.ticket(id,project_id,title,created_by)
            VALUES(${ticketID},${projectID},'Owned schema Verification',${actorID})`;
          await tx`INSERT INTO factory.requirement_revision
            (id,ticket_id,ordinal,canonical_content,content_digest,created_by)
            VALUES(${requirementID},${ticketID},1,${content},
              ${createHash("sha256").update(content).digest("hex")},${actorID})`;
          await tx`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
            VALUES(${approvalID},${ticketID},${requirementID},${actorID})`;
          await tx`INSERT INTO factory.change
            (id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
            VALUES(${changeID},${projectID},${ticketID},${approvalID},
              ${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`},${revision},'active',${actorID})`;
          await tx`INSERT INTO factory.verification
            (id,change_id,commit_sha,pull_request_number,action_run_id,runner_uuid,runner_token,runner_job_handle,created_by)
            VALUES(${ownerID},${changeID},${revision},1,1,
              ${intent.runnerUUID ?? null},'owned-token',${intent.jobHandle ?? null},${actorID})`;
        }
        const provision = async (
          connection: postgres.TransactionSql,
          proposed: object = intent,
          id = attemptID,
        ) => {
          await connection`INSERT INTO factory.substrate_provision
            (owner_id,kind,project_id,generation,runtime_attempt_id,intent)
            VALUES(${ownerID},${kind},${kind === "verification" ? null : projectID},1,${id},${connection.json(proposed)})`;
        };
        const authorityError =
          kind === "verification" ? "fresh exact-job intent" : "fresh product intent";
        await reject((s) => provision(s, intent, crypto.randomUUID()), authorityError);
        await reject(
          (s) =>
            provision(
              s,
              kind === "staging"
                ? { ...intent, revision: "f".repeat(40) }
                : { ...intent, jobHandle: "wrong_job" },
            ),
          kind === "staging"
            ? "pinned Preview"
            : kind === "publication"
              ? "exact active job"
              : "fresh exact-job intent",
        );
        if (kind !== "verification")
          await reject(
            (s) =>
              provision(s, {
                ...intent,
                environment: { ...frozenEnvironment, secretKey: "wrong-key" },
              }),
            kind === "staging" ? "frozen main-preview environment" : "empty Project environment",
          );
        await provision(tx);
        const attempt = async (connection: postgres.TransactionSql) => {
          await connection`INSERT INTO factory.runtime_attempt
            (id,project_id,generation,revision,state,isolated_kind,verification_id,
              parent_connector_token_hash,create_intended_at,created_by)
            VALUES(${attemptID},${projectID},1,${revision},'create-intended',${kind},
              ${kind === "verification" ? ownerID : null},${"b".repeat(64)},now(),${actorID})`;
        };
        await attempt(tx);
        const bind = async (connection: postgres.TransactionSql, proposed: object = binding) => {
          await connection`UPDATE factory.runtime_attempt
            SET atespace=${`fa-${attemptID.replaceAll("-", "")}`},
              actor_name=${`runtime-${attemptID.replaceAll("-", "")}`},
              binding_intent=${connection.json(proposed)}
            WHERE id=${attemptID}`;
        };
        // A producer-shaped intent is not a surviving owner's native grant.
        await reject(
          (s) => bind(s, { preparationID: ownerID, environment: frozenEnvironment }),
          "deterministic active Attempt intent",
        );
        await reject((s) => bind(s), "deterministic active Attempt intent");
        const now = new Date().toISOString();
        await tx`UPDATE factory.substrate_provision
          SET resources=${tx.json({
            atespace: { attemptedAt: now, value: space },
            policy: { attemptedAt: now, value: {} },
            template: { attemptedAt: now, value: template },
          })}
          WHERE runtime_attempt_id=${attemptID}`;
        for (const drift of [
          { projectID: crypto.randomUUID() },
          { generation: 2 },
          { templateUID: crypto.randomUUID() },
          { templateSHA256: "f".repeat(64) },
          ...(kind === "verification"
            ? [{ verificationID: crypto.randomUUID() }]
            : [
                { isolatedID: crypto.randomUUID() },
                { isolatedKind: "verification" },
                { environment: { ...frozenEnvironment, secretKey: "wrong-key" } },
              ]),
        ])
          await reject(
            (s) => bind(s, { ...binding, ...drift }),
            "deterministic active Attempt intent",
          );
        if (kind !== "verification")
          await reject(async (s) => {
            await s`UPDATE factory.substrate_provision
              SET resources=jsonb_set(resources, ARRAY['template'], (resources->'template') || '{"rejected":true}'::jsonb)
              WHERE runtime_attempt_id=${attemptID}`;
            await bind(s);
          }, "deterministic active Attempt intent");
        await bind(tx);
        await tx`SET CONSTRAINTS ALL IMMEDIATE`;
        const freeze = async (
          connection: postgres.TransactionSql,
          proposed = frozenEnvironment,
        ) => {
          await connection`INSERT INTO factory.operation
            (id,kind,scope_type,scope_id,idempotency_key,state,payload)
            VALUES(${crypto.randomUUID()},'runtime.environment_intent','runtime_attempt',${attemptID},
              ${`runtime.environment_intent:${attemptID}`},'recorded',${connection.json(proposed)})`;
        };
        await freeze(tx);
        for (const assignment of [
          "intent='{}'",
          "resources=jsonb_set(resources, '{atespace,attemptedAt}', 'null'::jsonb)",
          "resources=jsonb_set(resources, '{policy,attemptedAt}', 'null'::jsonb)",
          "resources=jsonb_set(resources, '{template,attemptedAt}', 'null'::jsonb)",
          "resources=jsonb_set(resources, '{atespace,value}', '{}'::jsonb)",
          "resources=jsonb_set(resources, '{policy,value}', 'null'::jsonb)",
          "resources=jsonb_set(resources, '{template,value}', '{}'::jsonb)",
        ])
          await reject(async (s) => {
            await s.unsafe(
              `UPDATE factory.substrate_provision SET ${assignment} WHERE runtime_attempt_id=$1`,
              [attemptID],
            );
          }, "immutable");
        await reject(async (s) => {
          await s`DELETE FROM factory.substrate_provision WHERE runtime_attempt_id=${attemptID}`;
        }, "names cannot be reused");
        await tx`UPDATE factory.runtime_attempt SET create_attempted_at=now(),actor_uid=${crypto.randomUUID()}
          WHERE id=${attemptID}`;
        for (const assignment of [
          "binding_intent='{}'",
          "create_attempted_at=NULL",
          "actor_uid=NULL",
        ])
          await reject(async (s) => {
            await s.unsafe(`UPDATE factory.runtime_attempt SET ${assignment} WHERE id=$1`, [
              attemptID,
            ]);
          }, "identity and dispatch facts are immutable");
        await reject(async (s) => {
          await s`UPDATE factory.runtime_attempt SET revision=${"f".repeat(40)} WHERE id=${attemptID}`;
        }, "Runtime Attempt identity");
        await tx`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${attemptID}`;
      });
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
      WHERE t.tgrelid IN ('factory.audit_event'::regclass,'factory.usage_entry'::regclass)
        AND NOT t.tgisinternal ORDER BY t.tgname`;
    expect([...triggers]).toEqual([
      { name: "audit_event_immutable", routine: "reject_mutation" },
      { name: "feedback_attachments", routine: "bind_authored_attachments" },
      { name: "guard_usage_entry", routine: "reject_mutation" },
      { name: "read_version", routine: "invalidate_factory_reads" },
    ]);
    expect([
      ...(await client`SELECT to_regprocedure('factory.guard_usage_entry()') AS duplicate`),
    ]).toEqual([{ duplicate: null }]);
    await client`INSERT INTO auth."user"(id,name,email)
      VALUES(${actor},'Owned immutable journal',${`${actor}@journal.test`})`;
    await client`INSERT INTO factory.audit_event(id,kind,scope_type,scope_id,dedupe_key,actor_id,payload)
      VALUES(${command},'usage.policy_command','execution_policy','factory',${`usage.policy_command:${command}`},${actor},
        ${client.json({ commandId: command, scope: "factory", actorId: actor, input: {}, result: {} })})`;
    await client`INSERT INTO factory.usage_operation(id,purpose,engine,provider,model)
      VALUES(${operation},'probe','mastra','owned','exact')`;
    await client`INSERT INTO factory.usage_entry
      (operation_id,event_id,source,outcome,counters,nano_usd,known_nano_usd,occurred_at)
      VALUES(${operation},'step:1','step','completed',
        '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"reasoning":0}',0,0,now())`;
    const retained = await client`SELECT to_jsonb(c) AS value FROM factory.audit_event c
      WHERE id=${command}
      UNION ALL SELECT to_jsonb(e) FROM factory.usage_entry e WHERE operation_id=${operation}`;
    for (const update of [
      () =>
        client`UPDATE factory.audit_event SET payload='{"changed":true}'::jsonb WHERE id=${command}`,
      () => client`UPDATE factory.audit_event SET payload=payload WHERE id=${command}`,
      () => client`UPDATE factory.usage_entry SET nano_usd=1 WHERE operation_id=${operation}`,
      () =>
        client`UPDATE factory.usage_entry SET nano_usd=nano_usd WHERE operation_id=${operation}`,
    ])
      await expect(Promise.resolve().then(update)).rejects.toThrow("immutable");
    expect(
      await client`SELECT to_jsonb(c) AS value FROM factory.audit_event c
        WHERE id=${command}
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
    expect(
      await sql`SELECT id FROM factory.operation WHERE kind='installation.maintenance' AND idempotency_key='installation.maintenance:singleton'`,
    ).toHaveLength(1);
    expect(
      await sql`SELECT table_name FROM information_schema.columns
      WHERE table_schema='factory' AND table_name IN ('runtime_attempt','development_workspace')
      AND column_name='substrate'`,
    ).toHaveLength(0);
    expect(
      await sql`SELECT id FROM factory.operation WHERE kind='attachment.storage' AND idempotency_key='attachment.storage:singleton'`,
    ).toHaveLength(1);
    for (const table of [
      "factorybox_worker",
      "factorybox_worker_admission",
      "factorybox_runtime",
      "factorybox_lifecycle_operation",
      "execution_slot",
      "workspace_source",
      "runtime_artifact_intent",
      "verification_compute_placement",
      "project_image_preparation",
      "substrate_prebuild",
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
        /factorybox|execution_slot|workspace_source|runtime_artifact_intent|verification_compute_placement|protect_execution_template_initial_health|protect_substrate_source_preservation|project_image_preparation|substrate_prebuild|image_build_is_public|\bprebuild\b/i.test(
          definition,
        ),
      ),
    ).toHaveLength(0);

    await sql.begin(async (tx) => {
      await tx`INSERT INTO auth."user"(id,name,email)
        VALUES(${actorID},'Owned native baseline',${`${actorID}@baseline.test`})`;
      await tx`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`baseline-${projectID}`},'Owned native baseline',
          'https://example.invalid/baseline.git','main','.factory/actor-template.json',${actorID})`;
      for (const task of [
        "configuration",
        "development-secrets",
        "preview-secrets",
        "protection",
        "hook",
        "wiki",
        "main-preview",
      ])
        await tx`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by)
          VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${projectID},${`projects.setup_readiness:${projectID}:${task}`},'pending',${tx.json({ task, commandId: crypto.randomUUID() })},${actorID})`;
      await tx`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
        VALUES(${workspaceID},${projectID},'personal',${actorID},'main',${"a".repeat(40)},${actorID})`;
      await tx`INSERT INTO factory.substrate_provision(owner_id,kind,intent) VALUES(${workspaceID},'workspace','{}')`;
      await tx`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
        parent_connector_token_hash,create_intended_at,created_by,
        atespace,actor_name,binding_intent,actor_uid,create_attempted_at)
        VALUES(${attemptID},${projectID},${workspaceID},1,${"a".repeat(40)},'create-intended',
          ${"b".repeat(64)},now(),${actorID},
          ${`fa-${attemptID.replaceAll("-", "")}`},${`runtime-${attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
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
      UNION ALL SELECT 'readiness',to_jsonb(r) FROM factory.operation r WHERE r.kind='projects.setup_readiness'
      UNION ALL SELECT 'workspace',to_jsonb(w) FROM factory.development_workspace w
      UNION ALL SELECT 'provision',to_jsonb(p) FROM factory.substrate_provision p
      UNION ALL SELECT 'attempt',to_jsonb(a) FROM factory.runtime_attempt a
      UNION ALL SELECT 'source',to_jsonb(s) FROM factory.substrate_source s
      UNION ALL SELECT 'requirement',to_jsonb(r) FROM factory.requirement_revision r
      UNION ALL SELECT 'approval',to_jsonb(a) FROM factory.requirement_approval a
      UNION ALL SELECT 'attachment-storage',to_jsonb(s) FROM factory.operation s WHERE s.kind='attachment.storage' AND s.idempotency_key='attachment.storage:singleton'
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
