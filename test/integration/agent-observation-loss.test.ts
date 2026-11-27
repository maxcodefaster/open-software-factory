import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDatabase } from "#db/client";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";

let identity: PostgresIdentity;
let server: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
beforeAll(async () => {
  const supplied = process.env["FACTORY_TEST_POSTGRES"];
  if (supplied) identity = JSON.parse(supplied);
  else {
    server = await ownedPostgresServer();
    identity = server.identity;
  }
}, 60_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);

for (const phase of ["monitor", "recovery"] as const)
  test.each([
    "work",
    "history",
    "disconnected",
    "not-ready",
    "reset",
    "healthy",
    "Stop",
    "owner",
  ] as const)(
    `${phase} bounds continuous exact-execution observation loss: %s`,
    async (scenario) => {
      const isolated = await ownedTestDatabase(identity, crypto.randomUUID());
      const previousURL = process.env["DATABASE_URL"];
      let database: ReturnType<typeof createDatabase>;
      try {
        process.env["DATABASE_URL"] = isolated.url;
        database = createDatabase(3);
      } finally {
        if (previousURL === undefined) delete process.env["DATABASE_URL"];
        else process.env["DATABASE_URL"] = previousURL;
      }
      const owned = await fixture(undefined, undefined, database);
      const controller = owned.controller();
      const originalRequest = owned.hub.request.bind(owned.hub);
      const originalConnected = owned.hub.connected.bind(owned.hub);
      // Only async work started in this test's controller context sees virtual
      // monotonic time. PostgreSQL leases and all other tests retain real clocks.
      const context = new AsyncLocalStorage<{ now: number }>();
      const realNow = performance.now.bind(performance);
      const clock = { now: realNow() };
      const time = spyOn(performance, "now").mockImplementation(
        () => context.getStore()?.now ?? realNow(),
      );
      const commandID = crypto.randomUUID();
      const replacementOwner = crypto.randomUUID();
      let observing = false;
      let reads = 0;
      let healthyReads = 0;
      let raceApplied = false;
      const fault = async () => {
        reads++;
        clock.now += nativeLifecycleWindowMS / 2;
        owned.publishActivity();
        if (scenario === "healthy" || (scenario === "reset" && reads === 2)) {
          healthyReads++;
          return;
        }
        if (reads === 2 && scenario === "Stop") {
          await createChangeAgentStop(database, owned.hub).persist(owned.changeID);
          raceApplied = true;
        }
        if (reads === 2 && scenario === "owner") {
          await database.client`UPDATE factory.agent_turn SET owner_token=${replacementOwner}
            WHERE command_id=${commandID}`;
          raceApplied = true;
        }
        throw new DOMException("Owned exact-execution observation unavailable", "TimeoutError");
      };
      owned.hub.connected = (attemptID) => {
        if (observing && scenario === "disconnected") {
          reads++;
          clock.now += nativeLifecycleWindowMS / 2;
          return false;
        }
        return originalConnected(attemptID);
      };
      owned.hub.request = async (...args) => {
        const request = args[2];
        const path = new URL(request.url).pathname;
        if (observing && request.method === "GET") {
          if (path === "/api/session/active") {
            if (scenario !== "history" && scenario !== "not-ready") await fault();
            return Response.json({ data: { [owned.sessionID]: { type: "running" } } });
          }
          if (path.endsWith("/message")) {
            if (scenario === "history") await fault();
            const input = owned.payloads.at(-1) as { id: string; text: string };
            return Response.json({
              data: [{ id: input.id, type: "user", text: input.text, time: { created: 1 } }],
              cursor: {},
            });
          }
        }
        return originalRequest(...args);
      };
      const turn = async () => {
        const [row] = await database.client<
          { state: string; owner: string | null; summary: string | null; stopPending: boolean }[]
        >`SELECT turn.state,turn.owner_token AS owner,turn.outcome_summary AS summary,
            session.stop_pending AS "stopPending"
          FROM factory.agent_turn turn JOIN factory.change_agent_session session
            ON session.active_turn_id=turn.id WHERE turn.command_id=${commandID}`;
        return row;
      };
      // Advance the disconnected/non-ready retry's existing sleep, without
      // replacing timers globally or shortening the SQL ownership lease.
      const realSleep = Bun.sleep;
      const sleep = spyOn(Bun, "sleep").mockImplementation(async (duration) => {
        if (context.getStore() === clock && observing && duration === 1_000) {
          if (scenario === "not-ready") {
            reads++;
            clock.now += nativeLifecycleWindowMS / 2;
          }
          return realSleep(1);
        }
        return realSleep(duration);
      });
      try {
        if (phase === "monitor") owned.acceptResponse();
        await context.run(clock, () =>
          controller.prompt(
            owned.changeID,
            "Observe this exact admitted execution",
            owned.userID,
            commandID,
          ),
        );
        await owned.requested;
        if (phase === "monitor") {
          // Start observation loss only after real dispatch, not startup checks.
          observing = true;
          owned.release();
        } else {
          owned.release();
          await eventually(
            turn,
            (row) => row?.state === "uncertain",
            "Lost receipt was not retained",
          );
          observing = true;
        }
        if (scenario === "not-ready")
          await database.client`UPDATE factory.runtime_attempt SET state='starting'
            WHERE id=${owned.attemptID}`;
        if (phase === "recovery") await context.run(clock, () => controller.recover());
        if (scenario === "healthy") {
          await eventually(
            () => Promise.resolve(healthyReads),
            (count) => count >= 4,
            "Healthy reads stopped",
          );
          expect((await turn())?.state).toBe("running");
          expect(clock.now - realNow()).toBeGreaterThan(nativeLifecycleWindowMS);
        } else if (scenario === "Stop" || scenario === "owner") {
          await eventually(
            () => Promise.resolve(raceApplied),
            Boolean,
            "Observation race was not reached",
          );
          await controller.shutdown();
          expect(await turn()).toMatchObject(
            scenario === "Stop"
              ? { state: "stopped", owner: null, stopPending: true }
              : { state: "running", owner: replacementOwner },
          );
        } else {
          // Recovery starts from an already uncertain, ownerless lost receipt.
          // Observe its bounded-loss settlement, not that earlier dispatch state.
          const settled = await eventually(
            turn,
            (row) =>
              row?.state === "uncertain" &&
              row.owner === null &&
              row.summary?.includes("could not be observed") === true,
            "Unobservable execution kept renewing as running",
            2_500,
          );
          expect(settled).toMatchObject({
            state: "uncertain",
            owner: null,
            stopPending: false,
            summary: expect.stringContaining("could not be observed"),
          });
          if (scenario === "reset") {
            expect(healthyReads).toBe(1);
            expect(reads).toBeGreaterThanOrEqual(4);
          }
          expect(owned.interrupts()).toBe(0);
          expect((await controller.get(owned.changeID, undefined, false)).state).toBe("failed");
        }
        expect(owned.requests()).toBe(1);
        expect(owned.commitCalls).toEqual([]);
      } finally {
        observing = false;
        owned.hub.request = originalRequest;
        owned.hub.connected = originalConnected;
        try {
          await controller.shutdown();
          await owned.dispose();
        } finally {
          sleep.mockRestore();
          time.mockRestore();
          context.disable();
          await isolated.dispose();
        }
      }
    },
    30_000,
  );
