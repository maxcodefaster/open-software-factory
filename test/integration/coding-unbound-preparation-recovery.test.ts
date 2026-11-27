import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createDatabase, type DatabaseTransaction } from "#db/client";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";

const evidence = ".factory/test-results/coding-unbound-preparation-recovery";
let databaseURL: string;
let disposeDatabase: (() => Promise<void>) | undefined;
let postgresOwner: string;

beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  const supplied = process.env["FACTORY_TEST_POSTGRES"];
  if (supplied) {
    const identity = JSON.parse(supplied) as PostgresIdentity;
    const database = await ownedTestDatabase(identity, crypto.randomUUID());
    databaseURL = database.url;
    disposeDatabase = database.dispose;
    postgresOwner = identity.owner;
  } else {
    const server = await ownedPostgresServer();
    databaseURL = server.identity.url;
    disposeDatabase = server.dispose;
    postgresOwner = server.identity.owner;
  }
  await writeFile(
    `${evidence}/postgres.json`,
    JSON.stringify({ owner: postgresOwner, disposed: false }),
  );
}, 60_000);

afterAll(async () => {
  await disposeDatabase?.();
  if (postgresOwner)
    await writeFile(
      `${evidence}/postgres.json`,
      JSON.stringify({ owner: postgresOwner, disposed: true }),
    );
}, 60_000);

type Owned = Awaited<ReturnType<typeof fixture>>;

