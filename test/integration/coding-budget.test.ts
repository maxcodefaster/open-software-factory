import { expect, test } from "bun:test";
import { defaultExecutionPolicy } from "#conversation-domain/execution-policy";
import { runtimeModelToken } from "#runtime-domain/identity";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createModelRelay } from "../../apps/factory/src/models/relay";
import { createUsageJournal } from "../../apps/factory/src/usage/journal";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test.each(["retained session", "before session"] as const)(
  "failed capacity admission exposes failure instead of automatic wait without erasing the refusal: %s",
  async (phase) => {
    const owned = await fixture();
    const controller = owned.controller();
    try {
      if (phase === "before session")
        await owned.database
          .client`DELETE FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
      const accepted = await createChangeAdmission(owned.database, "owned-model").admit(
        owned.changeID,
        owned.userID,
        phase === "before session"
          ? { kind: "change-start", commandId: crypto.randomUUID() }
          : {
              kind: "change-prompt",
              commandId: crypto.randomUUID(),
              text: "Wait for owned capacity",
            },
      );
      await owned.database.client`UPDATE factory.runtime_attempt SET state='starting'
      WHERE id=${owned.attemptID}`;
      await owned.database
        .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'runtime.compute_wait','runtime_attempt',${owned.attemptID},
        ${`runtime.compute_wait:${owned.attemptID}`},'waiting',${JSON.stringify({ reason: "compute-capacity" })}::jsonb)`;
      const before = await owned.database.client`
        SELECT * FROM factory.operation
        WHERE kind='runtime.compute_wait' AND scope_type='runtime_attempt' AND scope_id=${owned.attemptID}`;
      expect((await controller.get(owned.changeID, undefined, false, false)).computeWait).toBe(
        "compute-capacity",
      );
      const store = createAgentTurnStore(owned.database);
      const leased = await store.claimPending(accepted.turn.id);
      if (!leased?.ownerToken) throw Error("Owned capacity turn lease missing");
      expect(
        await store.failPending(leased.id, leased.ownerToken, "Owned capacity admission failed"),
      ).toBe(true);
      const failed = await controller.get(owned.changeID, undefined, false, false);
      expect(failed.state).toBe("failed");
      expect(failed.computeWait).toBeNull();
      expect(
        await owned.database.client`
          SELECT * FROM factory.operation
          WHERE kind='runtime.compute_wait' AND scope_type='runtime_attempt' AND scope_id=${owned.attemptID}`,
      ).toEqual(before);
      expect((await store.get(leased.id))?.state).toBe("failed");
      expect(owned.requests()).toBe(0);
    } finally {
      await controller.shutdown();
      await owned.dispose();
    }
  },
  60_000,
);

