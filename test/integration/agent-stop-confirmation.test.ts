import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

type Owned = Awaited<ReturnType<typeof fixture>>;

test("an unconfirmed reused Session still needs native queued-input evidence after teardown", async () => {
  const owned = await fixture();
  try {
    const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Retained Session must not be treated as an empty bootstrap",
      },
    );
    const [intent] = await owned.database.client<{ bootstrap: boolean }[]>`
      UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID}
      WHERE turn_id=${admitted.turn.id} RETURNING bootstrap`;
    expect(intent?.bootstrap).toBe(false);
    await owned.database.client`UPDATE factory.change_agent_session
      SET native_session_confirmed_at=NULL,active_turn_id=${admitted.turn.id},state='starting'
      WHERE change_id=${owned.changeID}`;
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    await owned.database.client`UPDATE factory.runtime_attempt SET state='stopped'
      WHERE id=${owned.attemptID}`;
    expect(await stop.confirm(owned.changeID)).toBe(false);
    expect(owned.interrupts()).toBe(0);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test.each([false, true])(
  "a stopped fresh Session without native confirmation has no queued input, confirmed=%s",
  async (confirmed) => {
    const owned = await fixture();
    const connected = owned.hub.connected;
    owned.hub.connected = () => false;
    try {
      await owned.database.client`DELETE FROM factory.change_agent_session
        WHERE change_id=${owned.changeID}`;
      const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
        owned.changeID,
        owned.userID,
        { kind: "change-start", commandId: crypto.randomUUID() },
      );
      const [intent] = await owned.database.client<{ sessionID: string; bootstrap: boolean }[]>`
        UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID}
        WHERE turn_id=${admitted.turn.id} RETURNING session_id AS "sessionID",bootstrap`;
      if (!intent?.bootstrap) throw new Error("Expected a fresh native Session");
      await owned.database.client`INSERT INTO factory.change_agent_session(
        change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,
        native_session_confirmed_at)
        VALUES(${owned.changeID},${owned.attemptID},${intent.sessionID},'starting',${owned.userID},
          ${admitted.turn.id},CASE WHEN ${confirmed} THEN now() ELSE NULL END)`;
      const stop = createChangeAgentStop(owned.database, owned.hub);
      await stop.persist(owned.changeID);
      await owned.database.client`UPDATE factory.runtime_attempt SET state='stopped'
        WHERE id=${owned.attemptID}`;
      expect(await stop.confirm(owned.changeID)).toBe(!confirmed);
      const [session] = await owned.database.client<{ pending: boolean }[]>`
        SELECT stop_pending AS pending FROM factory.change_agent_session
        WHERE change_id=${owned.changeID}`;
      expect(session?.pending).toBe(confirmed);
      expect((await owned.turn(admitted.turn.commandId))?.state).toBe("stopped");
      expect(owned.interrupts()).toBe(0);
      expect(owned.requests()).toBe(0);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      owned.hub.connected = connected;
      await owned.dispose();
    }
  },
);

async function savedStop(owned: Owned, dispatched: boolean) {
  const stop = createChangeAgentStop(owned.database, owned.hub);
  await stop.persist(owned.changeID);
  const rows = await owned.database.client<Array<{ stopID: string }>>`
    UPDATE factory.change_agent_session SET stop_dispatched = ${dispatched}
    WHERE change_id = ${owned.changeID} RETURNING stop_id AS "stopID"`;
  if (!rows[0]) throw new Error("Owned Stop required");
  return rows[0].stopID;
}

test.each([true, false])(
  "explicit Stop confirmation never dispatches interruption, dispatched=%s",
  async (dispatched) => {
    const owned = await fixture();
    const controller = owned.controller();
    const request = owned.hub.request.bind(owned.hub);
    const methods: string[] = [];
    owned.hub.request = async (...args) => {
      methods.push(args[2].method);
      return new URL(args[2].url).pathname.endsWith("/message")
        ? Response.json({ data: [], cursor: {} })
        : request(...args);
    };
    try {
      const stopID = await savedStop(owned, dispatched);
      if (dispatched)
        await owned.database.client`UPDATE factory.change_agent_session
        SET last_error='Execution outcome uncertain. Stop or resolve this turn before new Build work.'
        WHERE change_id=${owned.changeID}`;
      expect((await controller.get(owned.changeID)).stopId).toBe(stopID);
      const result = await controller.recheckStop(owned.changeID, stopID);
      expect(result).toMatchObject({
        state: "stopped",
        stopPending: !dispatched,
        stopId: dispatched ? null : stopID,
      });
      if (dispatched) expect(result.lastError).toBeNull();
      expect(methods.every((method) => method === "GET")).toBe(true);
      expect(owned.interrupts()).toBe(0);
      expect(owned.requests()).toBe(0);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      await controller.shutdown();
      owned.hub.request = request;
      await owned.dispose();
    }
  },
);

test("a stale explicit confirmation cannot check or overwrite a newer Stop", async () => {
  const owned = await fixture();
  const controller = owned.controller();
  try {
    await savedStop(owned, true);
    await owned.database
      .client`UPDATE factory.change_agent_session SET last_error = 'Owned current Stop'
      WHERE change_id = ${owned.changeID}`;
    await expect(controller.recheckStop(owned.changeID, crypto.randomUUID())).rejects.toMatchObject(
      {
        code: "conflict",
      },
    );
    expect(await controller.get(owned.changeID)).toMatchObject({
      stopPending: true,
      lastError: "Owned current Stop",
    });
    expect(owned.interrupts()).toBe(0);
    expect(owned.requests()).toBe(0);
  } finally {
    await controller.shutdown();
    await owned.dispose();
  }
});

test.each(["Stop", "generation"] as const)(
  "late read-only confirmation cannot clear a changed %s",
  async (changed) => {
    const owned = await fixture();
    const controller = owned.controller();
    const request = owned.hub.request.bind(owned.hub);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    owned.hub.request = async (...args) => {
      if (new URL(args[2].url).pathname.endsWith("/message")) {
        entered.resolve();
        await release.promise;
        return Response.json({ data: [], cursor: {} });
      }
      return request(...args);
    };
    let checking: ReturnType<typeof controller.recheckStop> | undefined;
    try {
      const stopID = await savedStop(owned, true);
      checking = controller.recheckStop(owned.changeID, stopID);
      await entered.promise;
      if (changed === "Stop")
        await owned.database.client`UPDATE factory.change_agent_session
          SET stop_id = ${crypto.randomUUID()}, last_error = 'Owned newer Stop' WHERE change_id = ${owned.changeID}`;
      else
        await owned.database.client`UPDATE factory.change SET runtime_attempt_id = NULL
          WHERE id = ${owned.changeID}`;
      release.resolve();
      expect(await checking).toMatchObject({
        stopPending: true,
        lastError: expect.stringContaining(changed === "Stop" ? "Owned newer Stop" : "generation"),
      });
      expect(owned.interrupts()).toBe(0);
      expect(owned.requests()).toBe(0);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      release.resolve();
      await checking?.catch(() => {});
      await controller.shutdown();
      owned.hub.request = request;
      await owned.dispose();
    }
  },
);
