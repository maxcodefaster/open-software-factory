import { expect, test } from "bun:test";
import {
  claimAgentWriterIn,
  lockChangeWriterIn,
  workspaceWriteAuthorityIn,
} from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import type { RuntimeAttemptView } from "../../apps/factory/src/runtime/types";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";
import { fixtureValue } from "../fixtures/value";
import { guardWriterCoordination } from "../fixtures/writer-coordination";

test("Agent writer claim shares rollback and increments the native epoch without losing its retained fence", async () => {
  const owned = await fixture();
  try {
    await owned.database.client`UPDATE factory.change_writer SET epoch=9007199254740993,
      fence_required=true,fence_attempt_id=${owned.attemptID},
      updated_at='2026-11-20 00:00:00.000123+00' WHERE change_id=${owned.changeID}`;
    const read = () => owned.database.client`SELECT state,epoch::text,turn_id,fence_required,
      fence_attempt_id,updated_at::text FROM factory.change_writer WHERE change_id=${owned.changeID}`;
    const before = await read();
    const turnID = crypto.randomUUID();
    await expect(
      owned.database.client.begin(async (sql) => {
        await claimAgentWriterIn(sql, owned.changeID, turnID, owned.userID);
        const [writer] = await sql`SELECT state,epoch::text,turn_id,fence_required,fence_attempt_id
        FROM factory.change_writer WHERE change_id=${owned.changeID}`;
        expect(writer).toMatchObject({
          state: "agent-preparing",
          epoch: "9007199254740994",
          turn_id: turnID,
          fence_required: true,
          fence_attempt_id: owned.attemptID,
        });
        throw new Error("Owned writer rollback");
      }),
    ).rejects.toThrow("Owned writer rollback");
    expect(await read()).toEqual(before);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("editing approval rechecks its exact request epoch after real Change lock contention", async () => {
  const owned = await fixture();
  const requesterID = crypto.randomUUID();
  const release = Promise.withResolvers<void>();
  let holder: Promise<unknown> | undefined;
  let contender: Promise<unknown> | undefined;
  let grants = 0;
  const writers = createChangeWriterController({
    database: owned.database,
    agentUsername: "owned-control",
    runtime: { stop: async () => {}, get: async () => ({ state: "stopped" }) },
    stopAgent: async () => {},
    protect: async (_changeID, users) => {
      if (users.length) grants++;
    },
  });
  try {
    await owned.database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${requesterID},'Owned requester',${`writer-${requesterID}@factory.local`},true)`;
    await owned.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${owned.projectID},${requesterID},'developer',${owned.userID})`;
    const human = await writers.takeOver(owned.changeID, owned.userID, crypto.randomUUID());
    const requestID = crypto.randomUUID();
    await writers.request(owned.changeID, requesterID, requestID, human.epoch);
    await writers.request(owned.changeID, requesterID, crypto.randomUUID(), human.epoch);
    expect((await writers.status(owned.changeID, owned.userID)).requests).toHaveLength(1);
    const entered = Promise.withResolvers<number>();
    holder = owned.database.client.begin(async (sql) => {
      await lockChangeWriterIn(sql, owned.changeID);
      const [connection] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!connection) throw new Error("Owned writer lock connection missing");
      await sql`UPDATE factory.change_writer SET epoch=epoch+1 WHERE change_id=${owned.changeID}`;
      entered.resolve(connection.pid);
      await release.promise;
    });
    const holderPID = await entered.promise;
    const commandID = crypto.randomUUID();
    contender = writers.approve(owned.changeID, owned.userID, commandID, requestID, human.epoch);
    const rejected = contender.then(
      () => {
        throw new Error("Stale editing approval succeeded");
      },
      (cause: unknown) => cause,
    );
    try {
      await eventually(
        async () => {
          const [wait] = await owned.database.client<{ blocked: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE ${holderPID} = ANY(pg_blocking_pids(pid))) AS blocked`;
          return wait?.blocked;
        },
        (blocked) => blocked === true,
        "Editing approval did not contend on the actual Change lock",
      );
    } finally {
      release.resolve();
    }
    await holder;
    expect(await rejected).toMatchObject({
      message: expect.stringContaining("writer is active or changed"),
    });
    expect(grants).toBe(1);
    const [stale] = await owned.database
      .client`SELECT command_id FROM factory.change_editing_decision
      WHERE command_id=${commandID}`;
    expect(stale).toBeUndefined();
    expect(await writers.status(owned.changeID, owned.userID)).toMatchObject({
      state: "human",
      epoch: human.epoch + 1,
      canWrite: true,
    });
    const currentRequestID = crypto.randomUUID();
    await writers.request(owned.changeID, requesterID, currentRequestID, human.epoch + 1);
    const transferred = await writers.approve(
      owned.changeID,
      owned.userID,
      crypto.randomUUID(),
      currentRequestID,
      human.epoch + 1,
    );
    expect(transferred).toMatchObject({
      state: "human",
      epoch: human.epoch + 3,
      canWrite: false,
      actor: { user: { id: requesterID } },
    });
    const requests = await owned.database.client`SELECT id,state FROM factory.change_editing_request
      WHERE change_id=${owned.changeID} ORDER BY writer_epoch`;
    expect([...requests]).toEqual([
      { id: requestID, state: "superseded" },
      { id: currentRequestID, state: "accepted" },
    ]);
    expect(grants).toBe(2);
    expect(owned.requests()).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled([holder, contender]);
    await owned.dispose();
  }
}, 30_000);

test.each(["continue", "stop"] as const)(
  "an admitted Build waits for previous writer teardown before %s without a new command",
  async (action) => {
    const processFixture = await factoryProcess();
    const owned = await fixture(undefined, undefined, processFixture.connect());
    const admission = createChangeAdmission(owned.database, buildModelID);
    const turns = createAgentTurnStore(owned.database);
    let stopped = false;
    let stopCalls = 0;
    let starts = 0;
    const grants: string[][] = [];
    const writers = createChangeWriterController({
      database: owned.database,
      agentUsername: "owned-control",
      stopDeadlineMs: 1,
      runtime: {
        stop: async () => {
          stopCalls++;
          await owned.database
            .client`UPDATE factory.runtime_attempt SET state='stopping' WHERE id=${owned.attemptID} AND state='ready'`;
        },
        get: async () => ({ state: stopped ? "stopped" : "stopping" }),
      },
      stopAgent: async () => {},
      // Controlled Source peer for this writer/dispatch composition fixture.
      fenceSource: async () => {},
      protect: async (_changeID, writers) => {
        grants.push([...writers]);
      },
    });
    const replacementID = runtimeIdentity(owned.workspaceID, 2).attemptID;
    const controller = createAgentController(
      owned.database,
      owned.hub,
      {
        startPersisted: async () => {
          starts++;
          expect(
            await recordUncreatedWorkspaceAttempt(owned.database, {
              workspaceID: owned.workspaceID,
              generation: 2,
              createdBy: owned.userID,
              parentHash: "b".repeat(64),
              childHash: "c".repeat(64),
              connectorURL: "wss://owned-build.factory.invalid/internal/runtime-connect",
            }),
          ).toBe(replacementID);
          await owned.database
            .client`UPDATE factory.change SET runtime_attempt_id=${replacementID} WHERE id=${owned.changeID}`;
          return null;
        },
      },
      undefined,
      writers,
    );
    try {
      const first = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      });
      await owned.writers.prepareAgent(owned.changeID, first.turn.id);
      const claimed = await turns.claimPending(first.turn.id);
      if (!claimed?.ownerToken) throw Error("Owned predecessor lease missing");
      await owned.database
        .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${first.turn.id}`;
      expect(
        await turns.failPending(first.turn.id, claimed.ownerToken, "Owned known failure"),
      ).toBe(true);
      await owned.database
        .client`UPDATE factory.change_agent_session SET state='failed',active_turn_id=${first.turn.id},last_error='Owned known failure' WHERE change_id=${owned.changeID}`;
      const commandID = crypto.randomUUID();
      await controller.prompt(
        owned.changeID,
        "Continue the retained source",
        owned.userID,
        commandID,
      );
      const pending = await eventually(
        async () => {
          const [turn] = await owned.database.client<
            { id: string; state: string; owner: string | null }[]
          >`
          SELECT id,state,owner_token AS owner FROM factory.agent_turn WHERE command_id=${commandID}`;
          return turn;
        },
        (turn) => stopCalls > 0 && !!turn && turn.owner === null,
        "Writer handoff did not release its bounded observation",
      );
      expect(pending?.state).toBe("pending");
      expect(await controller.get(owned.changeID, undefined, false)).toMatchObject({
        state: "starting",
        lastError: null,
      });
      expect(owned.requests()).toBe(0);
      expect(starts).toBe(0);
      expect(grants.at(-1)).toEqual([]);
      await controller.dispatchReadyPending();
      expect(owned.requests()).toBe(0);
      expect(stopCalls).toBe(1);
      if (action === "stop") await controller.stop(owned.changeID);
      stopped = true;
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
      owned.acceptResponse();
      owned.release();
      await controller.dispatchReadyPending();
      if (action === "stop") {
        expect((await owned.turn(commandID))?.state).toBe("stopped");
        expect(owned.requests()).toBe(0);
        expect(starts).toBe(0);
        return;
      }
      await eventually(
        async () => owned.requests(),
        (count) => count === 1,
        "Confirmed teardown did not continue the same admitted Build",
      );
      expect((await owned.turn(commandID))?.id).toBe(pending?.id);
      expect(starts).toBe(1);
      expect(grants.at(-1)).toEqual(["owned-control"]);
      await controller.dispatchReadyPending();
      expect(owned.requests()).toBe(1);
    } finally {
      owned.release();
      await controller.shutdown();
      try {
        await owned.dispose();
      } finally {
        await processFixture.dispose();
      }
    }
  },
  30_000,
);

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
      expect(await controller.prepareAgent(owned.changeID, retry.turn.id)).toBe(false);
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

test("observing settled work never takes editing; explicit takeover retains its fences and rejects stale completion", async () => {
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
    const observed = await controller.view(owned.changeID, owned.userID);
    expect(observed).toMatchObject({ state: "agent", canWrite: false });
    expect(String(observed.epoch)).toBe(initialEpoch);
    expect(stopping).toBe(0);
    const decisions = await owned.database
      .client`SELECT command_id FROM factory.change_editing_decision
      WHERE change_id=${owned.changeID}`;
    expect(decisions).toHaveLength(0);
    await expect(
      controller.takeOver(
        owned.changeID,
        owned.userID,
        crypto.randomUUID(),
        undefined,
        undefined,
        observed.epoch,
      ),
    ).rejects.toThrow("protection response lost");
    const pending = await controller.view(owned.changeID, owned.userID);
    expect(pending.state).toBe("handoff");
    expect(pending.canWrite).toBe(false);
    expect(stopping).toBe(0);
    failProtection = false;
    const recovered = createChangeWriterController(options);
    expect(
      (
        await recovered.takeOver(
          owned.changeID,
          owned.userID,
          fixtureValue(pending.commandID, "pending.commandID"),
        )
      ).canWrite,
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
    const guarded = guardWriterCoordination(owned.database.coordination);
    const guardedController = createChangeWriterController({
      ...options,
      database: { ...owned.database, coordination: guarded.coordination },
    });
    // Negative control: hold the actual PostgreSQL lock, then reject re-entry
    // before a second connection can wait on it and strand fixture cleanup.
    const key = `change-writer-operation:${owned.changeID}`;
    const outer = guarded.coordination();
    try {
      await outer`SELECT pg_advisory_lock(hashtext(${key}))`;
      await expect(
        guardedController.takeOver(owned.changeID, owned.userID, crypto.randomUUID(), initialEpoch),
      ).rejects.toThrow("Reentrant writer coordination lock");
      expect(guarded.heldKeys).toEqual([key]);
    } finally {
      try {
        await outer`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        await outer.end({ timeout: 1 });
      }
    }
    const beforeStale = guarded.acquisitions;
    const stale = guardedController.takeOver(
      owned.changeID,
      owned.userID,
      crypto.randomUUID(),
      initialEpoch,
    );
    // Await the operation itself, including unlock/close, without orphaning a race loser.
    expect((await stale).state).toBe("agent");
    expect(guarded.acquisitions).toBe(beforeStale + 1);
    expect(guarded.heldKeys).toEqual([]);
    const latest = await recovered.view(owned.changeID, owned.userID);
    expect(latest).toMatchObject({ state: "agent", canWrite: false });
    expect(stopping).toBe(stopsBeforeStale);
    expect(
      (
        await recovered.takeOver(
          owned.changeID,
          owned.userID,
          crypto.randomUUID(),
          undefined,
          undefined,
          latest.epoch,
        )
      ).canWrite,
    ).toBe(true);
    expect(stopping).toBe(stopsBeforeStale + 1);
  } finally {
    await owned.dispose();
    await processFixture.dispose();
  }
}, 30_000);

test.each(["confirmed", "source-pending", "native-running", "generic-paused"] as const)(
  "Ticket writer accepts only independently confirmed native paused compute: %s",
  async (observation) => {
    const owned = await fixture();
    const native: NonNullable<RuntimeAttemptView["native"]> = {
      engine: "substrate",
      actorUID: crypto.randomUUID(),
      state: observation === "native-running" ? "ACTOR_STATE_RUNNING" : "ACTOR_STATE_SUSPENDED",
      coldRestart: true,
      portable: false,
      sourceHandoff: observation === "source-pending" ? "pending" : "confirmed-same-node",
    };
    const grants: string[][] = [];
    let stops = 0;
    const controller = createChangeWriterController({
      database: owned.database,
      agentUsername: "owned-control",
      stopDeadlineMs: 0,
      runtime: {
        async stop() {
          stops++;
        },
        async get() {
          return { state: "paused", ...(observation === "generic-paused" ? {} : { native }) };
        },
      },
      async stopAgent() {
        throw new Error("Settled Session must not be stopped again");
      },
      async protect(_changeID, writers) {
        grants.push([...writers]);
      },
    });
    try {
      const commandID = crypto.randomUUID();
      if (observation === "confirmed") {
        const human = await controller.takeOver(owned.changeID, owned.userID, commandID);
        expect(human).toMatchObject({ state: "human", canWrite: true, stopPending: false });
        const turnID = crypto.randomUUID();
        await owned.database.client.begin((sql) =>
          claimAgentWriterIn(sql, owned.changeID, turnID, owned.userID),
        );
        expect(await controller.prepareAgent(owned.changeID, turnID)).toBe(true);
        expect(grants.at(-1)).toEqual(["owned-control"]);
        expect(stops).toBe(2);
      } else {
        await expect(controller.takeOver(owned.changeID, owned.userID, commandID)).rejects.toThrow(
          "compute has not stopped",
        );
        expect(await controller.status(owned.changeID, owned.userID)).toMatchObject({
          state: "handoff",
          canWrite: false,
        });
        expect(grants.at(-1)).toEqual([]);
      }
      expect(stops).toBeGreaterThan(0);
      expect(owned.requests()).toBe(0);
      expect(owned.interrupts()).toBe(0);
    } finally {
      await owned.dispose();
    }
  },
  60_000,
);

test("native paused compute cannot settle an assigned Agent input or bypass its Stop barrier", async () => {
  const owned = await fixture();
  const admission = createChangeAdmission(owned.database, buildModelID);
  const stop = createChangeAgentStop(owned.database, owned.hub, async () => {
    throw new Error("Native paused Source is not the legacy retained Stop path");
  });
  let stopCompute = 0;
  const controller = createChangeWriterController({
    database: owned.database,
    agentUsername: "owned-control",
    stopDeadlineMs: 0,
    runtime: {
      async stop() {
        stopCompute++;
      },
      async get() {
        return {
          state: "paused",
          native: {
            engine: "substrate",
            state: "ACTOR_STATE_SUSPENDED",
            coldRestart: true,
            portable: false,
            sourceHandoff: "confirmed-same-node",
          },
        };
      },
    },
    async stopAgent(changeID) {
      await stop.persist(changeID);
      expect(await stop.confirm(changeID)).toBe(false);
    },
    async protect() {},
  });
  try {
    const admitted = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Assigned input must not run on restart",
    });
    await owned.database
      .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${admitted.turn.id}`;
    await owned.database
      .client`UPDATE factory.change_agent_session SET state='working',active_turn_id=${admitted.turn.id} WHERE change_id=${owned.changeID}`;
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${owned.attemptID}`;
    const commandID = crypto.randomUUID();
    await expect(controller.takeOver(owned.changeID, owned.userID, commandID)).rejects.toThrow(
      "confirmed Agent Stop",
    );
    expect(await controller.status(owned.changeID, owned.userID)).toMatchObject({
      state: "handoff",
      canWrite: false,
      stopPending: true,
    });
    expect(stopCompute).toBe(0);
    const [saved] = await owned.database.client<
      { stopID: string }[]
    >`SELECT stop_id AS "stopID" FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    if (!saved) throw new Error("Saved Stop missing");
    expect(await stop.confirm(owned.changeID, saved.stopID, "observe")).toBe(false);
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Must remain blocked",
      }),
    ).rejects.toThrow();
    expect(owned.requests()).toBe(0);
    expect(owned.interrupts()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    await owned.dispose();
  }
}, 60_000);

test("failed bootstrap takeover tears down exact compute before confirming an unsubmitted Agent Stop", async () => {
  const processFixture = await factoryProcess();
  const owned = await fixture(undefined, undefined, processFixture.connect());
  const stop = createChangeAgentStop(owned.database, owned.hub);
  const events: string[] = [];
  try {
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${owned.attemptID}`;
    await owned.database.client`UPDATE factory.change_agent_session SET state='failed',
      native_session_confirmed_at=NULL,implementation_session_confirmed_at=NULL
      WHERE change_id=${owned.changeID}`;
    const writers = createChangeWriterController({
      database: owned.database,
      agentUsername: "owned-control",
      runtime: {
        async stop(attemptID) {
          expect(attemptID).toBe(owned.attemptID);
          events.push("compute-stopped");
          await owned.database.client`UPDATE factory.runtime_attempt SET state='stopped'
            WHERE id=${attemptID}`;
        },
        async get(attemptID) {
          const [row] = await owned.database.client<{ state: string }[]>`
            SELECT state FROM factory.runtime_attempt WHERE id=${attemptID}`;
          return row ?? null;
        },
      },
      async stopAgent(changeID) {
        await stop.persist(changeID);
        events.push((await stop.confirm(changeID)) ? "agent-stop-confirmed" : "agent-stop-pending");
      },
      async fenceSource() {
        events.push("source-fenced");
      },
      async protect(_changeID, writers) {
        events.push(writers.length ? "human-protected" : "branch-fenced");
      },
    });
    const view = await writers.takeOver(owned.changeID, owned.userID, crypto.randomUUID());
    expect(view).toMatchObject({ state: "human", canWrite: true });
    expect(events.indexOf("source-fenced")).toBeLessThan(events.indexOf("compute-stopped"));
    expect(events.indexOf("branch-fenced")).toBeLessThan(events.indexOf("compute-stopped"));
    expect(events.indexOf("compute-stopped")).toBeLessThan(events.indexOf("agent-stop-confirmed"));
    expect(events.indexOf("agent-stop-confirmed")).toBeLessThan(events.indexOf("human-protected"));
    expect(owned.requests()).toBe(0);
    expect(owned.interrupts()).toBe(0);
    const [session] = await owned.database.client<{ stop_pending: boolean }[]>`
      SELECT stop_pending FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    expect(session?.stop_pending).toBe(false);
  } finally {
    await owned.dispose();
    await processFixture.dispose();
  }
}, 60_000);

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
    await owned.database.client.begin((sql) =>
      claimAgentWriterIn(sql, owned.changeID, turnID, owned.userID),
    );
    await expect(
      owned.database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspace.id, owned.userID),
      ),
    ).rejects.toThrow("observation-only");
    stopped = false;
    expect(await controller.prepareAgent(owned.changeID, turnID)).toBe(false);
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

test.each(["source", "branch", "compute"] as const)(
  "an interrupted editing release resumes its exact intent after %s recovery without another command",
  async (failure) => {
    const processFixture = await factoryProcess();
    const owned = await fixture(undefined, undefined, processFixture.connect());
    let releasing = false;
    let unavailable = true;
    let stopCalls = 0;
    const fences: string[] = [];
    const interrupt = (stage: string) => {
      if (releasing && unavailable && failure === stage)
        throw new Error(`Owned ${stage} observation unavailable`);
    };
    const options = {
      database: owned.database,
      agentUsername: "owned-control",
      stopDeadlineMs: 1,
      runtime: {
        stop: async () => {
          interrupt("compute");
          stopCalls++;
        },
        get: async () => ({ state: "stopped" }),
      },
      stopAgent: async () => {},
      fenceSource: async (_changeID: string, epoch: string, writable: boolean) => {
        expect(writable).toBe(false);
        interrupt("source");
        fences.push(epoch);
      },
      protect: async (_changeID: string, writers: readonly string[]) => {
        interrupt("branch");
        if (releasing) expect(writers).toEqual([]);
      },
    };
    try {
      await owned.database.client`UPDATE factory.change_agent_session SET state='committed'
        WHERE change_id=${owned.changeID}`;
      const controller = createChangeWriterController(options);
      const human = await controller.takeOver(owned.changeID, owned.userID, crypto.randomUUID());
      releasing = true;
      const commandID = crypto.randomUUID();
      await expect(
        controller.release(owned.changeID, owned.userID, commandID, human.epoch),
      ).rejects.toThrow(`Owned ${failure} observation unavailable`);
      expect(await controller.status(owned.changeID, owned.userID)).toMatchObject({
        state: "handoff",
        canWrite: false,
        commandID,
        handoffKind: "release",
      });
      unavailable = false;
      const recovered = createChangeWriterController(options);
      const stopsBeforeObservation = stopCalls;
      const fencesBeforeObservation = fences.length;
      await expect(recovered.view(owned.changeID, crypto.randomUUID())).rejects.toThrow();
      expect(stopCalls).toBe(stopsBeforeObservation);
      expect(fences).toHaveLength(fencesBeforeObservation);
      expect(await recovered.view(owned.changeID, owned.userID)).toMatchObject({
        state: "unassigned",
        canWrite: false,
        epoch: human.epoch + 2,
      });
      const stopped = stopCalls;
      expect(
        await recovered.release(owned.changeID, owned.userID, commandID, human.epoch),
      ).toMatchObject({ state: "unassigned", canWrite: false });
      expect(stopCalls).toBe(stopped);
      expect(fences.at(-1)).toBe(String(human.epoch + 1));
      const [decisions] = await owned.database.client<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM factory.change_editing_decision
        WHERE command_id=${commandID} AND kind='release' AND writer_epoch=${human.epoch}`;
      expect(decisions?.count).toBe(1);
    } finally {
      await owned.dispose();
      await processFixture.dispose();
    }
  },
  30_000,
);

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
    await owned.database.client.begin((sql) =>
      claimAgentWriterIn(sql, owned.changeID, turnID, owned.userID),
    );
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