test("commissioned Coding finishes its in-flight call, blocks subsequent inference and explicitly resumes exact pending input", async () => {
  const isolated = await factoryProcess(),
    database = isolated.connect();
  const journal = createUsageJournal(database),
    store = createAgentTurnStore(database);
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      calls++;
      await gate.promise;
      return Response.json({ ok: true });
    },
  });
  try {
    const owned = await fixture(undefined, undefined, database),
      admission = createChangeAdmission(database, "owned-model");
    const rateOverride = {
      provider: "openai",
      model: "owned-model",
      source: "contract",
      fetchedAt: new Date().toISOString(),
      tiers: [{ above: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
    };
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,payload)
      VALUES(${crypto.randomUUID()},'usage.rate_override','model','openai:owned-model',
        ${`usage.rate_override:${encodeURIComponent("openai")}:${encodeURIComponent("owned-model")}`},NULL,'active',${owned.userID},
        ${JSON.stringify({ provider: "openai", model: "owned-model", version: 1, rate: rateOverride, updatedBy: owned.userID })}::jsonb)`;
    const accepted = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Exact retained work",
    });
    const actor = await store.claimPending(accepted.turn.id);
    if (!actor?.ownerToken) throw new Error("Missing turn lease");
    await owned.writers.prepareAgent(owned.changeID, actor.id);
    const policy = { ...defaultExecutionPolicy(), codingUSD: 1 };
    await database.client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by) VALUES('factory',1,${JSON.stringify(policy)}::jsonb,'UTC',${owned.userID})`;
    await journal.begin({
      id: `turn:${actor.id}`,
      projectID: owned.projectID,
      userID: owned.userID,
      purpose: "coding",
      engine: "opencode",
      provider: "owned",
      model: "owned-model",
      rate: {
        provider: "owned",
        model: "owned-model",
        source: "contract",
        fetchedAt: new Date().toISOString(),
        tiers: [{ above: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
      },
    });
    expect(await store.beginDispatch(actor.id, actor.ownerToken)).not.toBeNull();
    await database.client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${actor.id}`;
    await database.client`UPDATE factory.change_agent_session SET active_turn_id=${actor.id},state='working' WHERE change_id=${owned.changeID}`;
    const relay = createModelRelay(database, "owned-relay-secret", {
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      apiKey: "owned-provider",
    });
    const request = () =>
      relay(
        new Request("http://factory.local/inference", {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtimeModelToken("owned-relay-secret", owned.attemptID, 1)}`,
          },
          body: JSON.stringify({
            model: "owned-model",
            input: [],
            reasoning: { effort: "medium" },
          }),
        }),
        owned.attemptID,
        "responses",
      );
    const inFlight = request();
    await eventually(
      async () => calls,
      (count) => count === 1,
      "Model call not admitted",
    );
    await journal.record(`turn:${actor.id}`, {
      eventID: "step:1",
      source: "step",
      outcome: "completed",
      counters: { input: 1100000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      occurredAt: new Date().toISOString(),
    });
    expect((await request()).status).toBe(403);
    expect(calls).toBe(1);
    gate.resolve();
    expect((await inFlight).status).toBe(200);
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify({ ...policy, codingUSD: 2 })}::jsonb WHERE scope='factory'`;
    expect((await request()).status).toBe(403);
    expect(calls).toBe(1);
    expect(
      (
        await database.client`SELECT payload->>'reason' AS reason FROM factory.operation WHERE kind='usage.coding_pause' AND scope_type='agent_turn' AND scope_id=${actor.id}`
      )[0]?.["reason"],
    ).toBe("finish-reserve-used");
    // A separately admitted pending turn waits without losing input or silently restarting.
    await store.settle(actor.id, actor.ownerToken, "failed", "Locally paused");
    await database.client`UPDATE factory.change_agent_session SET state='failed' WHERE change_id=${owned.changeID}`;
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Ordinary input must not resume paused work",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const next = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Keep this exact pending input",
      resume: true,
    });
    await owned.writers.prepareAgent(owned.changeID, next.turn.id);
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify({ ...policy, codingUSD: 1 })}::jsonb WHERE scope='factory'`;
    const pending = await store.claimPending(next.turn.id);
    if (!pending?.ownerToken) throw new Error("Missing pending lease");
    expect(await store.beginDispatch(pending.id, pending.ownerToken)).toBeNull();
    expect((await store.get(pending.id))?.state).toBe("pending");
    expect(await store.claimPending(pending.id)).toBeNull();
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify({ ...policy, codingUSD: 2 })}::jsonb WHERE scope='factory'`;
    expect(await store.claimPending(pending.id)).toBeNull();
    await database.client.begin((sql) => store.resumePendingIn(sql, pending.id));
    const resumed = await store.claimPending(pending.id);
    expect(resumed?.command).toEqual(next.turn.command);
    if (!resumed?.ownerToken) throw new Error("Missing resumed lease");
    expect(await store.beginDispatch(resumed.id, resumed.ownerToken)).not.toBeNull();
    expect(calls).toBe(1);
  } finally {
    gate.resolve();
    await provider.stop(true);
    await database.client.end();
    await isolated.dispose();
  }
}, 60000);

test("controller resume preserves pending identity, replays one command and rejects removed authority", async () => {
  const isolated = await factoryProcess(),
    database = isolated.connect();
  let controller: ReturnType<Awaited<ReturnType<typeof fixture>>["controller"]> | undefined;
  try {
    const owned = await fixture(undefined, undefined, database);
    const admission = createChangeAdmission(database, "owned-model");
    const accepted = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Retain this exact input",
    });
    await owned.writers.prepareAgent(owned.changeID, accepted.turn.id);
    await database.client`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${owned.attemptID}`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'runtime.compute_wait','runtime_attempt',${owned.attemptID},
        ${`runtime.compute_wait:${owned.attemptID}`},'waiting',${JSON.stringify({ reason: "compute-capacity" })}::jsonb)`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'usage.coding_pause','agent_turn',${accepted.turn.id},${`usage.coding_pause:${accepted.turn.id}`},'paused',
        ${JSON.stringify({ turnId: accepted.turn.id, reason: "finish-reserve-used", resumedByTurnId: null })}::jsonb)`;
    await database.client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
      VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), codingUSD: 0 })}::jsonb,'UTC',${owned.userID})`;
    controller = owned.controller();
    const commandID = crypto.randomUUID();
    await expect(
      controller.resume(owned.changeID, owned.userID, commandID, accepted.turn.id),
    ).rejects.toMatchObject({ code: "conflict" });
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify(defaultExecutionPolicy())}::jsonb WHERE scope='factory'`;
    expect((await controller.get(owned.changeID)).codingPause?.turnID).toBe(accepted.turn.id);
    await Promise.all([
      controller.resume(owned.changeID, owned.userID, commandID, accepted.turn.id),
      controller.resume(owned.changeID, owned.userID, commandID, accepted.turn.id),
    ]);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE change_id=${owned.changeID}`,
    ).toHaveLength(1);
    expect((await createAgentTurnStore(database).get(accepted.turn.id))?.command).toEqual(
      accepted.turn.command,
    );
    expect(owned.requests()).toBe(0);
    await createAgentTurnStore(database).releasePending(
      accepted.turn.id,
      (await createAgentTurnStore(database).get(accepted.turn.id))?.ownerToken ?? "none",
    );
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    await expect(
      controller.resume(owned.changeID, owned.userID, commandID, accepted.turn.id),
    ).rejects.toMatchObject({ code: "not-found" });
  } finally {
    await controller?.shutdown();
    await database.client.end();
    await isolated.dispose();
  }
}, 60000);

test("automatic repair at an exhausted reserve retains one paused input for explicit resume", async () => {
  const isolated = await factoryProcess(),
    database = isolated.connect();
  try {
    const owned = await fixture(undefined, undefined, database),
      admission = createChangeAdmission(database, "owned-model");
    await database.client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
      VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), codingUSD: 0 })}::jsonb,'UTC',${owned.userID})`;
    const input = {
      kind: "change-repair" as const,
      commandId: crypto.randomUUID(),
      text: "Repair this exact failed Verification",
    };
    const work = await admission.admit(owned.changeID, owned.userID, input);
    expect(work.turn.state).toBe("pending");
    expect((await admission.admit(owned.changeID, owned.userID, input)).turn.id).toBe(work.turn.id);
    expect(await createAgentTurnStore(database).claimPending(work.turn.id)).toBeNull();
    expect(
      await database.client`SELECT payload->>'reason' AS reason FROM factory.operation WHERE kind='usage.coding_pause' AND scope_type='agent_turn' AND scope_id=${work.turn.id}`,
    ).toHaveLength(1);
  } finally {
    await database.client.end();
    await isolated.dispose();
  }
}, 60000);
