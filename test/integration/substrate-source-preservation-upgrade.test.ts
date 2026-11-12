import { expect, test } from "bun:test";
import postgres from "postgres";
import { readMigration, shippedMigrations } from "../../packages/db/src/migrations";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

test("v25 to v26 retains the exact frozen Source, account, Workspace, Actor binding and native Attempt", async () => {
  const server = await ownedPostgresServer();
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID(), false, "template0");
  const sql = postgres(target.url, { max: 1 });
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    workspaceID = crypto.randomUUID(),
    actorUID = crypto.randomUUID();
  const attemptID = runtimeIdentity(workspaceID, 1).attemptID,
    checkpointID = crypto.randomUUID();
  try {
    const files = await shippedMigrations();
    for (const file of files.filter((file) => file.version <= 25))
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
      await tx`UPDATE factory.substrate_source SET writable=false,writer_epoch=2,checkpoint_id=${checkpointID} WHERE workspace_id=${workspaceID}`;
    });
    const retained = () => sql`SELECT 'account' AS kind,to_jsonb(a) AS value FROM auth."user" a
      UNION ALL SELECT 'project',to_jsonb(p) FROM factory.project p
      UNION ALL SELECT 'workspace',to_jsonb(w) FROM factory.development_workspace w
      UNION ALL SELECT 'attempt',to_jsonb(a) FROM factory.runtime_attempt a
      UNION ALL SELECT 'binding',to_jsonb(b) FROM factory.substrate_binding b
      UNION ALL SELECT 'source',to_jsonb(s)-'preservation' FROM factory.substrate_source s ORDER BY kind`;
    const before = await retained();
    const migration = files.find((file) => file.version === 26);
    if (!migration) throw Error("Preservation migration is missing");
    await sql.unsafe(await readMigration(migration));
    expect(await retained()).toEqual(before);
    expect(
      Array.from(
        await sql`SELECT preservation,generation::float8 AS generation,writable,checkpoint FROM factory.substrate_source WHERE workspace_id=${workspaceID}`,
      ),
    ).toEqual([{ preservation: null, generation: 0, writable: false, checkpoint: null }]);
    await expect(
      Promise.resolve(
        sql`UPDATE factory.substrate_source SET preservation='{}' WHERE workspace_id=${workspaceID}`,
      ),
    ).rejects.toThrow("exact frozen failed initial personal owner");
    expect(
      (await sql`SELECT max(version) AS version FROM factory.schema_migration`)[0]?.["version"],
    ).toBe(26);
  } finally {
    await sql.end();
    await target.dispose();
    await server.dispose();
  }
}, 60_000);
