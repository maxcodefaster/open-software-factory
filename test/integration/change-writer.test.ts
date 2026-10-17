import { expect, test } from "bun:test";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import {
  claimAgentWriterIn,
  workspaceWriteAuthorityIn,
} from "../../apps/factory/src/access/change-writer";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";

test.each(["active", "failed"] as const)(
  "retrying an assigned startup failure on a %s Change fences its old Sandbox before granting a new Agent writer",
  async (changeState) => {
    const processFixture = await factoryProcess();
    const owned = await fixture(undefined, undefined, processFixture.connect());
    const turns = createAgentTurnStore(owned.database);
    const admission = createChangeAdmission(owned.database, "factory-coding-model");
    const grants: string[][] = [];
    const stops: string[] = [];
    let stopped = false;
    const options = {
      database: owned.database,
      agentUsername: "owned-control",
      stopDeadlineMs: 1,
      runtime: {
        stop: async (attemptID: string) => {
          stops.push(attemptID);
        },
        get: async () => ({ state: stopped ? "stopped" : "stopping" }),
      },
      stopAgent: async () => {},
      protect: async (_changeID: string, writers: readonly string[]) => {
        grants.push([...writers]);
      },
    };
    try {
      const first = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      });
      await createChangeWriterController(options).prepareAgent(owned.changeID, first.turn.id);
      const claimed = await turns.claimPending(first.turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned startup turn lease missing");
      await owned.database.client`UPDATE factory.change_agent_turn_intent
      SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${first.turn.id}`;
      expect(
        await turns.failPending(first.turn.id, claimed.ownerToken, "Owned Sandbox startup failed"),
      ).toBe(true);
      await owned.database.client`UPDATE factory.change_agent_session SET state='failed',
      active_turn_id=${first.turn.id},last_error='Owned Sandbox startup failed'
      WHERE change_id=${owned.changeID}`;
      if (changeState === "failed") {
        await owned.database.client`INSERT INTO factory.branch_create_operation(id,change_id,
        repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
        SELECT ${crypto.randomUUID()},id,'owned','retry',branch_name,base_sha,${crypto.randomUUID()},
          'succeeded',base_sha,now() FROM factory.change WHERE id=${owned.changeID}`;
        await owned.database
          .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${owned.attemptID}`;
        await owned.database
          .client`UPDATE factory.change SET state='failed' WHERE id=${owned.changeID}`;
      }
      const retry = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      });
      const controller = createChangeWriterController(options);
      await expect(controller.prepareAgent(owned.changeID, retry.turn.id)).rejects.toThrow(
        "compute has stopped",
      );
      expect(stops).toEqual([owned.attemptID]);
      expect(grants.at(-1)).toEqual([]);
      expect((await turns.get(first.turn.id))?.state).toBe("failed");
      expect((await turns.get(retry.turn.id))?.state).toBe("pending");
      expect((await controller.view(owned.changeID, owned.userID)).state).toBe("agent-preparing");
      stopped = true;
      await createChangeWriterController(options).prepareAgent(owned.changeID, retry.turn.id);
      expect(grants.at(-1)).toEqual(["owned-control"]);
      expect(stops.every((id) => id === owned.attemptID)).toBe(true);
      expect((await controller.view(owned.changeID, owned.userID)).state).toBe("agent");
    } finally {
      await owned.dispose();
      await processFixture.dispose();
    }
  },
  30_000,
);

test("an uncertain predecessor cannot be replaced even when its Session reports failure", async () => {
  const processFixture = await factoryProcess();
  const owned = await fixture(undefined, undefined, processFixture.connect());
  const turns = createAgentTurnStore(owned.database);
  const admission = createChangeAdmission(owned.database, "factory-coding-model");
  try {
    const first = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    await owned.writers.prepareAgent(owned.changeID, first.turn.id);
    const claimed = await turns.claimPending(first.turn.id);
    if (!claimed?.ownerToken) throw new Error("Owned turn lease missing");
    expect(await turns.beginDispatch(first.turn.id, claimed.ownerToken)).not.toBeNull();
    expect(
      await turns.settle(first.turn.id, claimed.ownerToken, "uncertain", "Owned ambiguous outcome"),
    ).toBe(true);
    await owned.database.client`UPDATE factory.change_agent_session SET state='failed',
      active_turn_id=${first.turn.id} WHERE change_id=${owned.changeID}`;
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    expect((await turns.get(first.turn.id))?.state).toBe("uncertain");
    const [writer] = await owned.database.client`SELECT turn_id FROM factory.change_writer
      WHERE change_id=${owned.changeID}`;
    expect(writer?.["turn_id"]).toBe(first.turn.id);
  } finally {
    await owned.dispose();
    await processFixture.dispose();
  }
}, 30_000);

test("settled completion releases editing once and a stale completion cannot stop a newer Agent", async () => {
  const processFixture = await factoryProcess();
  const owned = await fixture(undefined, undefined, processFixture.connect());
  let stopping = 0;
  let failProtection = true;
  const options = {
    database: owned.database,
    agentUsername: "owned-control",
    runtime: {
      stop: async () => {
        stopping++;
      },
      get: async () => ({ state: "stopped" }),
    },
    stopAgent: async () => {
      throw new Error("Completed work needs no Agent Stop");
    },
    protect: async () => {
      if (failProtection) throw new Error("Owned protection response lost");
    },
  };
  try {
    const admission = createChangeAdmission(owned.database, "factory-coding-model");
    const turns = createAgentTurnStore(owned.database);
    const complete = async (id: string) => {
      const claimed = await turns.claimPending(id);
      if (!claimed?.ownerToken) throw new Error("Owned turn lease missing");
      expect(await turns.beginDispatch(id, claimed.ownerToken)).not.toBeNull();
      expect(await turns.markRunning(id, claimed.ownerToken, async () => {})).toBe(true);
      expect(await turns.settle(id, claimed.ownerToken, "completed", "Owned completed work")).toBe(
        true,
      );
    };
    const first = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "First work",
    });
    failProtection = false;
    const controller = createChangeWriterController(options);
    await controller.prepareAgent(owned.changeID, first.turn.id);
    const initialEpoch = String((await controller.view(owned.changeID, owned.userID)).epoch);
    await complete(first.turn.id);
    failProtection = true;
    await expect(controller.view(owned.changeID, owned.userID)).rejects.toThrow(
      "protection response lost",
    );
    const pending = await controller.view(owned.changeID, owned.userID);
    expect(pending.state).toBe("handoff");
    expect(pending.canWrite).toBe(false);
    expect(stopping).toBe(0);
    failProtection = false;
    const recovered = createChangeWriterController(options);
    expect(
      (await recovered.takeOver(owned.changeID, owned.userID, pending.commandID!)).canWrite,
    ).toBe(true);
    expect(stopping).toBe(1);
    const second = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Next work",
    });
    await recovered.prepareAgent(owned.changeID, second.turn.id);
    const stopsBeforeStale = stopping;
    expect(
      (await recovered.takeOver(owned.changeID, owned.userID, crypto.randomUUID(), initialEpoch))
        .state,
    ).toBe("agent");
    expect(stopping).toBe(stopsBeforeStale);
    await complete(second.turn.id);
    // A newer settled epoch must not recursively reacquire its own operation lock.
    const stale = recovered.takeOver(
      owned.changeID,
      owned.userID,
      crypto.randomUUID(),
      initialEpoch,
    );
    expect(
      (
        await Promise.race([
          stale,
          Bun.sleep(1_000).then(() => {
            throw new Error("Stale completion deadlocked");
          }),
        ])
      ).state,
    ).toBe("agent");
    expect((await recovered.view(owned.changeID, owned.userID)).canWrite).toBe(true);
    expect(stopping).toBe(stopsBeforeStale + 1);
  } finally {
    await owned.dispose();
    await processFixture.dispose();
  }
}, 30_000);

test("Ticket writer fences saves, requires settled Stop and compute teardown, and retains handoff across restart", async () => {
  const processFixture = await factoryProcess();
  const owned = await fixture(undefined, undefined, processFixture.connect());
  let stopped = false;
  let stopConfirmed = false;
  let stopping = 0;
  const branches: string[][] = [];
  const options = {
    database: owned.database,
    agentUsername: "owned-control",
    stopDeadlineMs: 1,
    runtime: {
      stop: async () => {
        stopping++;
      },
      get: async () => ({ state: stopped ? "stopped" : "stopping" }),
    },
    stopAgent: async () => {
      await owned.database
        .client`UPDATE factory.change_agent_session SET state='stopped',stop_pending=${!stopConfirmed} WHERE change_id=${owned.changeID}`;
    },
    protect: async (_changeID: string, writers: readonly string[]) => {
      branches.push([...writers]);
    },
  };
  let controller = createChangeWriterController(options);
  const commandID = crypto.randomUUID();
  try {
    const [workspace] = await owned.database.client<
      { id: string }[]
    >`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`;
    if (!workspace) throw new Error("Owned workspace missing");
    await expect(
      owned.database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspace.id, owned.userID),
      ),
    ).rejects.toThrow("observation-only");
    await owned.database
      .client`UPDATE factory.change_agent_session SET state='working' WHERE change_id=${owned.changeID}`;
    await expect(controller.takeOver(owned.changeID, owned.userID, commandID)).rejects.toThrow(
      "confirmed Agent Stop",
    );
    expect(stopping).toBe(0);
    expect(await controller.view(owned.changeID, owned.userID)).toMatchObject({
      state: "handoff",
      canWrite: false,
    });
    controller = createChangeWriterController(options);
    await expect(
      controller.takeOver(owned.changeID, owned.userID, crypto.randomUUID()),
    ).rejects.toThrow("already in progress");
    stopConfirmed = true;
    await expect(controller.takeOver(owned.changeID, owned.userID, commandID)).rejects.toThrow(
      "compute has stopped",
    );
    expect(stopping).toBe(1);
    stopped = true;
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    expect(await controller.view(owned.changeID, owned.userID)).toMatchObject({
      state: "human",
      canWrite: true,
    });
    await owned.database.client.begin((sql) =>
      workspaceWriteAuthorityIn(sql, workspace.id, owned.userID),
    );
    const turnID = crypto.randomUUID();
    await owned.database.client.begin((sql) => claimAgentWriterIn(sql, owned.changeID, turnID));
    await expect(
      owned.database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspace.id, owned.userID),
      ),
    ).rejects.toThrow("observation-only");
    stopped = false;
    await expect(controller.prepareAgent(owned.changeID, turnID)).rejects.toThrow(
      "compute has stopped",
    );
    expect(await controller.view(owned.changeID, owned.userID)).toMatchObject({
      state: "agent-preparing",
      canWrite: false,
    });
    stopped = true;
    await controller.prepareAgent(owned.changeID, turnID);
    expect(await controller.view(owned.changeID, owned.userID)).toMatchObject({
      state: "agent",
      canWrite: false,
    });
    expect(branches.at(-1)).toEqual(["owned-control"]);
  } finally {
    await owned.dispose();
    await processFixture.dispose();
  }
}, 30_000);

test("duplicate takeover commands cannot stop newly acquired compute, and Agent preparation waits for teardown", async () => {
  const processFixture = await factoryProcess();
  const owned = await fixture(undefined, undefined, processFixture.connect());
  let stopping = 0;
  let state = "ready";
  const stopEntered = Promise.withResolvers<void>();
  const releaseStop = Promise.withResolvers<void>();
  const sourceFences: string[] = [];
  const options = {
    database: owned.database,
    agentUsername: "owned-control",
    stopDeadlineMs: 1_000,
    runtime: {
      stop: async () => {
        stopping++;
        stopEntered.resolve();
        await releaseStop.promise;
        state = "stopped";
      },
      get: async () => ({ state }),
    },
    stopAgent: async () => {},
    protect: async () => {},
    fenceSource: async (_changeID: string, epoch: string) => {
      sourceFences.push(epoch);
    },
  };
  try {
    await owned.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${owned.changeID}`;
    const controller = createChangeWriterController(options);
    const commandID = crypto.randomUUID();
    const first = controller.takeOver(owned.changeID, owned.userID, commandID);
    await stopEntered.promise;
    const duplicate = createChangeWriterController(options).takeOver(
      owned.changeID,
      owned.userID,
      commandID,
    );
    releaseStop.resolve();
    expect((await first).canWrite).toBe(true);
    state = "ready";
    expect((await duplicate).canWrite).toBe(true);
    expect(stopping).toBe(1);
    const turnID = crypto.randomUUID();
    await owned.database.client.begin((sql) => claimAgentWriterIn(sql, owned.changeID, turnID));
    let observations = 0;
    const waiting = createChangeWriterController({
      ...options,
      runtime: {
        stop: async () => {},
        get: async () => ({ state: ++observations > 2 ? "stopped" : "stopping" }),
      },
    });
    await waiting.prepareAgent(owned.changeID, turnID);
    expect(observations).toBeGreaterThan(2);
    expect((await waiting.view(owned.changeID, owned.userID)).state).toBe("agent");
    expect(sourceFences.length).toBe(2);
  } finally {
    releaseStop.resolve();
    await owned.dispose();
    await processFixture.dispose();
  }
}, 30_000);
