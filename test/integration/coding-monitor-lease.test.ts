import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createBuildBrowserController } from "../../apps/factory/src/agent/browser-controller";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { RuntimeParentOperationError } from "../../apps/factory/src/runtime/hub";
import { createDatabase } from "../../packages/db/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";

let databaseURL: string;
let disposeDatabase: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const supplied = process.env["FACTORY_TEST_POSTGRES"];
  if (supplied) {
    const database = await ownedTestDatabase(
      JSON.parse(supplied) as PostgresIdentity,
      crypto.randomUUID(),
    );
    databaseURL = database.url;
    disposeDatabase = database.dispose;
  } else {
    const server = await ownedPostgresServer();
    databaseURL = server.identity.url;
    disposeDatabase = server.dispose;
  }
}, 60_000);

afterAll(async () => {
  await disposeDatabase?.();
}, 60_000);

async function ownedBuild() {
  const previousURL = process.env["DATABASE_URL"];
  let database: ReturnType<typeof createDatabase>;
  try {
    process.env["DATABASE_URL"] = databaseURL;
    database = createDatabase(3);
  } finally {
    if (previousURL === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousURL;
  }
  const owned = await fixture(undefined, undefined, database);
  const request = owned.hub.request.bind(owned.hub);
  let nativeSession: { id: string } | undefined;
  owned.hub.request = async (...args) => {
    const input = args[2];
    const path = new URL(input.url).pathname;
    if (path === "/api/session" && input.method === "POST")
      nativeSession = await input.clone().json();
    if (nativeSession && path === `/api/session/${nativeSession.id}`) {
      if (input.method === "PATCH") {
        nativeSession = { ...nativeSession, ...(await input.json()) };
        return new Response(null, { status: 204 });
      }
      if (input.method === "GET") return Response.json({ data: nativeSession });
    }
    return request(...args);
  };
  // Exercise an actual bootstrap through execute(), not a directly invoked
  // monitor or an artificially expired/shortened ownership lease.
  await database.client`DELETE FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
  await database.client`INSERT INTO factory.branch_create_operation(
    id,change_id,repository_owner,repository_name,branch_name,start_sha,
    idempotency_key,state,observed_head_sha,completed_at)
    SELECT ${crypto.randomUUID()},id,'owned','fixture',branch_name,base_sha,
      ${crypto.randomUUID()},'succeeded',base_sha,now()
    FROM factory.change WHERE id=${owned.changeID}`;
  owned.acceptResponse();
  owned.release();
  return owned;
}

async function ownership(owned: Awaited<ReturnType<typeof ownedBuild>>, commandID: string) {
  const [current] = await owned.database.client<
    {
      id: string;
      state: string;
      owner: string | null;
      expires: number | null;
      live: boolean;
      sessionState: string;
      stopPending: boolean;
      summary: string | null;
    }[]
  >`SELECT turn.id,turn.state,turn.owner_token AS owner,
    EXTRACT(EPOCH FROM turn.owner_expires_at)::float8*1000 AS expires,
    COALESCE(turn.owner_expires_at>clock_timestamp(),false) AS live,
    session.state AS "sessionState",session.stop_pending AS "stopPending",
    turn.outcome_summary AS summary
    FROM factory.agent_turn turn
    JOIN factory.change_agent_session session ON session.active_turn_id=turn.id
    WHERE turn.command_id=${commandID}`;
  return current;
}

test("execute keeps the exact monitor owner live through valid observation longer than its real lease", async () => {
  const owned = await ownedBuild();
  const controller = owned.controller();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  const entered = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  let pages = 0;
  let completed = false;
  let sessionID = "";
  owned.hub.request = async (...args) => {
    const input = args[2];
    const url = new URL(input.url);
    if (url.pathname === "/api/session" && input.method === "POST") {
      const session = await input.clone().json();
      sessionID = session.id;
    }
    if (
      url.pathname === "/api/session" &&
      input.method === "GET" &&
      owned.requests() > 0 &&
      pages < 11
    ) {
      pages++;
      entered.resolve();
      // Each native page stays within its real five-second read timeout.
      // Their valid sequential pagination takes 33 seconds in total.
      await Bun.sleep(3_000);
      input.signal.throwIfAborted();
      if (pages === 11) observed.resolve();
      return Response.json({
        data: [],
        cursor: pages < 11 ? { next: `owned-page-${pages}` } : {},
      });
    }
    if (url.pathname.endsWith("/active"))
      return Response.json({ data: completed ? {} : { [sessionID]: { type: "running" } } });
    return request(...args);
  };
  try {
    await controller.start(owned.changeID, owned.userID, commandID);
    await entered.promise;
    const before = await ownership(owned, commandID);
    expect(before).toMatchObject({ state: "running", live: true, sessionState: "working" });
    expect(before?.owner).toBeString();
    const start = performance.now();
    await controller.recover();
    await controller.dispatchReadyPending();
    await observed.promise;
    expect(performance.now() - start).toBeGreaterThan(30_000);
    const after = await ownership(owned, commandID);
    expect(after).toMatchObject({
      id: before?.id,
      owner: before?.owner,
      state: "running",
      live: true,
      sessionState: "working",
      stopPending: false,
      summary: null,
    });
    expect(after?.expires).toBeGreaterThan(before?.expires ?? 0);
    expect(owned.requests()).toBe(1);
    expect(owned.interrupts()).toBe(0);
    completed = true;
    owned.finish();
    await eventually(
      () => ownership(owned, commandID),
      (current) => current?.state === "completed",
      "The retained exact input did not complete after the delayed observation",
    );
    expect(owned.requests()).toBe(1);
  } finally {
    await controller.shutdown();
    await owned.dispose();
  }
}, 60_000);

test("slow coalesced browser cleanup cannot starve the owner during valid long observation", async () => {
  const owned = await ownedBuild();
  const browser = createBuildBrowserController(
    owned.database,
    owned.hub,
    "owned-monitor-browser-secret",
  );
  const controller = createAgentController(
    owned.database,
    owned.hub,
    { startPersisted: async () => null },
    browser,
    owned.writers,
  );
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  const operation = owned.hub.parentOperation.bind(owned.hub);
  const entered = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  let pages = 0;
  let renewals = 0;
  let closes = 0;
  let sessionID = "";
  owned.hub.request = async (...args) => {
    const input = args[2];
    const url = new URL(input.url);
    if (url.pathname === "/api/session" && input.method === "POST")
      sessionID = (await input.clone().json()).id;
    if (url.pathname === "/api/session" && input.method === "GET" && owned.requests() > 0) {
      pages++;
      entered.resolve();
      if (pages <= 15) {
        // A valid 45-second observation, not an individual read past its timeout.
        await Bun.sleep(3_000);
        input.signal.throwIfAborted();
        if (pages === 15) owned.publishActivity();
        return Response.json({
          data: [],
          cursor: pages < 15 ? { next: `owned-browser-page-${pages}` } : {},
        });
      }
    }
    if (url.pathname.endsWith("/active"))
      return Response.json({
        data: owned.interrupts() > 0 ? {} : { [sessionID]: { type: "running" } },
      });
    return request(...args);
  };
  owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
    if (payload.action === "browser-renew") {
      let sent = false;
      await beforeSend?.(() => {
        sent = true;
      });
      expect(sent).toBe(true);
      renewals++;
      const { expiresAt } = JSON.parse(String(payload["data"])) as { expiresAt: string };
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(0);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(25_000);
      if (renewals === 2)
        throw new RuntimeParentOperationError("browser-renew", "browser execution authority ended");
      return {};
    }
    if (payload.action === "browser-close") {
      closes++;
      expect(JSON.parse(String(payload["data"])).expiresAt).toBe(new Date(0).toISOString());
      closing.resolve();
      // The real browser controller catches the confirmed renewal failure and
      // awaits its coalesced close. No native browser or model is involved.
      await releaseClose.promise;
      return {};
    }
    return operation(attempt, payload, beforeSend);
  };
  try {
    await controller.start(owned.changeID, owned.userID, commandID);
    await entered.promise;
    const before = await ownership(owned, commandID);
    expect(before).toMatchObject({ state: "running", live: true });
    await closing.promise;
    if (!before?.owner) throw new Error("Owned monitor lease was not claimed");
    // Keep renewTurn's real per-turn renewing Set. A concurrent call returns
    // without another dispatch while the failing call still owns cleanup.
    await browser.renewTurn(before.id, before.owner);
    expect(renewals).toBe(2);
    expect(closes).toBe(1);
    await eventually(
      () => ownership(owned, commandID),
      (current) => pages > 15 || current?.state === "stopped",
      "The valid long observation did not reach its next monitor iteration",
      50_000,
    );
    const after = await ownership(owned, commandID);
    expect(after).toMatchObject({
      id: before.id,
      state: "running",
      live: true,
      sessionState: "working",
      stopPending: false,
      summary: null,
    });
    expect(after?.owner === before.owner).toBe(true);
    expect(after?.expires).toBeGreaterThan(before.expires ?? 0);
    expect(owned.requests()).toBe(1);
    expect(owned.interrupts()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
    expect(renewals).toBe(2);
    expect(closes).toBe(1);
    const [scope] = await owned.database.client`SELECT state,cleanup_confirmed_at
      FROM factory.build_browser_session WHERE turn_id=${before.id}`;
    expect(scope).toMatchObject({ state: "closing", cleanup_confirmed_at: null });
    let joined = false;
    const shutdown = controller.shutdown().then(() => {
      joined = true;
    });
    await Bun.sleep(0);
    expect(joined).toBe(false);
    releaseClose.resolve();
    await shutdown;
    expect(joined).toBe(true);
    expect(await ownership(owned, commandID)).toMatchObject({
      state: "running",
      owner: before.owner,
      summary: null,
    });
    expect(closes).toBe(1);
    expect(renewals).toBe(2);
  } finally {
    releaseClose.resolve();
    await controller.shutdown();
    await owned.dispose();
  }
}, 75_000);

test.each([
  "Stop",
  "revocation",
  "shutdown",
  "Stop with browser cleanup",
  "revocation with browser cleanup",
] as const)(
  "%s during delayed monitor observation cannot publish a late completion or replay input",
  async (scenario) => {
    const action = scenario.startsWith("Stop")
      ? "Stop"
      : scenario.startsWith("revocation")
        ? "revocation"
        : "shutdown";
    const owned = await ownedBuild();
    const browser = scenario.endsWith("with browser cleanup")
      ? createBuildBrowserController(owned.database, owned.hub, "owned-revoked-browser-secret")
      : undefined;
    const controller = browser
      ? createAgentController(
          owned.database,
          owned.hub,
          { startPersisted: async () => null },
          browser,
          owned.writers,
        )
      : owned.controller();
    const commandID = crypto.randomUUID();
    const request = owned.hub.request.bind(owned.hub);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    let browserRenewals = 0;
    let browserCloses = 0;
    if (browser) {
      const operation = owned.hub.parentOperation.bind(owned.hub);
      owned.hub.parentOperation = async (attempt, payload, beforeSend) => {
        if (payload.action === "browser-renew") {
          await beforeSend?.(() => {});
          browserRenewals++;
          throw new RuntimeParentOperationError(
            "browser-renew",
            "browser execution authority ended",
          );
        }
        if (payload.action === "browser-close") {
          browserCloses++;
          closing.resolve();
          await releaseClose.promise;
          return {};
        }
        return operation(attempt, payload, beforeSend);
      };
    }
    let delayed = false;
    let finished = false;
    let messagesRead = false;
    const interruptedWhileStopped: boolean[] = [];
    owned.hub.request = async (...args) => {
      const input = args[2];
      const url = new URL(input.url);
      const path = url.pathname;
      if (path.endsWith("/interrupt") && input.method === "POST") {
        const current = await ownership(owned, commandID);
        interruptedWhileStopped.push(
          current?.state === "stopped" && current.sessionState === "stopped" && current.stopPending,
        );
      }
      if (path === "/api/session" && input.method === "GET" && owned.requests() > 0 && !finished) {
        finished = true;
        owned.finish();
      }
      const response = await request(...args);
      if (path.endsWith("/message") && url.searchParams.get("limit") === "100") messagesRead = true;
      if (path.endsWith("/inbox") && input.method === "GET" && messagesRead && !delayed) {
        delayed = true;
        entered.resolve();
        await release.promise;
        input.signal.throwIfAborted();
      }
      return response;
    };
    try {
      await controller.start(owned.changeID, owned.userID, commandID);
      await (browser ? closing.promise : entered.promise);
      const before = await ownership(owned, commandID);
      expect(before).toMatchObject({ state: "running", live: true });
      let shutdown: Promise<void> | undefined;
      let stopping: ReturnType<typeof controller.stop> | undefined;
      let joined = false;
      if (action === "Stop") {
        if (browser) {
          stopping = controller.stop(owned.changeID);
          await eventually(
            () => ownership(owned, commandID),
            (current) => current?.state === "stopped",
            "Explicit Stop did not fence the turn before waiting for browser cleanup",
          );
        } else await controller.stop(owned.changeID);
      } else if (action === "revocation")
        await owned.database.client`DELETE FROM factory.project_membership
          WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
      else {
        shutdown = controller.shutdown().then(() => {
          joined = true;
        });
        await Bun.sleep(0);
        expect(joined).toBe(false);
      }
      if (action !== "shutdown" && before?.owner)
        expect(await createAgentTurnStore(owned.database).renew(before.id, before.owner)).toBe(
          false,
        );
      release.resolve();
      releaseClose.resolve();
      await stopping;
      if (shutdown) {
        await shutdown;
        expect(joined).toBe(true);
      } else
        await eventually(
          () => ownership(owned, commandID),
          (current) => current?.state !== "running",
          "The delayed observation did not leave its revoked execution",
        );
      await controller.shutdown();
      const after = await ownership(owned, commandID);
      expect(after?.state).not.toBe("completed");
      expect(after?.sessionState).not.toBe("waiting");
      expect(after?.sessionState).not.toBe("committed");
      if (action === "Stop")
        expect(after).toMatchObject({ state: "stopped", summary: "Stopped by the user" });
      if (action === "shutdown") {
        expect(after).toMatchObject({
          id: before?.id,
          state: "running",
          owner: before?.owner,
          sessionState: "working",
          stopPending: false,
          summary: null,
        });
        const [usage] = await owned.database.client`SELECT outcome,settled_at
          FROM factory.usage_operation WHERE id=${`turn:${before?.id}`}`;
        expect(usage).toMatchObject({ outcome: null, settled_at: null });
      }
      expect(owned.requests()).toBe(1);
      // Revocation can fence settlement as uncertain or request automatic Stop.
      // Only that persisted Stop may interrupt, never the late monitor result.
      expect(interruptedWhileStopped.every(Boolean)).toBe(true);
      expect(interruptedWhileStopped.length).toBeLessThanOrEqual(1);
      if (action === "Stop") expect(interruptedWhileStopped).toEqual([true]);
      if (action === "shutdown") expect(interruptedWhileStopped).toEqual([]);
      expect(owned.interrupts()).toBe(interruptedWhileStopped.length);
      expect(owned.commitCalls).toEqual([]);
      if (browser) {
        expect(browserRenewals).toBe(1);
        expect(browserCloses).toBe(1);
      }
      expect(
        await owned.database.client`SELECT id FROM factory.change_commit_operation
          WHERE change_id=${owned.changeID}`,
      ).toHaveLength(0);
    } finally {
      release.resolve();
      releaseClose.resolve();
      await controller.shutdown();
      await owned.dispose();
    }
  },
  15_000,
);

