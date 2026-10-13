import { expect, test } from "bun:test";
import { createIdleCompute, executionIdleMS } from "../../apps/factory/src/runtime/idle";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { fixture, buildModelID } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("idle compute records Stop before execution and leaves Workspace source/approval intact", async () => {
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
        async stop(attemptID) {
          expect(attemptID).toBe(owned.attemptID);
          const [intent] = await database.client<Array<{ state: string; stopped: boolean }>>`
          SELECT state,stop_intended_at IS NOT NULL AS stopped FROM factory.runtime_attempt WHERE id=${attemptID}`;
          expect(intent).toEqual({ state: "stop-intended", stopped: true });
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
    expect(executionIdleMS({})).toBe(30 * 60_000);
    expect(executionIdleMS({ FACTORY_EXECUTION_IDLE_MINUTES: "0" })).toBe(0);
    expect(() => executionIdleMS({ FACTORY_EXECUTION_IDLE_MINUTES: "1441" })).toThrow("0–1440");
  } finally {
    await idle?.close();
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);

test("idle Stop waits for Build admission and retains pending, working and uncertain work", async () => {
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
        async stop() {
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
        async stop() {
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
