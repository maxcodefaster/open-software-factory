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
    expect(await controller.takeOver(owned.changeID, owned.userID, commandID)).toMatchObject({
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