test("automatic renewal refusal reports database lease facts without credentials or a human attribution", async () => {
  const owned = await ownedBuild();
  const controller = owned.controller();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const warnings: unknown[][] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args) => {
    warnings.push(args);
  });
  let delayed = false;
  owned.hub.request = async (...args) => {
    const input = args[2];
    if (
      new URL(input.url).pathname === "/api/session" &&
      input.method === "GET" &&
      owned.requests() > 0 &&
      !delayed
    ) {
      delayed = true;
      entered.resolve();
      await release.promise;
      input.signal.throwIfAborted();
      owned.publishActivity();
    }
    return request(...args);
  };
  try {
    await controller.start(owned.changeID, owned.userID, commandID);
    await entered.promise;
    const before = await ownership(owned, commandID);
    expect(before).toMatchObject({ state: "running", live: true });
    await owned.database.client`DELETE FROM factory.project_membership
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    release.resolve();
    const stopped = await eventually(
      () => ownership(owned, commandID),
      (current) => current?.state === "stopped",
      "Automatic authority refusal did not fence the running owner",
    );
    expect(stopped?.summary).toBe("Stopped because execution authority could not be renewed");
    const diagnostic = warnings.filter(
      ([message]) => message === "[factory] Coding ownership renewal refused",
    );
    expect(diagnostic).toHaveLength(1);
    const facts = diagnostic[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(facts).sort()).toEqual(
      ["turnID", "changeID", "ownerExpiresAt", "observedAt", "expired"].sort(),
    );
    expect(facts).toMatchObject({
      turnID: before?.id,
      changeID: owned.changeID,
      expired: false,
    });
    expect(Date.parse(String(facts["ownerExpiresAt"]))).toBe(Math.trunc(before?.expires ?? 0));
    expect(Date.parse(String(facts["observedAt"]))).toBeLessThan(before?.expires ?? 0);
    expect(JSON.stringify(diagnostic)).not.toContain(before?.owner ?? "missing-owner");
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toEqual([]);
    // A later generic confirmation cannot replace the already known origin.
    await createChangeAgentStop(owned.database, owned.hub).confirm(owned.changeID);
    expect((await ownership(owned, commandID))?.summary).toBe(stopped?.summary);
  } finally {
    release.resolve();
    await controller.shutdown();
    warn.mockRestore();
    await owned.dispose();
  }
}, 15_000);

test.each(["explicit", "automatic", "recovered"] as const)(
  "%s Stop attribution survives late observation and repeated confirmation",
  async (origin) => {
    const owned = await ownedBuild();
    const controller = owned.controller();
    const commandID = crypto.randomUUID();
    const request = owned.hub.request.bind(owned.hub);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delayed = false;
    owned.hub.request = async (...args) => {
      const input = args[2];
      if (
        new URL(input.url).pathname === "/api/session" &&
        input.method === "GET" &&
        owned.requests() > 0 &&
        !delayed
      ) {
        delayed = true;
        entered.resolve();
        await release.promise;
        input.signal.throwIfAborted();
      }
      return request(...args);
    };
    try {
      await controller.start(owned.changeID, owned.userID, commandID);
      await entered.promise;
      const before = await ownership(owned, commandID);
      if (!before) throw new Error("Owned running turn is unavailable");
      const stop = createChangeAgentStop(owned.database, owned.hub);
      if (origin === "recovered") {
        // Persist exactly the pre-settlement Stop barrier. Its caller/origin
        // was not retained across the crash, so recovery cannot invent one.
        await owned.database.client`UPDATE factory.change_agent_session
          SET state='stopped',stop_id=${crypto.randomUUID()},stop_turn_id=${before.id},
            stop_pending=true,active_inbox_id=NULL WHERE change_id=${owned.changeID}`;
        expect((await ownership(owned, commandID))?.state).toBe("running");
      } else
        await stop.persist(
          owned.changeID,
          undefined,
          origin === "automatic" ? "authority-loss" : undefined,
        );
      await stop.confirm(owned.changeID);
      await stop.confirm(owned.changeID);
      const summary =
        origin === "explicit"
          ? "Stopped by the user"
          : origin === "automatic"
            ? "Stopped because execution authority could not be renewed"
            : "Execution stopped";
      expect(await ownership(owned, commandID)).toMatchObject({
        state: "stopped",
        owner: null,
        summary,
      });
      owned.finish();
      release.resolve();
      await controller.shutdown();
      expect((await ownership(owned, commandID))?.summary).toBe(summary);
      expect(owned.requests()).toBe(1);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      release.resolve();
      await controller.shutdown();
      await owned.dispose();
    }
  },
  15_000,
);
