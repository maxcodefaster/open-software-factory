import { expect, spyOn, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("automatic Stop observation ends without clearing the admission barrier or replaying work", async () => {
  const owned = await fixture();
  const controller = owned.controller();
  const request = owned.hub.request.bind(owned.hub);
  const sleep = Bun.sleep;
  const intervals: number[] = [];
  let historyReads = 0;
  owned.hub.request = async (...args) => {
    if (
      new URL(args[2].url).pathname.endsWith("/message") &&
      new URL(args[2].url).searchParams.get("limit") === "1"
    ) {
      historyReads += 1;
      return Response.json({ data: [{ id: "owned-incomplete-message" }], cursor: {} });
    }
    return request(...args);
  };
  const clock = spyOn(Bun, "sleep").mockImplementation(async (duration) => {
    if (typeof duration !== "number" || duration < 1_000) return sleep(duration);
    intervals.push(duration);
    // Keep the red baseline finite without changing the observer's own verdict.
    if (intervals.length >= 5) throw new Error("Owned observer exceeded its observation budget");
  });
  try {
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    await owned.database.client`UPDATE factory.change_agent_session SET stop_dispatched = true
      WHERE change_id = ${owned.changeID}`;
    await controller.recover();
    for (let read = 0; read < 100; read += 1) {
      const state = await controller.get(owned.changeID);
      if (state.lastError?.startsWith("Stop remains unconfirmed") || intervals.length >= 5) break;
      await sleep(10);
    }
    expect(intervals).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(historyReads).toBe(5);
    const state = await controller.get(owned.changeID);
    expect(state).toMatchObject({
      state: "stopped",
      stopPending: true,
      lastError: expect.stringContaining("Stop remains unconfirmed"),
    });
    const readsAfterObservation = historyReads;
    await controller.get(owned.changeID);
    await controller.get(owned.changeID);
    expect(historyReads).toBe(readsAfterObservation);
    await expect(
      createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Do not bypass an exhausted Stop observer",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(owned.interrupts()).toBe(0);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
    expect(await owned.controller().get(owned.changeID)).toMatchObject({
      stopPending: true,
      lastError: state.lastError,
    });
    owned.hub.request = async (...args) =>
      new URL(args[2].url).pathname.endsWith("/message") &&
      new URL(args[2].url).searchParams.get("limit") === "1"
        ? Response.json({ data: [], cursor: {} })
        : request(...args);
    expect(await stop.confirm(owned.changeID)).toBe(true);
    expect(await controller.get(owned.changeID)).toMatchObject({
      stopPending: false,
      lastError: null,
    });
  } finally {
    await controller.shutdown();
    clock.mockRestore();
    owned.hub.request = request;
    await owned.dispose();
  }
});

test.each([
  { prerequisite: "ready", reason: "Ordered history has not proved" },
  { prerequisite: "undispatched", reason: "Interruption has not been dispatched" },
  { prerequisite: "disconnected", reason: "Live Workspace status is unavailable" },
  { prerequisite: "starting", reason: "Live Workspace status is unavailable" },
  { prerequisite: "session-missing", reason: "OpenCode Session is not yet identifiable" },
  { prerequisite: "assigned-stopped", reason: "Stopped compute cannot prove" },
  { prerequisite: "generation-changed", reason: "different Workspace generation" },
] as const)(
  "Stop recovery summary describes $prerequisite without new execution",
  async ({ prerequisite, reason }) => {
    const owned = await fixture();
    const connected = owned.hub.connected;
    try {
      if (prerequisite === "assigned-stopped") {
        const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
          owned.changeID,
          owned.userID,
          { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned assigned input" },
        );
        await owned.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${admitted.turn.id}`;
        await owned.database.client`UPDATE factory.runtime_attempt SET state = 'stopped'
        WHERE id = ${owned.attemptID}`;
      }
      if (prerequisite === "disconnected") owned.hub.connected = () => false;
      if (prerequisite === "starting")
        await owned.database.client`UPDATE factory.runtime_attempt SET state = 'starting'
        WHERE id = ${owned.attemptID}`;
      if (prerequisite === "session-missing")
        await owned.database
          .client`UPDATE factory.change_agent_session SET opencode_session_id = NULL
        WHERE change_id = ${owned.changeID}`;
      if (prerequisite === "generation-changed")
        await owned.database.client`UPDATE factory.change SET runtime_attempt_id = NULL
        WHERE id = ${owned.changeID}`;
      const stop = createChangeAgentStop(owned.database, owned.hub);
      await stop.persist(owned.changeID);
      if (prerequisite === "ready")
        await owned.database.client`UPDATE factory.change_agent_session SET stop_dispatched = true
          WHERE change_id = ${owned.changeID}`;
      const rows = await owned.database.client<Array<{ stopID: string; sessionID: string | null }>>`
      SELECT stop_id AS "stopID", opencode_session_id AS "sessionID"
      FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
      if (!rows[0]) throw new Error("Owned Stop target required");
      await stop.recordUnconfirmed(owned.changeID, { ...rows[0], attemptID: owned.attemptID });
      expect(await owned.controller().get(owned.changeID)).toMatchObject({
        state: "stopped",
        stopPending: true,
        lastError: expect.stringContaining(reason),
      });
      expect(owned.interrupts()).toBe(0);
      expect(owned.requests()).toBe(0);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      owned.hub.connected = connected;
      await owned.dispose();
    }
  },
);

test("an exhausted old observer cannot overwrite or dispatch a newer Stop", async () => {
  const owned = await fixture();
  try {
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    const rows = await owned.database.client<Array<{ stopID: string }>>`
      SELECT stop_id AS "stopID" FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
    if (!rows[0]) throw new Error("Owned Stop target required");
    const oldTarget = { ...rows[0], attemptID: owned.attemptID, sessionID: owned.sessionID };
    const newStopID = crypto.randomUUID();
    await owned.database.client`UPDATE factory.change_agent_session
      SET stop_id = ${newStopID}, last_error = 'Owned newer Stop detail' WHERE change_id = ${owned.changeID}`;
    await stop.recordUnconfirmed(owned.changeID, oldTarget);
    expect(await stop.confirm(owned.changeID, oldTarget.stopID)).toBe(true);
    expect(await owned.controller().get(owned.changeID)).toMatchObject({
      stopPending: true,
      lastError: "Owned newer Stop detail",
    });
    expect(owned.interrupts()).toBe(0);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("a later pending Stop gets its own observer while the previous observer sleeps", async () => {
  const owned = await fixture();
  const controller = owned.controller();
  const request = owned.hub.request.bind(owned.hub);
  const sleep = Bun.sleep;
  const firstWait = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let waits = 0;
  let empty = false;
  owned.hub.request = async (...args) =>
    new URL(args[2].url).pathname.endsWith("/message") &&
    new URL(args[2].url).searchParams.get("limit") === "1"
      ? Response.json({ data: empty ? [] : [{ id: "owned-incomplete-message" }], cursor: {} })
      : request(...args);
  const clock = spyOn(Bun, "sleep").mockImplementation(async (duration) => {
    if (duration !== 1_000) return sleep(duration);
    if (++waits === 1) {
      firstWait.resolve();
      await release.promise;
    }
  });
  try {
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    await owned.database.client`UPDATE factory.change_agent_session SET stop_dispatched = true
      WHERE change_id = ${owned.changeID}`;
    await controller.recover();
    await firstWait.promise;
    empty = true;
    expect(await stop.confirm(owned.changeID)).toBe(true);
    const next = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned later Stop target" },
    );
    await stop.persist(owned.changeID);
    await owned.database.client`UPDATE factory.change_agent_session SET stop_dispatched = true
      WHERE change_id = ${owned.changeID}`;
    empty = false;
    await controller.recover();
    let state = await controller.get(owned.changeID);
    for (let read = 0; read < 100 && !state.lastError; read += 1) {
      await sleep(10);
      state = await controller.get(owned.changeID);
    }
    expect(state).toMatchObject({
      stopPending: true,
      lastError: expect.stringContaining("Stop remains unconfirmed"),
      turn: { id: next.turn.id, state: "stopped" },
    });
    expect(waits).toBe(5);
    release.resolve();
    await controller.shutdown();
    expect(await controller.get(owned.changeID)).toMatchObject({ lastError: state.lastError });
    expect(owned.interrupts()).toBe(0);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    release.resolve();
    await controller.shutdown();
    clock.mockRestore();
    owned.hub.request = request;
    await owned.dispose();
  }
});

test("recovery confirms a saved unconfirmed Stop without replaying interruption", async () => {
  const owned = await fixture();
  const request = owned.hub.request.bind(owned.hub);
  let historyReads = 0;
  owned.hub.request = async (...args) => {
    if (
      new URL(args[2].url).pathname.endsWith("/message") &&
      new URL(args[2].url).searchParams.get("limit") === "1"
    ) {
      historyReads += 1;
      return Response.json({ data: [], cursor: {} });
    }
    return request(...args);
  };
  const controller = owned.controller();
  try {
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    const rows = await owned.database.client<Array<{ stopID: string }>>`
      UPDATE factory.change_agent_session SET stop_dispatched = true
      WHERE change_id = ${owned.changeID} RETURNING stop_id AS "stopID"`;
    if (!rows[0]) throw new Error("Owned Stop target required");
    await stop.recordUnconfirmed(owned.changeID, {
      ...rows[0],
      attemptID: owned.attemptID,
      sessionID: owned.sessionID,
    });
    expect(await controller.get(owned.changeID)).toMatchObject({
      stopPending: true,
      lastError: expect.stringContaining("The last confirmation check ended without confirmation"),
    });
    expect(historyReads).toBe(0);
    await controller.recover();
    for (let read = 0; read < 100; read += 1) {
      if (!(await controller.get(owned.changeID)).stopPending) break;
      await Bun.sleep(10);
    }
    expect(await controller.get(owned.changeID)).toMatchObject({
      stopPending: false,
      lastError: null,
    });
    expect(historyReads).toBe(1);
    expect(owned.interrupts()).toBe(0);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    await controller.shutdown();
    owned.hub.request = request;
    await owned.dispose();
  }
});
