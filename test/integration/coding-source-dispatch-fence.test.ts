import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import {
  type AgentTurnTransaction,
  createAgentTurnStore,
} from "../../apps/factory/src/agent/turn-store";
import { CommandError } from "../../apps/factory/src/command-error";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";

type Confirmation = [
  changeID: string,
  turnID: string,
  ownerToken: string,
  attemptID: string,
  sessionID: string,
];

function barrier() {
  const release = Promise.withResolvers<void>();
  return {
    entered: false,
    async wait() {
      this.entered = true;
      await release.promise;
    },
    release: () => release.resolve(),
  };
}

async function dispatchFixture(bootstrap: boolean, starting = false, failure?: Error) {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  const model = barrier();
  const skills = barrier();
  const source = barrier();
  const events: string[] = [];
  const confirmations: Confirmation[] = [];
  let creates = 0;
  let starts = 0;
  let dispatchFinished = false;
  let controller: ReturnType<typeof createAgentController> | undefined;
  async function noEffects() {
    expect(creates).toBe(0);
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
    expect(
      await owned.database
        .client`SELECT id FROM factory.change_commit_operation WHERE change_id=${owned.changeID}`,
    ).toHaveLength(0);
  }
  try {
    if (bootstrap)
      await owned.database
        .client`DELETE FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    if (starting)
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${owned.attemptID}`;
    const request = owned.hub.request.bind(owned.hub);
    owned.hub.request = async (attempt, channel, input, path, beforeSend, ...rest) => {
      const receive = async () => {
        const pathname = new URL(input.url).pathname;
        if (input.method === "GET" && pathname === "/api/model") {
          await model.wait();
          events.push("model-ready");
        }
        if (input.method === "GET" && pathname === "/api/skill") {
          await skills.wait();
          events.push("skills-ready");
        }
        if (input.method === "POST" && pathname === "/api/session") {
          creates++;
          events.push("session-create");
        }
        if (input.method === "POST" && pathname.endsWith("/prompt")) events.push("prompt");
        return request(attempt, channel, input, path, undefined, ...rest);
      };
      // The fixture peer normally ignores this callback. Run the real transport's
      // SQL authority check, and admit the peer request only from its send closure.
      let response: Promise<Response> | undefined;
      if (beforeSend)
        await beforeSend(() => {
          response = receive();
        });
      else response = receive();
      if (!response) throw new Error("Owned OpenCode frame was not admitted");
      return response;
    };
    const writers = {
      ...owned.writers,
      async prepareAgent(changeID: string, turnID: string) {
        events.push("prepare-writer");
        return owned.writers.prepareAgent(changeID, turnID);
      },
      async confirmSource(...args: Confirmation) {
        confirmations.push(args);
        events.push("confirm-source");
        await source.wait();
        if (failure) throw failure;
        events.push("source-confirmed");
      },
    };
    const begin = owned.database.client.begin.bind(owned.database.client);
    const database = {
      ...owned.database,
      client: new Proxy(owned.database.client, {
        get(target, key, receiver) {
          if (key !== "begin") return Reflect.get(target, key, receiver);
          return (work: (sql: AgentTurnTransaction) => Promise<unknown>) => {
            let dispatch = false;
            // Observe beginDispatch's pending-row lock without replacing the
            // Turn store, executing substitute SQL, or changing its result.
            return begin((sql) =>
              work(
                new Proxy(sql, {
                  apply(target, receiver, args) {
                    const query = Array.isArray(args[0]) ? args[0].join(" ") : "";
                    if (
                      query.includes("SELECT * FROM factory.agent_turn") &&
                      query.includes("state = 'pending'") &&
                      query.includes("FOR UPDATE")
                    ) {
                      dispatch = true;
                      events.push("begin-dispatch");
                    }
                    return Reflect.apply(target, receiver, args);
                  },
                }),
              ),
            ).finally(() => {
              if (dispatch) dispatchFinished = true;
            });
          };
        },
      }),
    };
    controller = createAgentController(
      database,
      owned.hub,
      {
        async startPersisted(changeID, userID) {
          expect([changeID, userID]).toEqual([owned.changeID, owned.userID]);
          starts++;
          events.push("runtime-start");
          await owned.database
            .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
          return null;
        },
      },
      undefined,
      writers,
    );
    const active = controller;
    const turns = createAgentTurnStore(owned.database);
    return {
      owned,
      commandID,
      controller: active,
      turns,
      model,
      skills,
      source,
      events,
      confirmations,
      noEffects,
      dispatchFinished: () => dispatchFinished,
      creates: () => creates,
      starts: () => starts,
      async dispatch() {
        if (bootstrap) await active.start(owned.changeID, owned.userID, commandID);
        else
          await active.prompt(
            owned.changeID,
            "Check Source at the dispatch boundary",
            owned.userID,
            commandID,
          );
      },
      async pendingConfirmation() {
        model.release();
        skills.release();
        await eventually(
          async () =>
            source.entered ||
            owned.requests() > 0 ||
            ["failed", "uncertain", "stopped"].includes((await owned.turn(commandID))?.state ?? ""),
          Boolean,
          "Agent did not reach Source confirmation",
        );
        expect(confirmations).toHaveLength(1);
        const turn = await turns.getByCommand(commandID);
        if (!turn?.ownerToken) throw new Error("Owned pending execution lease required");
        const intent = await createChangeAdmission(owned.database, buildModelID).intent(turn.id);
        expect(turn.state).toBe("pending");
        expect(intent.skillLoading).toBe("native");
        expect(intent.bootstrap).toBe(bootstrap);
        expect(intent.sessionID).toBe(
          bootstrap ? `ses_factory_${owned.changeID.replaceAll("-", "")}` : owned.sessionID,
        );
        expect(confirmations).toEqual([
          [owned.changeID, turn.id, turn.ownerToken, owned.attemptID, intent.sessionID],
        ]);
        expect(await turns.validateExecution(turn.id, turn.ownerToken)).toBe(true);
        await noEffects();
        return turn;
      },
      async dispose() {
        model.release();
        skills.release();
        source.release();
        owned.release();
        try {
          await active.shutdown();
        } finally {
          await owned.dispose();
        }
      },
    };
  } catch (cause) {
    model.release();
    skills.release();
    source.release();
    owned.release();
    try {
      await controller?.shutdown();
    } finally {
      await owned.dispose();
    }
    throw cause;
  }
}

