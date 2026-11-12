import { expect, test } from "bun:test";
import postgres from "postgres";
import { readMigration, shippedMigrations } from "../../packages/db/src/migrations";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

test("v26 to v27 retains accounts, native Workspace, private Source ownership, Actor and preparation inputs without starting work", async () => {
  const server = await ownedPostgresServer();
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID(), false, "template0");
  const sql = postgres(target.url, { max: 1 });
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    workspaceID = crypto.randomUUID(),
    actorUID = crypto.randomUUID();
  const attemptID = runtimeIdentity(workspaceID, 1).attemptID;
  try {
    const files = await shippedMigrations();
    for (const file of files.filter((file) => file.version <= 26))
      await sql.unsafe(await readMigration(file));
    await sql.begin(async (tx) => {
      await tx`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userID},'Owned retained account',${`${userID}@factory.local`},true)`;
      await tx`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`retained-${projectID}`},'Owned retained Project','https://example.invalid/fixture.git','main','.devcontainer/devcontainer.json',${userID})`;
      await tx`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${userID},'developer',${userID})`;
      await tx`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by,substrate,factorybox_worker_id) VALUES(${workspaceID},${projectID},'personal',${userID},'main',${"a".repeat(40)},${userID},true,NULL)`;
      await tx`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${workspaceID},'{}')`;
      await tx`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id) VALUES(${attemptID},${projectID},${workspaceID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${userID},true,NULL,NULL)`;
      await tx`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at) VALUES(${attemptID},${`fa-${attemptID.replaceAll("-", "")}`},${`runtime-${attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
      await tx`UPDATE factory.runtime_attempt SET state='pausing',failure='Retained failed initial bootstrap' WHERE id=${attemptID}`;
      await tx`INSERT INTO factory.substrate_source(workspace_id,actor_uid) VALUES(${workspaceID},${actorUID})`;
      await tx`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version) VALUES(${crypto.randomUUID()},${projectID},'development',${"a".repeat(40)},0)`;
    });
    const retained = () => sql`SELECT 'account' AS kind,to_jsonb(a) AS value FROM auth."user" a
      UNION ALL SELECT 'project',to_jsonb(p) FROM factory.project p
      UNION ALL SELECT 'workspace',to_jsonb(w) FROM factory.development_workspace w
      UNION ALL SELECT 'attempt',to_jsonb(a) FROM factory.runtime_attempt a
      UNION ALL SELECT 'binding',to_jsonb(b) FROM factory.substrate_binding b
      UNION ALL SELECT 'source',to_jsonb(s) FROM factory.substrate_source s
      UNION ALL SELECT 'preparation',to_jsonb(p) FROM factory.project_image_preparation p ORDER BY kind`;
    const before = await retained();
    const migration = files.find((file) => file.version === 27);
    if (!migration) throw new Error("Native prebuild migration is missing");
    await sql.unsafe(await readMigration(migration));
    expect(await retained()).toEqual(before);
    expect(await sql`SELECT * FROM factory.substrate_prebuild`).toHaveLength(0);
    expect(
      (await sql`SELECT max(version) AS version FROM factory.schema_migration`)[0]?.["version"],
    ).toBe(27);
    await sql`UPDATE factory.runtime_attempt SET failure='Original native owner still observes state' WHERE id=${attemptID}`;
    await expect(
      sql.begin(async (tx) => {
        const id = crypto.randomUUID();
        await tx`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id)
        VALUES(${id},${projectID},'prebuild',1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${userID},true,NULL,NULL)`;
        await tx`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent) VALUES(${id},${`fa-${id.replaceAll("-", "")}`},${`runtime-${id.replaceAll("-", "")}`},'{}')`;
      }),
    ).rejects.toThrow("deterministic active Attempt intent");
  } finally {
    await sql.end();
    await target.dispose();
    await server.dispose();
  }
}, 60_000);
