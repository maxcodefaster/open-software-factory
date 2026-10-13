import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import type { AgentTurnTransaction } from "../../apps/factory/src/agent/turn-store";
import { createDatabase } from "../../packages/db/src/client";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

type Owned = Awaited<ReturnType<typeof fixture>>;

test.each(["before Session", "retained Session"] as const)(
  "Stop during startup %s blocks late prompt dispatch and commit",
  async (boundary) => {
    const process = await factoryProcess();
    const database = process.connect();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let owned: Owned | undefined;
    let controller: ReturnType<Owned["controller"]> | undefined;
    try {
      owned = await fixture(undefined, undefined, database);
      const target = owned;
      await database.client`UPDATE factory.runtime_attempt SET state = 'starting' WHERE id = ${target.attemptID}`;
      if (boundary === "before Session")
        await database.client`DELETE FROM factory.change_agent_session WHERE change_id = ${target.changeID}`;
      controller = target.controller(async () => {
        entered.resolve();
        await release.promise;
        await database.client`UPDATE factory.runtime_attempt SET state = 'ready' WHERE id = ${target.attemptID}`;
        return null;
      });
      const commandID = crypto.randomUUID();
      await controller.start(target.changeID, target.userID, commandID);
      await entered.promise;
      await controller.stop(target.changeID);
      expect((await target.turn(commandID))?.state).toBe("stopped");
      release.resolve();
      await controller.shutdown();
      expect(target.requests()).toBe(0);
      expect(target.commitCalls).toEqual([]);
      if (boundary === "retained Session") {
        expect((await pendingStop(target)).pending).toBe(true);
        const stop = createChangeAgentStop(database, target.hub);
        await eventually(
          () => stop.confirm(target.changeID),
          Boolean,
          "Startup Stop did not settle",
        );
      }
      const resumed = await createChangeAdmission(database, buildModelID).admit(
        target.changeID,
        target.userID,
        boundary === "before Session"
          ? { kind: "change-start", commandId: crypto.randomUUID() }
          : {
              kind: "change-prompt",
              commandId: crypto.randomUUID(),
              text: "Explicit resume after startup Stop",
            },
      );
      expect(resumed.turn.state).toBe("pending");
    } finally {
      release.resolve();
      await controller?.shutdown();
      await database.client.end({ timeout: 0 });
      await process.dispose();
    }
  },
  30_000,
);

function admit(owned: Owned, text: string) {
  return createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, owned.userID, {
    kind: "change-prompt",
    commandId: crypto.randomUUID(),
    text,
  });
}

test("a missing Session cannot release a stopped input already assigned to OpenCode", async () => {
  const isolated = await factoryProcess();
  const database = isolated.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`DELETE FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    const admission = createChangeAdmission(database, buildModelID);
    const original = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    await database.client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID}
      WHERE turn_id=${original.turn.id}`;
    await createChangeAgentStop(database, owned.hub).persist(owned.changeID);
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "The previous Agent writer has not been safely released",
    });
    expect((await owned.turn(original.turn.commandId))?.state).toBe("stopped");
    expect(owned.requests()).toBe(0);
  } finally {
    await database.client.end();
    await isolated.dispose();
  }
});

