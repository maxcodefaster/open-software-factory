import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
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
    if (nativeSession && path === `/api/session/${nativeSession.id}`)
      return Response.json({ data: nativeSession });
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

test.each(["Stop", "revocation", "shutdown"] as const)(
  "%s during delayed monitor observation cannot publish a late completion or replay input",
  async (action) => {
    const owned = await ownedBuild();
    const controller = owned.controller();
    const commandID = crypto.randomUUID();
    const request = owned.hub.request.bind(owned.hub);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delayed = false;
    let finished = false;
    let messagesRead = false;
    owned.hub.request = async (...args) => {
      const input = args[2];
      const url = new URL(input.url);
      const path = url.pathname;
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
      await entered.promise;
      const before = await ownership(owned, commandID);
      expect(before).toMatchObject({ state: "running", live: true });
      let shutdown: Promise<void> | undefined;
      let joined = false;
      if (action === "Stop") await controller.stop(owned.changeID);
      else if (action === "revocation")
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
      const interrupts = owned.interrupts();
      release.resolve();
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
      expect(owned.interrupts()).toBe(interrupts);
      expect(owned.commitCalls).toEqual([]);
      expect(
        await owned.database.client`SELECT id FROM factory.change_commit_operation
          WHERE change_id=${owned.changeID}`,
      ).toHaveLength(0);
    } finally {
      release.resolve();
      await controller.shutdown();
      await owned.dispose();
    }
  },
  15_000,
);
