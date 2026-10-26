import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createIdleCompute, executionIdleMS } from "../../apps/factory/src/runtime/idle";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("idle compute records Pause before execution and leaves Workspace source/approval intact", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  let idle: ReturnType<typeof createIdleCompute> | undefined;
  try {
    const owned = await fixture(undefined, undefined, database);
    let stops = 0;
    idle = createIdleCompute(
      database,
      { claimIdle: () => true, releaseIdle: () => {} },
      {
        async pause(attemptID) {
          expect(attemptID).toBe(owned.attemptID);
          const [intent] = await database.client<Array<{ state: string; stopped: boolean }>>`
          SELECT state,stop_intended_at IS NOT NULL AS stopped FROM factory.runtime_attempt WHERE id=${attemptID}`;
          expect(intent).toEqual({ state: "pausing", stopped: false });
          stops++;
        },
      },
      1,
    );
    await Promise.all([idle.sweep(), idle.sweep()]);
    expect(stops).toBe(1);
    expect(
      await database.client`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`,
    ).toHaveLength(1);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${owned.ticketID}`,
    ).toHaveLength(1);
    expect(executionIdleMS({})).toBe(5 * 60_000);
    expect(executionIdleMS({ FACTORY_EXECUTION_IDLE_MINUTES: "0" })).toBe(0);
    expect(() => executionIdleMS({ FACTORY_EXECUTION_IDLE_MINUTES: "1441" })).toThrow("0–1440");
    // Keep the oldest 64 candidates busy. A bounded sweep must eventually reach the idle tail.
    const tail = crypto.randomUUID();
    await database.client`WITH users AS (
      INSERT INTO auth."user"(id,name,email,email_verified)
      SELECT gen_random_uuid(),'fairness-' || n,${owned.projectID} || '-' || n || '@fairness.test',true
      FROM generate_series(1,65) n RETURNING id,name
    ), workspaces AS (
      INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      SELECT gen_random_uuid(),${owned.projectID},'personal',users.id,'main',${"a".repeat(40)},${owned.userID} FROM users
      RETURNING id,owner_user_id,kubernetes_namespace
    ) INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,
      create_intended_at,created_by,updated_at)
      SELECT CASE WHEN users.name='fairness-65' THEN ${tail}::uuid ELSE gen_random_uuid() END,
        ${owned.projectID},workspaces.id,1,${"a".repeat(40)},'ready',${"b".repeat(64)},${"c".repeat(64)},now(),${owned.userID},
        CASE WHEN users.name='fairness-65' THEN now() ELSE now()-interval '1 minute' END
      FROM workspaces JOIN users ON users.id=workspaces.owner_user_id`;
    await idle.close();
    const checked = new Set<string>();
    idle = createIdleCompute(
      database,
      {
        claimIdle(id) {
          checked.add(id);
          return id === tail;
        },
        releaseIdle() {},
      },
      {
        async pause(id) {
          expect(id).toBe(tail);
        },
      },
      1,
    );
    await idle.sweep();
    await idle.sweep();
    expect(checked.has(tail)).toBe(true);
    expect(checked.size).toBe(65);
  } finally {
    await idle?.close();
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 60_000);

test("idle Pause waits for Build admission and retains pending, working and uncertain work", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let idle: ReturnType<typeof createIdleCompute> | undefined;
  let admission: Promise<unknown> | undefined;
  try {
    const owned = await fixture(undefined, undefined, database);
    let claims = 0;
    idle = createIdleCompute(
      database,
      {
        claimIdle() {
          claims++;
          return true;
        },
        releaseIdle() {},
      },
      {
        async pause() {
          throw new Error("Active work must not stop");
        },
      },
      1,
    );
    await database.client`UPDATE factory.change_agent_session SET state='working' WHERE change_id=${owned.changeID}`;
    await idle.sweep();
    expect(claims).toBe(0);
    await database.client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${owned.changeID}`;
    const commandId = crypto.randomUUID();
    admission = database.client.begin(async (sql) => {
      await createChangeAdmission(database, buildModelID).admitIn(
        sql,
        owned.changeID,
        owned.userID,
        {
          kind: "change-prompt",
          commandId,
          text: "Owned retained background implementation",
        },
      );
      admitted.resolve();
      await release.promise;
    });
    await admitted.promise;
    const sweep = idle.sweep();
    await Bun.sleep(50);
    expect(claims).toBe(0);
    release.resolve();
    await admission;
    await sweep;
    expect(claims).toBe(0);
    await database.client`UPDATE factory.agent_turn SET state='dispatching',owner_token=${crypto.randomUUID()},owner_expires_at=now()+interval '1 minute' WHERE command_id=${commandId}`;
    await database.client`UPDATE factory.agent_turn SET state='uncertain',owner_token=NULL,owner_expires_at=NULL WHERE command_id=${commandId}`;
    await idle.sweep();
    expect(claims).toBe(0);
    const [attempt] = await database.client<
      Array<{ state: string }>
    >`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    expect(attempt?.state).toBe("ready");
  } finally {
    release.resolve();
    await admission?.catch(() => undefined);
    await idle?.close();
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);

test("failed idle intent rolls back and releases its ephemeral dispatch gate", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  let idle: ReturnType<typeof createIdleCompute> | undefined;
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client.unsafe(
      "CREATE FUNCTION factory.owned_idle_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned idle intent failure'; END $$; CREATE TRIGGER owned_idle_failure BEFORE UPDATE OF state ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.owned_idle_failure()",
    );
    let released = 0;
    idle = createIdleCompute(
      database,
      {
        claimIdle: () => true,
        releaseIdle: () => {
          released++;
        },
      },
      {
        async pause() {
          throw new Error("Uncommitted intent cannot stop compute");
        },
      },
      1,
    );
    await expect(idle.sweep()).rejects.toThrow("Owned idle intent failure");
    expect(released).toBe(1);
    const [attempt] = await database.client<Array<{ state: string; stopped: boolean }>>`
      SELECT state,stop_intended_at IS NOT NULL AS stopped FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    expect(attempt).toEqual({ state: "ready", stopped: false });
  } finally {
    await idle?.close();
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);