async function pendingStop(owned: Owned) {
  const rows = await owned.database.client<
    Array<{ id: string; turnID: string | null; pending: boolean; dispatched: boolean }>
  >`SELECT stop_id AS id, stop_turn_id AS "turnID", stop_pending AS pending, stop_dispatched AS dispatched
    FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
  if (!rows[0]) throw new Error("Owned Session required");
  return rows[0];
}

function afterPublication(owned: Owned, after: () => Promise<void>) {
  let transactions = 0;
  return {
    ...owned.database,
    client: new Proxy(owned.database.client, {
      get(target, property, receiver) {
        if (property === "begin") {
          return async (callback: (sql: AgentTurnTransaction) => Promise<unknown>) => {
            const result = await target.begin(callback);
            if (++transactions === 1) await after();
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
}

test("a held Stop cannot interrupt newer work admitted into the same Session", async () => {
  const owned = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const request = owned.hub.request.bind(owned.hub);
  let interruptsNewerWork = false;
  let hold = true;
  owned.hub.request = async (attempt, channel, input, path) => {
    if (hold && new URL(input.url).pathname.endsWith("/interrupt")) {
      entered.resolve();
      await release.promise;
      interruptsNewerWork = owned.requests() > 0;
    }
    return request(attempt, channel, input, path);
  };
  let stopped: Promise<unknown> | undefined;
  try {
    stopped = owned.controller().stop(owned.changeID);
    await entered.promise;
    const commandID = crypto.randomUUID();
    await expect(
      owned.controller().prompt(owned.changeID, "New work after Stop", owned.userID, commandID),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Stop is recorded. Wait for runtime confirmation before resuming Build.",
    });
    expect(await owned.turn(commandID)).toBeUndefined();
    release.resolve();
    await stopped;
    expect(interruptsNewerWork).toBe(false);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
    expect((await pendingStop(owned)).pending).toBe(false);
    expect((await admit(owned, "Resume after confirmed Stop")).turn.state).toBe("pending");
  } finally {
    hold = false;
    release.resolve();
    await stopped?.catch(() => undefined);
    owned.release();
    await owned.dispose();
  }
});

test("Stop confirmation works with a single database connection", async () => {
  const owned = await fixture();
  const database = createDatabase(1);
  let confirming: Promise<unknown> | undefined;
  try {
    const stop = createChangeAgentStop(database, owned.hub);
    await stop.persist(owned.changeID);
    confirming = stop.confirm(owned.changeID);
    expect(await Promise.race([confirming, Bun.sleep(500).then(() => "hung")])).toBe(true);
    expect(owned.interrupts()).toBe(1);
  } finally {
    await database.client.end({ timeout: 0 });
    await confirming?.catch(() => undefined);
    await owned.dispose();
  }
});

test("a delayed Stop persistence phase cannot stop newly admitted work", async () => {
  const owned = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = await admit(owned, "Stop this original turn");
  const delayed = afterPublication(owned, async () => {
    entered.resolve();
    await release.promise;
  });
  const stopping = createChangeAgentStop(delayed, owned.hub).persist(owned.changeID);
  try {
    await entered.promise;
    expect((await pendingStop(owned)).turnID).toBe(original.turn.id);
    await owned.controller().stop(owned.changeID);
    const commandID = crypto.randomUUID();
    await createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: commandID,
      text: "Keep this later turn",
    });
    release.resolve();
    await stopping;
    expect((await owned.turn(commandID))?.state).toBe("pending");
    expect(owned.interrupts()).toBe(1);
  } finally {
    release.resolve();
    await stopping.catch(() => undefined);
    await owned.dispose();
  }
});

test("concurrent Stop confirmations coalesce and preserve the pending Stop identity", async () => {
  const owned = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const request = owned.hub.request.bind(owned.hub);
  let interrupts = 0;
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname.endsWith("/interrupt")) {
      interrupts += 1;
      entered.resolve();
      await release.promise;
    }
    return request(attempt, channel, input, path);
  };
  let confirming: Promise<boolean> | undefined;
  try {
    await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
    const original = await pendingStop(owned);
    confirming = createChangeAgentStop(owned.database, owned.hub).confirm(owned.changeID);
    await entered.promise;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createChangeAgentStop(owned.database, owned.hub).confirm(owned.changeID),
      ),
    );
    expect(results).toEqual(Array.from({ length: 8 }, () => false));
    expect(await pendingStop(owned)).toMatchObject({
      id: original.id,
      dispatched: true,
      pending: true,
    });
    expect(interrupts).toBe(1);
    release.resolve();
    expect(await confirming).toBe(true);
    expect((await pendingStop(owned)).pending).toBe(false);
  } finally {
    release.resolve();
    await confirming?.catch(() => undefined);
    await owned.dispose();
  }
});

test("unknown interrupt outcome blocks admission and is not automatically replayed", async () => {
  const owned = await fixture();
  const request = owned.hub.request.bind(owned.hub);
  let interrupts = 0;
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname.endsWith("/interrupt")) {
      interrupts += 1;
      throw new Error("Owned response loss after external acceptance");
    }
    return request(attempt, channel, input, path);
  };
  try {
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    await expect(stop.confirm(owned.changeID)).rejects.toThrow("Transport");
    expect(await pendingStop(owned)).toMatchObject({ dispatched: true, pending: true });
    await expect(admit(owned, "Do not resume an uncertain Stop")).rejects.toMatchObject({
      code: "conflict",
    });
    for (let index = 0; index < 3; index += 1) {
      expect(await createChangeAgentStop(owned.database, owned.hub).confirm(owned.changeID)).toBe(
        false,
      );
    }
    expect(interrupts).toBe(1);
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state = 'stopped' WHERE id = ${owned.attemptID}`;
    expect(await stop.confirm(owned.changeID)).toBe(true);
    expect((await pendingStop(owned)).pending).toBe(false);
    expect(interrupts).toBe(1);
  } finally {
    await owned.dispose();
  }
});

