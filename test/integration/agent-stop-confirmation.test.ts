import { expect, test } from "bun:test";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { fixture } from "../fixtures/change-agent-turns";

type Owned = Awaited<ReturnType<typeof fixture>>;

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
      expect((await controller.get(owned.changeID)).stopId).toBe(stopID);
      const result = await controller.recheckStop(owned.changeID, stopID);
      expect(result).toMatchObject({
        state: "stopped",
        stopPending: !dispatched,
        stopId: dispatched ? null : stopID,
      });
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
