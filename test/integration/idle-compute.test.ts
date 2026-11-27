import { expect, test } from "bun:test";
import { runtimeIdentity } from "#runtime-domain/identity";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import {
  createIdleCompute,
  executionIdleMS,
  executionQuietMS,
  executionReviewMS,
} from "../../apps/factory/src/runtime/idle";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("idle compute records Pause before execution and leaves Workspace source/approval intact", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  let idle: ReturnType<typeof createIdleCompute> | undefined;
  try {
    const owned = await fixture(undefined, undefined, database);
    let pauses = 0;
    idle = createIdleCompute(
      database,
      { claimIdle: () => true, releaseIdle: () => {} },
      {
        async pause(attemptID) {
          expect(attemptID).toBe(owned.attemptID);
          const [intent] = await database.client<Array<{ state: string; stopped: boolean }>>`
          SELECT state,stop_intended_at IS NOT NULL AS stopped FROM factory.runtime_attempt WHERE id=${attemptID}`;
          expect(intent).toEqual({ state: "pausing", stopped: false });
          pauses++;
        },
      },
      1,
      1,
      0,
    );
    await Promise.all([idle.sweep(), idle.sweep()]);
    expect(pauses).toBe(1);
    expect(
      await database.client`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`,
    ).toHaveLength(1);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${owned.ticketID}`,
    ).toHaveLength(1);
    expect(executionIdleMS({})).toBe(15 * 60_000);
    expect(executionQuietMS({})).toBe(2 * 60_000);
    expect(executionQuietMS({ FACTORY_EXECUTION_IDLE_MINUTES: "1" })).toBe(60_000);
    expect(executionReviewMS({})).toBe(30 * 60_000);
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
      RETURNING id,owner_user_id
    ), prepared AS (
      SELECT CASE WHEN users.name='fairness-65' THEN ${tail}::uuid ELSE gen_random_uuid() END AS id,
        workspaces.id AS workspace_id,
        CASE WHEN users.name='fairness-65' THEN now() ELSE now()-interval '1 minute' END AS updated_at
      FROM workspaces JOIN users ON users.id=workspaces.owner_user_id
    )
    INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,
      create_intended_at,created_by,updated_at,atespace,actor_name,binding_intent)
      SELECT id,${owned.projectID},workspace_id,1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},now(),${owned.userID},
        updated_at,'fa-' || replace(id::text,'-',''),'runtime-' || replace(id::text,'-',''),'{}'::jsonb
      FROM prepared`;
    await database.client`UPDATE factory.runtime_attempt SET state='ready'
      WHERE project_id=${owned.projectID} AND id<>${owned.attemptID}`;
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
      1,
      0,
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
      1,
      0,
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
      1,
      0,
    );
    await expect(idle.sweep()).rejects.toMatchObject({
      cause: { message: "Owned idle intent failure" },
    });
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

test.each([
  "pending",
  "capacity-wait",
  "accounting-wait",
  "recent-verdict",
  "old-verdict",
] as const)(
  "idle review demand preserves active/recent Verification without starving capacity: %s",
  async (kind) => {
    const host = await factoryProcess();
    const database = host.connect();
    let idle: ReturnType<typeof createIdleCompute> | undefined;
    try {
      const owned = await fixture(undefined, undefined, database);
      const verificationID = crypto.randomUUID();
      const runnerUUID = crypto.randomUUID();
      const jobHandle = `owned-idle-${verificationID}`;
      const pending = ["pending", "capacity-wait", "accounting-wait"].includes(kind);
      await database.client`INSERT INTO factory.verification
        (id,change_id,commit_sha,pull_request_number,action_run_id,runner_uuid,runner_token,runner_job_handle,
          state,updated_at,completed_at,created_by)
        VALUES(${verificationID},${owned.changeID},${"a".repeat(40)},1,1,
          ${runnerUUID},'owned-runner-token',${jobHandle},
          ${pending ? "pending" : "failed"},
          CASE WHEN ${kind === "recent-verdict"} THEN now() ELSE now()-interval '2 hours' END,
          CASE WHEN ${pending} THEN NULL ELSE now() END,${owned.userID})`;
      if (kind === "capacity-wait" || kind === "accounting-wait") {
        const attemptID = runtimeIdentity(verificationID, 1).attemptID;
        const atespaceUID = crypto.randomUUID();
        const templateUID = crypto.randomUUID();
        await database.client.begin(async (sql) => {
          await sql`INSERT INTO factory.substrate_provision(owner_id,kind,runtime_attempt_id,generation,intent,resources)
            VALUES(${verificationID},'verification',${attemptID},1,jsonb_build_object(
              'configuration',jsonb_build_object('projectID',${owned.projectID}::text,'database',current_database()),
              'revision',${"a".repeat(40)}::text,'runnerUUID',${runnerUUID}::text,'jobHandle',${jobHandle}::text,
              'templateSHA256',${"d".repeat(64)}::text),
              jsonb_build_object(
                'atespace',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify({ metadata: { uid: atespaceUID } })}::text::jsonb),
                'policy',jsonb_build_object('attemptedAt',to_jsonb(now()),'value','{}'::jsonb),
                'template',jsonb_build_object('attemptedAt',to_jsonb(now()),'value',${JSON.stringify({ metadata: { uid: templateUID, version: "1" } })}::text::jsonb)))`;
          await sql`INSERT INTO factory.runtime_attempt(
            id,project_id,generation,revision,state,parent_connector_token_hash,
            create_intended_at,created_by,isolated_kind,verification_id,atespace,actor_name,binding_intent)
            VALUES(${attemptID},${owned.projectID},1,${"a".repeat(40)},'create-intended',
              ${"b".repeat(64)},now(),${owned.userID},'verification',${verificationID},
              ${`fa-${attemptID.replaceAll("-", "")}`},${`runtime-${attemptID.replaceAll("-", "")}`},
              ${JSON.stringify({
                projectID: owned.projectID,
                generation: 1,
                verificationID,
                atespaceUID,
                templateUID,
                templateVersion: "1",
                templateSHA256: "d".repeat(64),
              })}::jsonb)`;
          await sql`UPDATE factory.verification SET runtime_attempt_id=${attemptID} WHERE id=${verificationID}`;
          await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${attemptID}`;
          await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
            VALUES(${crypto.randomUUID()},'runtime.compute_wait','runtime_attempt',${attemptID},
              ${`runtime.compute_wait:${attemptID}`},'waiting',
              ${JSON.stringify({ reason: kind === "capacity-wait" ? "compute-capacity" : "accounting-incomplete" })}::jsonb)`;
        });
      }
      let claims = 0;
      let pauses = 0;
      let canClaim = true;
      idle = createIdleCompute(
        database,
        {
          claimIdle: () => {
            claims++;
            return canClaim;
          },
          releaseIdle: () => {},
        },
        {
          pause: async (id) => {
            expect(id).toBe(owned.attemptID);
            const [intent] = await database.client`SELECT state,stop_intended_at
              FROM factory.runtime_attempt WHERE id=${id}`;
            expect(intent).toEqual({ state: "pausing", stop_intended_at: null });
            pauses++;
          },
        },
        1,
        1,
        60_000,
      );
      if (kind === "capacity-wait") {
        await database.client`UPDATE factory.change_agent_session SET state='working' WHERE change_id=${owned.changeID}`;
        await idle.sweep();
        expect(claims).toBe(0);
        await database.client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${owned.changeID}`;
        canClaim = false;
        await idle.sweep();
        expect(claims).toBe(1);
        expect(pauses).toBe(0);
        canClaim = true;
        claims = 0;
      }
      await idle.sweep();
      const pausesWhenIdle = kind === "old-verdict" || kind === "capacity-wait";
      expect(claims).toBe(pausesWhenIdle ? 1 : 0);
      expect(pauses).toBe(pausesWhenIdle ? 1 : 0);
    } finally {
      await idle?.close();
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  15_000,
);