test.each([
  ["bootstrap", true, true],
  ["bootstrap on already-ready compute", true, false],
  ["retained on already-ready compute", false, false],
] as const)(
  "Source confirmation fences %s after model and skill readiness",
  async (_session, bootstrap, starting) => {
    const scope = await dispatchFixture(bootstrap, starting);
    try {
      await scope.dispatch();
      await eventually(async () => scope.model.entered, Boolean, "Model probe was not reached");
      expect(scope.confirmations).toEqual([]);
      expect(scope.skills.entered).toBe(false);
      expect(scope.creates()).toBe(0);
      expect(scope.owned.requests()).toBe(0);
      scope.model.release();
      await eventually(async () => scope.skills.entered, Boolean, "Skill probe was not reached");
      expect(scope.confirmations).toEqual([]);
      expect(scope.creates()).toBe(0);
      expect(scope.owned.requests()).toBe(0);
      const turn = await scope.pendingConfirmation();
      expect(scope.starts()).toBe(starting ? 1 : 0);
      expect(scope.events).toEqual([
        "prepare-writer",
        ...(starting ? ["runtime-start"] : []),
        "model-ready",
        "skills-ready",
        "confirm-source",
      ]);
      scope.source.release();
      await scope.owned.requested;
      expect((await scope.turns.get(turn.id))?.state).toBe("dispatching");
      expect(scope.events.slice(-4)).toEqual(
        bootstrap
          ? ["source-confirmed", "begin-dispatch", "session-create", "prompt"]
          : ["confirm-source", "source-confirmed", "begin-dispatch", "prompt"],
      );
      expect(scope.confirmations).toHaveLength(1);
      expect(scope.creates()).toBe(bootstrap ? 1 : 0);
      expect(scope.owned.requests()).toBe(1);
      expect(scope.owned.commitCalls).toEqual([]);
    } finally {
      await scope.dispose();
    }
  },
  30_000,
);

for (const bootstrap of [true, false]) {
  test.each([
    new Error("Owned Source fencing failed"),
    new CommandError("unavailable", "Owned Source confirmation is unavailable"),
  ])(
    `Source rejection is a pre-dispatch failure, bootstrap=${bootstrap}: %s`,
    async (failure) => {
      const scope = await dispatchFixture(bootstrap, false, failure);
      try {
        await scope.dispatch();
        const turn = await scope.pendingConfirmation();
        scope.source.release();
        await eventually(
          () => scope.owned.turn(scope.commandID),
          (value) => value?.state === "failed",
          "Source failure was not classified as a pending failure",
        );
        expect(await scope.owned.turn(scope.commandID)).toMatchObject({
          state: "failed",
          summary: failure.message,
        });
        expect((await scope.turns.get(turn.id))?.ownerToken).toBeNull();
        expect(await scope.controller.get(scope.owned.changeID, undefined, false)).toMatchObject({
          state: "failed",
          lastError: failure.message,
        });
        expect(scope.events).not.toContain("source-confirmed");
        expect(scope.events).not.toContain("begin-dispatch");
        await scope.noEffects();
      } finally {
        await scope.dispose();
      }
    },
    30_000,
  );
}

test.each(["Stop", "lease loss"] as const)(
  "%s during Source confirmation fences a late successful acknowledgement",
  async (revocation) => {
    const scope = await dispatchFixture(true);
    try {
      await scope.dispatch();
      const turn = await scope.pendingConfirmation();
      if (!turn.ownerToken) throw new Error("Owned pending lease required");
      let replacementToken: string | null = null;
      if (revocation === "Stop") {
        await scope.controller.stop(scope.owned.changeID);
        expect((await scope.turns.get(turn.id))?.state).toBe("stopped");
      } else {
        await scope.turns.releasePending(turn.id, turn.ownerToken);
        const replacement = await scope.turns.claimPending(turn.id);
        if (!replacement?.ownerToken) throw new Error("Owned replacement lease required");
        replacementToken = replacement.ownerToken;
        expect(replacementToken).not.toBe(turn.ownerToken);
      }
      expect(await scope.turns.validateExecution(turn.id, turn.ownerToken)).toBe(false);
      scope.source.release();
      // Observe the real store rejecting dispatch before closing the controller,
      // so shutdown cannot substitute for Stop or the lost execution lease.
      await eventually(
        async () => scope.dispatchFinished(),
        Boolean,
        "Late Source confirmation did not reach the real dispatch fence",
      );
      await scope.controller.shutdown();
      expect(scope.events.slice(-2)).toEqual(["source-confirmed", "begin-dispatch"]);
      await scope.noEffects();
      expect(await scope.turns.get(turn.id)).toMatchObject({
        state: revocation === "Stop" ? "stopped" : "pending",
        ownerToken: replacementToken,
      });
    } finally {
      await scope.dispose();
    }
  },
  30_000,
);