test("a late acknowledgement cannot clear a newer Stop identity", async () => {
  const owned = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const request = owned.hub.request.bind(owned.hub);
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname.endsWith("/interrupt")) {
      entered.resolve();
      await release.promise;
    }
    return request(attempt, channel, input, path);
  };
  let confirming: Promise<boolean> | undefined;
  try {
    const first = createChangeAgentStop(owned.database, owned.hub);
    await first.persist(owned.changeID);
    const original = await pendingStop(owned);
    confirming = first.confirm(owned.changeID);
    await entered.promise;
    // Destruction of the exact Runtime independently confirms the first Stop.
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state = 'stopped' WHERE id = ${owned.attemptID}`;
    expect(await createChangeAgentStop(owned.database, owned.hub).confirm(owned.changeID)).toBe(
      true,
    );
    const next = await admit(owned, "This new turn has its own Stop");
    await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
    const current = await pendingStop(owned);
    expect(current.id).not.toBe(original.id);
    expect(current.turnID).toBe(next.turn.id);
    release.resolve();
    expect(await confirming).toBe(false);
    expect(await pendingStop(owned)).toMatchObject({ id: current.id, pending: true });
  } finally {
    release.resolve();
    await confirming?.catch(() => undefined);
    await owned.dispose();
  }
});

test("recovery settles the exact Stop target after publication but before settlement", async () => {
  const owned = await fixture();
  const original = await admit(owned, "Crash before stopping this turn");
  const crashed = afterPublication(owned, async () => {
    throw new Error("Owned crash after Stop publication");
  });
  try {
    await expect(createChangeAgentStop(crashed, owned.hub).persist(owned.changeID)).rejects.toThrow(
      "Owned crash",
    );
    expect((await owned.turn(original.turn.commandId))?.state).toBe("pending");
    expect(await pendingStop(owned)).toMatchObject({ turnID: original.turn.id, pending: true });
    expect(await createChangeAgentStop(owned.database, owned.hub).confirm(owned.changeID)).toBe(
      true,
    );
    expect((await owned.turn(original.turn.commandId))?.state).toBe("stopped");
    expect((await admit(owned, "Resume after recovered Stop")).turn.state).toBe("pending");
    expect(owned.interrupts()).toBe(1);
  } finally {
    await owned.dispose();
  }
});

test("Stop publication does not hold Change while waiting for a locked Turn", async () => {
  const owned = await fixture();
  const original = await admit(owned, "Hold this Turn lock");
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const turnLock = owned.database.client.begin(async (sql) => {
    await sql`SELECT id FROM factory.agent_turn WHERE id = ${original.turn.id} FOR UPDATE`;
    locked.resolve();
    await release.promise;
    // Execution takes this lock second. A Stop waiting on Turn must release it.
    await sql`SELECT id FROM factory.change WHERE id = ${owned.changeID} FOR UPDATE`;
  });
  let stopping: Promise<void> | undefined;
  try {
    await locked.promise;
    const database = afterPublication(owned, async () => published.resolve());
    stopping = createChangeAgentStop(database, owned.hub).persist(owned.changeID);
    await published.promise;
    expect((await pendingStop(owned)).pending).toBe(true);
    await expect(admit(owned, "No admission while original Turn is locked")).rejects.toMatchObject({
      code: "conflict",
    });
    release.resolve();
    await turnLock;
    await stopping;
    expect((await owned.turn(original.turn.commandId))?.state).toBe("stopped");
    expect(await createChangeAgentStop(owned.database, owned.hub).confirm(owned.changeID)).toBe(
      true,
    );
  } finally {
    release.resolve();
    await turnLock.catch(() => undefined);
    await stopping?.catch(() => undefined);
    await owned.dispose();
  }
});

test.each(["queue-unobserved", "staged-revert", "cancel-loss", "stopped-runtime"] as const)(
  "Stop keeps admission blocked when queued cancellation is unproved: %s",
  async (failure) => {
    const owned = await fixture();
    const admitted = await admit(owned, "Assigned queued input must not wake");
    const request = owned.hub.request.bind(owned.hub);
    let reverts = 0;
    let cancellations = 0;
    owned.hub.request = async (...args) => {
      const path = new URL(args[2].url).pathname;
      if (path.endsWith("/inbox")) {
        if (failure === "queue-unobserved") throw new Error("Owned queue unavailable");
        if (failure === "staged-revert") return Response.json({ data: [] });
        return Response.json({
          data: [{ id: `msg_factory_${admitted.turn.id.replaceAll("-", "")}` }],
        });
      }
      if (failure === "staged-revert" && path.endsWith(`/${owned.sessionID}`)) {
        const response = await request(...args);
        const session = (await response.json()) as { data: Record<string, unknown> };
        return Response.json({
          data: { ...session.data, revert: { messageID: "owned-human-draft", files: [] } },
        });
      }
      if (path.includes("/revert/")) reverts += 1;
      if (path.includes("/inbox/") && args[2].method === "DELETE") {
        cancellations += 1;
        if (failure === "cancel-loss") throw new Error("Owned cancellation response loss");
      }
      return request(...args);
    };
    try {
      await owned.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${admitted.turn.id}`;
      if (failure === "stopped-runtime")
        await owned.database.client`UPDATE factory.runtime_attempt
        SET state = 'stopped' WHERE id = ${owned.attemptID}`;
      const stop = createChangeAgentStop(owned.database, owned.hub);
      await stop.persist(owned.changeID);
      if (failure === "cancel-loss" || failure === "queue-unobserved")
        await expect(stop.confirm(owned.changeID)).rejects.toThrow("Transport");
      else expect(await stop.confirm(owned.changeID)).toBe(false);
      expect((await owned.turn(admitted.turn.commandId))?.state).toBe("stopped");
      expect((await pendingStop(owned)).pending).toBe(true);
      await expect(admit(owned, "Cannot wake unproved stopped queue")).rejects.toMatchObject({
        code: "conflict",
      });
      expect(await stop.confirm(owned.changeID)).toBe(false);
      expect(reverts).toBe(0);
      expect(cancellations).toBe(failure === "cancel-loss" ? 1 : 0);
      expect(owned.interrupts()).toBe(failure === "stopped-runtime" ? 0 : 1);
      expect(owned.requests()).toBe(0);
    } finally {
      await owned.dispose();
    }
  },
);