async function retainedSession(owned: Owned) {
  const [session] = await owned.database.client<
    {
      state: string;
      attemptID: string;
      sessionID: string;
      activeTurnID: string | null;
      stopID: string | null;
      stopTurnID: string | null;
      stopPending: boolean;
      stopDispatched: boolean;
      confirmed: boolean;
    }[]
  >`SELECT state,runtime_attempt_id AS "attemptID",opencode_session_id AS "sessionID",
    active_turn_id AS "activeTurnID",stop_id AS "stopID",stop_turn_id AS "stopTurnID",
    stop_pending AS "stopPending",stop_dispatched AS "stopDispatched",
    native_session_confirmed_at IS NOT NULL AS confirmed
    FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
  if (!session) throw new Error("Owned retained Session is missing");
  return session;
}

async function pendingInput(owned: Owned, commandID: string) {
  const [input] = await owned.database.client<
    {
      turnID: string;
      state: string;
      summary: string | null;
      hasOwner: boolean;
      live: boolean;
      attemptID: string | null;
      sessionID: string;
      promptID: string;
      text: string;
      writerState: string;
      writerTurnID: string | null;
      writerEpoch: string;
      fenceRequired: boolean;
      currentAttemptID: string;
      runtimeState: string;
    }[]
  >`SELECT turn.id AS "turnID",turn.state,turn.outcome_summary AS summary,
    turn.owner_token IS NOT NULL AS "hasOwner",
    COALESCE(turn.owner_expires_at>clock_timestamp(),false) AS live,
    intent.runtime_attempt_id AS "attemptID",intent.session_id AS "sessionID",
    intent.prompt_id AS "promptID",intent.prompt_text AS text,
    writer.state AS "writerState",writer.turn_id AS "writerTurnID",
    writer.epoch::text AS "writerEpoch",writer.fence_required AS "fenceRequired",
    change.runtime_attempt_id AS "currentAttemptID",attempt.state AS "runtimeState"
    FROM factory.agent_turn turn
    JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
    JOIN factory.change change ON change.id=turn.change_id
    JOIN factory.change_writer writer ON writer.change_id=change.id
    JOIN factory.runtime_attempt attempt ON attempt.id=change.runtime_attempt_id
    WHERE turn.command_id=${commandID} AND change.id=${owned.changeID}`;
  if (!input) throw new Error("Owned admitted input is missing");
  return input;
}

async function heldPreparation() {
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
  const release = Promise.withResolvers<void>();
  const mutations: string[] = [];
  let detach: (() => void) | undefined;
  try {
    const request = owned.hub.request.bind(owned.hub);
    let history: unknown[] | undefined;
    let observedPrevious = false;
    owned.hub.request = async (...args) => {
      // Keep the production transport's before-send authority fence even though
      // its external peer is fake. Never submit to a model or native runtime.
      let sent = !args[4];
      await args[4]?.(() => {
        sent = true;
      });
      if (!sent) throw new Error("Owned external request was not admitted");
      const input = args[2];
      const path = new URL(input.url).pathname;
      if (!["GET", "HEAD"].includes(input.method)) mutations.push(`${input.method} ${path}`);
      if (path.endsWith("/active")) {
        observedPrevious = true;
        return Response.json({
          data:
            owned.requests() > owned.interrupts() ? { [owned.sessionID]: { type: "running" } } : {},
        });
      }
      if (history && input.method === "GET" && path.endsWith("/message"))
        return Response.json({ data: history });
      return request(...args);
    };

    // Establish the prior stopped input through the actual controller, including
    // native acceptance, ordered interrupt, queue cancellation and confirmation.
    const previous = owned.controller();
    const previousCommandID = crypto.randomUUID();
    owned.acceptResponse();
    owned.release();
    await previous.prompt(
      owned.changeID,
      "Retained work belongs to the previous input",
      owned.userID,
      previousCommandID,
    );
    await eventually(
      () => owned.turn(previousCommandID),
      (turn) => turn?.state === "running",
      "The previous owned input did not reach running",
    );
    await eventually(
      async () => observedPrevious,
      Boolean,
      "The previous owned input did not enter monitoring",
    );
    expect(await previous.stop(owned.changeID)).toMatchObject({
      state: "stopped",
      stopPending: false,
    });
    await previous.shutdown();
    const previousTurn = await owned.turn(previousCommandID);
    if (!previousTurn) throw new Error("Owned prior Turn is missing");
    const priorSession = await retainedSession(owned);
    expect(priorSession).toMatchObject({
      state: "stopped",
      activeTurnID: previousTurn.id,
      stopTurnID: previousTurn.id,
      stopPending: false,
      stopDispatched: false,
      confirmed: true,
    });
    const [priorPrompt] = owned.payloads as { id: string; text: string }[];
    if (!priorPrompt) throw new Error("Owned prior input was never accepted");
    history = [
      { id: priorPrompt.id, type: "user", time: { created: 1 }, text: priorPrompt.text },
      {
        id: `${priorPrompt.id}_retained`,
        type: "assistant",
        time: { created: 2, completed: 3 },
        finish: "stop",
        content: [{ type: "text", text: "Retained implementation from the stopped input." }],
      },
    ];
    await owned.nextInput();
    owned.acceptResponse();
    owned.release();

    await database.client`UPDATE factory.runtime_attempt SET state='starting'
      WHERE id=${owned.attemptID}`;
    let runtimeStarts = 0;
    let preparing = false;
    let startupFailure: Error | undefined;
    const controller = owned.controller(async () => {
      runtimeStarts++;
      preparing = true;
      await release.promise;
      if (startupFailure) throw startupFailure;
      return null;
    });
    const commandID = crypto.randomUUID();
    await controller.start(owned.changeID, owned.userID, commandID);
    await eventually(
      async () => preparing,
      Boolean,
      "The new admitted input did not enter runtime preparation",
    );
    const admitted = await pendingInput(owned, commandID);
    expect(admitted).toMatchObject({
      state: "pending",
      hasOwner: true,
      live: true,
      attemptID: null,
      writerState: "agent",
      writerTurnID: admitted.turnID,
      fenceRequired: false,
      currentAttemptID: owned.attemptID,
      runtimeState: "starting",
    });
    expect(await retainedSession(owned)).toEqual(priorSession);
    const priorRequests = owned.requests();
    const priorMutations = mutations.length;
    expect(priorRequests).toBe(1);
    // Only the held execute is background work on this controller. Its public
    // activity notification joins that invocation without closing/restarting it
    // or exposing the private starters Set.
    let preparationExited = false;
    detach = controller.subscribeActivity(owned.changeID, () => {
      preparationExited = true;
    });
    return {
      owned,
      controller,
      commandID,
      admitted,
      priorSession,
      priorRequests,
      mutations,
      priorMutations,
      runtimeStarts: () => runtimeStarts,
      async expire() {
        // Model the observed control-plane interruption in this owned DB only.
        // Production lease duration, renewal timer and authority checks stay real.
        const expired = await database.client`UPDATE factory.agent_turn
          SET owner_expires_at=clock_timestamp()-interval '1 millisecond'
          WHERE id=${admitted.turnID} AND state='pending' AND owner_token IS NOT NULL
          RETURNING id`;
        expect(expired).toHaveLength(1);
        expect(await pendingInput(owned, commandID)).toMatchObject({
          state: "pending",
          hasOwner: true,
          live: false,
          attemptID: null,
        });
      },
      async ready() {
        await database.client`UPDATE factory.runtime_attempt SET state='ready'
          WHERE id=${owned.attemptID}`;
        release.resolve();
        await eventually(
          async () => preparationExited,
          Boolean,
          "The expired preparation did not return after its same runtime became ready",
        );
        detach?.();
        detach = undefined;
      },
      async rejectStartup(message: string) {
        startupFailure = new Error(message);
        release.resolve();
        await eventually(
          async () => preparationExited,
          Boolean,
          "The rejected startup attempt did not return",
        );
        detach?.();
        detach = undefined;
      },
      async dispose() {
        detach?.();
        release.resolve();
        await owned.dispose();
      },
    };
  } catch (cause) {
    detach?.();
    release.resolve();
    await owned.dispose();
    throw cause;
  }
}

test("periodic dispatch recovers the exact unbound pending input after preparation loses its lease", async () => {
  const held = await heldPreparation();
  const { owned, controller, commandID, admitted } = held;
  try {
    await held.expire();
    await held.ready();
    const stranded = await pendingInput(owned, commandID);
    expect(stranded).toMatchObject({
      ...admitted,
      live: false,
      runtimeState: "ready",
    });
    expect(owned.requests()).toBe(held.priorRequests);
    expect(held.mutations).toHaveLength(held.priorMutations);
    await writeFile(`${evidence}/unbound-ready.json`, JSON.stringify(stranded, null, 2));

    // This is the periodic entry point on the same live controller. In
    // particular, do not call recover(), which would mask the missing selector.
    await controller.dispatchReadyPending();
    await eventually(
      () => owned.turn(commandID),
      (turn) => ["running", "failed", "stopped", "uncertain"].includes(turn?.state ?? ""),
      "dispatchReadyPending stranded the expired unbound input despite its current runtime being ready",
      2_000,
    );
    const recovered = await pendingInput(owned, commandID);
    expect(recovered).toMatchObject({
      ...admitted,
      state: "running",
      attemptID: owned.attemptID,
      live: true,
      runtimeState: "ready",
    });
    expect(owned.payloads.at(-1)).toMatchObject({
      id: admitted.promptID,
      text: admitted.text,
    });
    await controller.dispatchReadyPending();
    await controller.dispatchRuntimePending(owned.attemptID);
    expect(owned.requests()).toBe(held.priorRequests + 1);
    expect(held.runtimeStarts()).toBe(1);
    expect([
      ...(await owned.database.client`SELECT id,generation::int AS generation
      FROM factory.runtime_attempt WHERE project_id=${owned.projectID}`),
    ]).toEqual([{ id: owned.attemptID, generation: 1 }]);
    expect(await retainedSession(owned)).toMatchObject({
      activeTurnID: admitted.turnID,
      state: "working",
      stopPending: false,
    });
    expect(owned.commitCalls).toEqual([]);
  } finally {
    await held.dispose();
  }
}, 30_000);

test.each(["live", "expired"] as const)(
  "a returned startup rejection settles the %s unbound Turn without replay or Session replacement",
  async (lease) => {
    const held = await heldPreparation();
    const { owned, controller, commandID, admitted } = held;
    const summary = "Owned runtime startup canceled before input binding";
    try {
      if (lease === "expired") await held.expire();
      expect(await owned.turn(commandID)).toMatchObject({
        id: admitted.turnID,
        state: "pending",
        summary: null,
      });
      await held.rejectStartup(summary);
      await controller.dispatchReadyPending();
      const rejected = await pendingInput(owned, commandID);
      await writeFile(
        `${evidence}/unbound-startup-rejection-${lease}.json`,
        JSON.stringify(rejected, null, 2),
      );
      expect(await retainedSession(owned)).toEqual(held.priorSession);
      expect(held.mutations).toHaveLength(held.priorMutations);
      expect(owned.requests()).toBe(held.priorRequests);
      expect(held.runtimeStarts()).toBe(1);
      expect(owned.commitCalls).toEqual([]);
      expect(rejected).toMatchObject({
        ...admitted,
        state: "failed",
        summary,
        hasOwner: false,
        live: false,
        attemptID: null,
        runtimeState: "starting",
      });
      await controller.dispatchReadyPending();
      await controller.dispatchRuntimePending(owned.attemptID);
      expect(held.runtimeStarts()).toBe(1);
      expect(held.mutations).toHaveLength(held.priorMutations);
      expect(owned.requests()).toBe(held.priorRequests);
    } finally {
      await held.dispose();
    }
  },
  30_000,
);

test.each([
  "another owner",
  "bound intent",
  "assigned Session",
  "pending Stop",
  "completed Stop",
  "revoked Project membership",
  "current writer changed",
  "latest Requirements changed",
] as const)(
  "expired startup rejection cannot overwrite %s",
  async (boundary) => {
    const held = await heldPreparation();
    const { owned, controller, commandID, admitted } = held;
    const turns = createAgentTurnStore(owned.database);
    try {
      await held.expire();
      if (boundary === "another owner") {
        expect(await turns.claimPending(admitted.turnID)).not.toBeNull();
      } else if (boundary === "bound intent") {
        await owned.database.client`UPDATE factory.change_agent_turn_intent
          SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${admitted.turnID}`;
      } else if (boundary === "assigned Session") {
        await owned.database.client`UPDATE factory.change_agent_session
          SET active_turn_id=${admitted.turnID} WHERE change_id=${owned.changeID}`;
      } else if (boundary === "pending Stop") {
        await owned.database.client`UPDATE factory.change_agent_session
          SET stop_pending=true WHERE change_id=${owned.changeID}`;
      } else if (boundary === "completed Stop") {
        await controller.stop(owned.changeID);
      } else if (boundary === "revoked Project membership") {
        expect(
          await owned.database
            .client`SELECT user_id FROM factory.administrator WHERE user_id=${owned.userID}`,
        ).toHaveLength(0);
        expect(
          await owned.database.client`DELETE FROM factory.project_membership
            WHERE project_id=${owned.projectID} AND user_id=${owned.userID} RETURNING user_id`,
        ).toHaveLength(1);
      } else if (boundary === "current writer changed") {
        await owned.database.client`UPDATE factory.change_writer SET state='human',
          user_id=${owned.userID},turn_id=NULL,epoch=epoch+1
          WHERE change_id=${owned.changeID} AND turn_id=${admitted.turnID}`;
      } else {
        await owned.database.client`INSERT INTO factory.requirement_revision(
          id,ticket_id,ordinal,canonical_content,content_digest,created_by)
          SELECT ${crypto.randomUUID()},ticket_id,ordinal+1,canonical_content,content_digest,created_by
          FROM factory.requirement_revision WHERE id=${owned.revisionID}`;
      }
      const before = await turns.get(admitted.turnID);
      const sessionBefore = await retainedSession(owned);
      await held.rejectStartup("Owned late startup rejection must not cross this boundary");
      expect(await turns.get(admitted.turnID)).toEqual(before);
      expect(await retainedSession(owned)).toEqual(sessionBefore);
      expect(held.mutations).toHaveLength(held.priorMutations);
      expect(owned.requests()).toBe(held.priorRequests);
      expect(held.runtimeStarts()).toBe(1);
      expect(owned.commitCalls).toEqual([]);
      expect(await owned.turn(commandID)).toMatchObject({
        state: boundary === "completed Stop" ? "stopped" : "pending",
      });
    } finally {
      try {
        // Restore only the mutable Session injections before fixture Stop.
        // Keep the bound intent immutable through normal owned cleanup.
        if (boundary === "assigned Session")
          await owned.database.client`UPDATE factory.change_agent_session
            SET active_turn_id=${held.priorSession.activeTurnID} WHERE change_id=${owned.changeID}`;
        if (boundary === "pending Stop")
          await owned.database.client`UPDATE factory.change_agent_session
            SET stop_pending=false WHERE change_id=${owned.changeID}`;
      } finally {
        await held.dispose();
      }
    }
  },
  30_000,
);

test.each(["live", "expired"] as const)(
  "Stop cancels %s unbound preparation without reopening the previous Session's confirmed Stop",
  async (lease) => {
    const held = await heldPreparation();
    const { owned, controller, commandID, admitted } = held;
    try {
      if (lease === "expired") await held.expire();
      await controller.stop(owned.changeID);
      expect(await owned.turn(commandID)).toMatchObject({
        id: admitted.turnID,
        state: "stopped",
        summary: "Stopped by the user",
      });
      const stopped = await retainedSession(owned);
      await writeFile(`${evidence}/unbound-stop-${lease}.json`, JSON.stringify(stopped, null, 2));
      // The old Session has no new native input to cancel. A locally canceled
      // admission must not replace its proven Stop with an unconfirmable target.
      expect(stopped).toEqual(held.priorSession);
      expect(held.mutations).toHaveLength(held.priorMutations);
      await held.ready();
      await controller.dispatchReadyPending();
      await controller.recover();
      await controller.shutdown();
      expect(await retainedSession(owned)).toEqual(held.priorSession);
      expect(await pendingInput(owned, commandID)).toMatchObject({
        state: "stopped",
        attemptID: null,
        hasOwner: false,
      });
      expect(owned.requests()).toBe(held.priorRequests);
      expect(held.runtimeStarts()).toBe(1);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      await held.dispose();
    }
  },
  30_000,
);

test("Stop publishes its normal barrier instead of waiting on a locked unbound Turn under Change", async () => {
  const held = await heldPreparation();
  const { owned, controller, admitted } = held;
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stopping: Promise<unknown> | undefined;
  const transaction = owned.database.client.begin(async (sql) => {
    await sql`SELECT id FROM factory.agent_turn WHERE id=${admitted.turnID} FOR UPDATE`;
    locked.resolve();
    await release.promise;
  });
  try {
    await locked.promise;
    stopping = controller.stop(owned.changeID);
    await eventually(
      () => retainedSession(owned),
      (session) => session.stopPending,
      "Stop waited on Turn while holding Change instead of publishing its barrier",
      2_000,
    );
    expect(await retainedSession(owned)).toMatchObject({
      state: "stopped",
      activeTurnID: held.priorSession.activeTurnID,
      stopTurnID: admitted.turnID,
      stopPending: true,
      stopDispatched: false,
    });
    expect(held.mutations).toHaveLength(held.priorMutations);
    release.resolve();
    await transaction;
    await stopping;
    await held.ready();
    await controller.shutdown();
    // Taking the nonblocking fallback is not proof of native cancellation.
    // This fake peer has no ordered outcome for the unassigned new prompt.
    expect(await retainedSession(owned)).toMatchObject({
      state: "stopped",
      stopPending: true,
    });
    expect(owned.requests()).toBe(held.priorRequests);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    release.resolve();
    await transaction;
    await stopping;
    await held.dispose();
  }
}, 30_000);

test("local cancellation rechecks the intent and Session in a fresh statement after locking Turn", async () => {
  const held = await heldPreparation();
  const { owned, controller, admitted } = held;
  const original = owned.database.client;
  const statements: string[] = [];
  owned.database.client = new Proxy(original, {
    get(target, property, receiver) {
      if (property === "begin")
        return (
          optionsOrCallback: string | ((sql: DatabaseTransaction) => unknown),
          callback?: (sql: DatabaseTransaction) => unknown,
        ) => {
          const work = typeof optionsOrCallback === "string" ? callback : optionsOrCallback;
          if (!work) throw new Error("Owned transaction callback is missing");
          const observe = (sql: DatabaseTransaction) =>
            Reflect.apply(work, undefined, [
              new Proxy(sql, {
                apply(query, context, args) {
                  statements.push((args[0] as TemplateStringsArray).join(""));
                  return Reflect.apply(query, context, args);
                },
                get(query, property, receiver) {
                  if (property === "unsafe")
                    return (text: string, ...args: unknown[]) => {
                      statements.push(text);
                      return Reflect.apply(query.unsafe, query, [text, ...args]);
                    };
                  return Reflect.get(query, property, receiver);
                },
              }),
            ]);
          return typeof optionsOrCallback === "string"
            ? original.begin(optionsOrCallback, observe)
            : original.begin(observe);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await controller.stop(owned.changeID);
    const locked = statements.findIndex((sql) => sql.includes("FOR UPDATE OF turn SKIP LOCKED"));
    const canceled = statements.findIndex((sql) =>
      sql.toLowerCase().includes('update "factory"."agent_turn"'),
    );
    const rechecked = statements.findIndex(
      (sql, index) =>
        index > locked &&
        sql.includes('from "factory"."change_agent_session"') &&
        sql.includes('"factory"."change_agent_turn_intent"') &&
        sql.includes('"change_agent_turn_intent"."runtime_attempt_id" is null') &&
        sql.includes('"change_agent_session"."state" =') &&
        sql.includes('"change_agent_session"."stop_pending" ='),
    );
    // SKIP LOCKED alone does not refresh its statement snapshot if binding
    // commits just before the tuple lock. This separate statement is required.
    expect(locked).toBeGreaterThanOrEqual(0);
    expect(rechecked).toBeGreaterThan(locked);
    expect(canceled).toBeGreaterThan(rechecked);
    expect(await retainedSession(owned)).toEqual(held.priorSession);
    expect(await owned.turn(held.commandID)).toMatchObject({
      id: admitted.turnID,
      state: "stopped",
    });
    expect(held.mutations).toHaveLength(held.priorMutations);
    await held.ready();
  } finally {
    owned.database.client = original;
    await held.dispose();
  }
}, 30_000);

test.each(["current writer changed", "latest Requirements changed"] as const)(
  "unbound preparation recovery cannot dispatch after %s",
  async (boundary) => {
    const held = await heldPreparation();
    const { owned, controller, commandID, admitted } = held;
    try {
      await held.expire();
      if (boundary === "current writer changed") {
        await owned.database.client`UPDATE factory.change_writer SET state='human',
          user_id=${owned.userID},turn_id=NULL,epoch=epoch+1
          WHERE change_id=${owned.changeID} AND turn_id=${admitted.turnID}`;
      } else {
        await owned.database.client.begin(async (sql) => {
          const revisionID = crypto.randomUUID();
          await sql`INSERT INTO factory.requirement_revision(
            id,ticket_id,ordinal,canonical_content,content_digest,created_by)
            SELECT ${revisionID},ticket_id,ordinal+1,canonical_content,content_digest,created_by
            FROM factory.requirement_revision WHERE id=${owned.revisionID}`;
          // Approval is immutable and unique per Ticket. A newer saved revision
          // invalidates execution without fabricating a replacement approval.
        });
      }
      await held.ready();
      await controller.dispatchReadyPending();
      // Also exercise the existing broader startup recovery so these negative
      // controls reach execute's authority guards even before the selector fix.
      await controller.recover();
      await eventually(
        () => owned.turn(commandID),
        (turn) => turn?.state === "failed",
        "Recovery did not reject the revoked unbound input",
      );
      await controller.shutdown();
      expect(await pendingInput(owned, commandID)).toMatchObject({
        state: "failed",
        attemptID: null,
        hasOwner: false,
      });
      expect(await retainedSession(owned)).toEqual(held.priorSession);
      expect(held.mutations).toHaveLength(held.priorMutations);
      expect(owned.requests()).toBe(held.priorRequests);
      expect(held.runtimeStarts()).toBe(1);
      expect(owned.commitCalls).toEqual([]);
    } finally {
      await held.dispose();
    }
  },
  30_000,
);
