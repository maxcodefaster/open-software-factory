import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createDatabase } from "#db/client";
import { runtimeModelToken } from "#runtime-domain/identity";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import type { TerminalOutcome } from "../../apps/factory/src/agent/terminal-outcome";
import { createModelRelay } from "../../apps/factory/src/models/relay";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";
import {
  type CleanupScenario,
  cleanupPeer,
  interruptedStep,
  providerError,
} from "../fixtures/terminal-cleanup-peer";

type Database = ReturnType<typeof createDatabase>;
export type TestDatabaseFactory = () => Promise<{
  database: Database;
  dispose(): Promise<void>;
}>;
type Owned = Awaited<ReturnType<typeof fixture>>;
type Controller = ReturnType<typeof createAgentController>;

async function until<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
  wake?: () => void,
) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    wake?.();
    const value = await read();
    if (accepts(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Controller regression did not reach ${label}`);
}

async function observation(owned: Owned, commandID: string) {
  const [row] = await owned.database.client<
    {
      state: string;
      summary: string | null;
      sessionState: string;
      lastError: string | null;
      hasOwner: boolean;
      stopPending: boolean;
      stopDispatched: boolean;
      activeInputID: string | null;
    }[]
  >`
    SELECT turn.state, turn.outcome_summary AS summary,
      session.state AS "sessionState", session.last_error AS "lastError",
      turn.owner_token IS NOT NULL AS "hasOwner",
      session.stop_pending AS "stopPending", session.stop_dispatched AS "stopDispatched",
      session.active_inbox_id AS "activeInputID"
    FROM factory.agent_turn turn
    JOIN factory.change_agent_session session ON session.active_turn_id=turn.id
    WHERE turn.command_id=${commandID} AND turn.change_id=${owned.changeID}`;
  if (!row) throw new Error("The real admitted turn and active Session are required");
  return row;
}

async function terminal(owned: Owned, commandID: string) {
  const [row] = await owned.database.client<
    { checkpoint: TerminalOutcome | null; epoch: string }[]
  >`
    SELECT intent.terminal_outcome AS checkpoint, intent.model_request_epoch::text AS epoch
    FROM factory.change_agent_turn_intent intent JOIN factory.agent_turn turn ON turn.id=intent.turn_id
    WHERE turn.command_id=${commandID} AND intent.change_id=${owned.changeID}`;
  if (!row) throw new Error("Owned intent is missing");
  return row;
}

function relay(owned: Owned) {
  const secret = "owned-terminal-checkpoint-relay-not-a-live-credential";
  const send = createModelRelay(owned.database, secret, {
    baseURL: "https://owned-terminal-provider.invalid/v1",
    apiKey: "owned-test-provider-key",
  });
  return () =>
    send(
      new Request("http://factory.invalid/internal/model", {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeModelToken(secret, owned.attemptID, 1)}` },
        body: JSON.stringify({ model: buildModelID, reasoning: { effort: "medium" }, input: [] }),
      }),
      owned.attemptID,
      "responses",
    );
}

// No default fixture(), SQL double, private monitor invocation or module mock.
// The caller must supply a fresh, migrated, disposable test database per case.
export function registerControllerCleanupRegression(databaseForCase: TestDatabaseFactory) {
  async function runCase(
    scenario: CleanupScenario,
    assertion: (context: {
      owned: Owned;
      controller: Controller;
      commandID: string;
      peer: ReturnType<typeof cleanupPeer>;
      observe: () => ReturnType<typeof observation>;
      finish: () => void;
    }) => Promise<void>,
  ) {
    const resource = await databaseForCase();
    let owned: Owned | undefined;
    let controller: Controller | undefined;
    let peer: ReturnType<typeof cleanupPeer> | undefined;
    try {
      owned = await fixture(undefined, undefined, resource.database);
      const retained = owned;
      // Explicitly instantiate the actual controller, including its writer,
      // admission, leases, monitor, usage settlement and commit transport.
      controller = createAgentController(
        owned.database,
        owned.hub,
        { startPersisted: async () => null },
        undefined,
        owned.writers,
      );
      const request = owned.hub.request.bind(owned.hub);
      peer = cleanupPeer(
        owned.sessionID,
        scenario,
        (input, path) => request(retained.attemptID, "agent", input, path),
        owned.publishActivity,
      );
      const native = peer;
      owned.hub.request = async (attempt, channel, input, path) => {
        if (attempt !== retained.attemptID || channel !== "agent")
          throw new Error("Regression transport escaped its exact owned attempt");
        return native.transport(input, path);
      };
      const commandID = crypto.randomUUID();
      owned.acceptResponse();
      await controller.prompt(
        owned.changeID,
        "Complete the owned controller cleanup regression without replay",
        owned.userID,
        commandID,
      );
      await until(
        async () => retained.requests(),
        (count) => count === 1,
        "the single normal native prompt",
      );
      peer.begin();
      owned.release();
      await until(
        () => observation(retained, commandID),
        (row) => row.state === "running",
        "the actual running monitor",
        owned.publishActivity,
      );
      await assertion({
        owned,
        controller,
        commandID,
        peer,
        observe: () => observation(retained, commandID),
        finish() {
          native.finish();
          retained.finish();
        },
      });
    } finally {
      // Remove only controlled responses, join this explicitly created
      // controller, then use the maintained fixture's guarded record cleanup.
      peer?.disable();
      try {
        await controller?.shutdown();
      } finally {
        try {
          if (owned) await owned.dispose();
          else await resource.database.client.end();
        } finally {
          await resource.dispose();
        }
      }
    }
  }

  for (const scenario of [
    "cleanup-abort",
    "unchanged-success",
    "queued-shell-notification",
  ] as const)
    test(`controller terminal cleanup preserves observed success: ${scenario}`, async () => {
      await runCase(scenario, async ({ owned, commandID, peer, observe, finish }) => {
        finish();
        await until(
          async () => peer.snapshot(),
          (state) => state.removals === 1,
          "the real monitor -> interrupt -> shell.remove call",
          owned.publishActivity,
        );
        // The terminal input still owns execution while cleanup is held.
        expect(await observe()).toMatchObject({
          state: "running",
          summary: null,
          sessionState: "working",
          hasOwner: true,
          stopPending: false,
          stopDispatched: false,
        });
        expect(owned.commitCalls).toEqual([]);
        peer.releaseRemoval();
        const row = await until(
          observe,
          (value) => ["completed", "failed", "uncertain", "stopped"].includes(value.state),
          "a real persisted terminal decision",
          owned.publishActivity,
        );
        const state = peer.snapshot();
        expect(state.removals).toBe(1);
        expect(state.interrupts).toBe(2);
        expect(state.postCleanupHistoryReads).toBeGreaterThan(0);
        expect(state.cancellations).toBe(scenario === "queued-shell-notification" ? 1 : 0);
        expect(owned.requests()).toBe(1);
        const before = state.trace.indexOf("history-before-cleanup");
        expect(before).toBeGreaterThanOrEqual(0);
        expect(state.trace.indexOf("owned-shell-delete")).toBeGreaterThan(before);
        if (scenario === "cleanup-abort")
          expect(state.trace).toContain("session.step.failed:cleanup:aborted");
        console.info("Owned controller cleanup decision", {
          scenario,
          state: row.state,
          summary: row.summary,
          lastError: row.lastError,
          prompts: owned.requests(),
          interrupts: state.interrupts,
          removals: state.removals,
        });
        // RED on 2b00 if the cleanup-only new aborted assistant replaces the
        // prior successful verdict. Do not mark this test failing/skip/todo.
        expect(row.state).toBe("completed");
        expect(row.lastError).toBeNull();
        await until(
          async () => owned.commitCalls,
          (calls) => calls.length === 2,
          "normal source submission",
        );
        expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
        expect((await owned.turn(commandID))?.state).toBe("completed");
      });
    }, 20_000);

  for (const scenario of ["provider-error", "pre-cleanup-abort"] as const)
    test(`controller does not forgive a genuine pre-cleanup failure: ${scenario}`, async () => {
      await runCase(scenario, async ({ owned, peer, observe, finish }) => {
        finish();
        await until(
          async () => peer.snapshot().removals,
          (count) => count === 1,
          "terminal failure's owned-shell cleanup",
          owned.publishActivity,
        );
        peer.releaseRemoval();
        const row = await until(
          observe,
          (value) => value.state !== "running" && value.sessionState !== "working",
          "the genuine failed outcome",
          owned.publishActivity,
        );
        expect(row).toMatchObject({
          state: "failed",
          summary: scenario === "provider-error" ? providerError.message : interruptedStep.message,
          lastError:
            scenario === "provider-error" ? providerError.message : interruptedStep.message,
        });
        expect(peer.snapshot().postCleanupHistoryReads).toBeGreaterThan(0);
        expect(owned.commitCalls).toEqual([]);
        expect(owned.requests()).toBe(1);
      });
    }, 20_000);

  for (const scenario of ["unknown-shell", "new-input-before-cleanup"] as const)
    test(`controller cannot enter terminal cleanup across ${scenario}`, async () => {
      await runCase(scenario, async ({ owned, peer, observe, finish }) => {
        finish();
        await until(
          async () => peer.snapshot().terminalHistoryReads,
          (count) => count >= 2,
          "two guarded monitor observations",
          owned.publishActivity,
        );
        expect(peer.snapshot()).toMatchObject({ interrupts: 0, removals: 0, cancellations: 0 });
        expect(await observe()).toMatchObject({
          state: "running",
          summary: null,
          sessionState: "working",
          hasOwner: true,
        });
        expect(owned.commitCalls).toEqual([]);
        expect(owned.requests()).toBe(1);
      });
    }, 20_000);

  test("controller must recheck a newer input arriving during terminal cleanup", async () => {
    await runCase("new-input-during-cleanup", async ({ owned, peer, observe, finish }) => {
      finish();
      await until(
        async () => peer.snapshot().removals,
        (count) => count === 1,
        "held shell cleanup with a new unrelated input",
        owned.publishActivity,
      );
      peer.releaseRemoval();
      const row = await until(
        observe,
        (value) => value.state === "uncertain" || peer.snapshot().postCleanupHistoryReads >= 1,
        "post-cleanup Inbox or exact-input refusal",
        owned.publishActivity,
      );
      expect(["running", "uncertain"]).toContain(row.state);
      expect(row.sessionState).not.toBe("committed");
      expect(owned.commitCalls).toEqual([]);
      expect(peer.snapshot()).toMatchObject({ newerInput: true, cancellations: 0 });
      expect(owned.requests()).toBe(1);
    });
  }, 20_000);

  test("terminal checkpoint closes relay admission and cannot be reopened", async () => {
    await runCase("cleanup-abort", async ({ owned, commandID, peer, observe, finish }) => {
      const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("A checkpointed turn must not reach a provider"),
      );
      try {
        finish();
        await until(
          async () => peer.snapshot().removals,
          (count) => count === 1,
          "checkpointed cleanup",
          owned.publishActivity,
        );
        expect((await terminal(owned, commandID)).checkpoint).toMatchObject({
          promptID: (owned.payloads[0] as { id: string }).id,
          outcome: { state: "succeeded" },
        });
        expect((await relay(owned)()).status).toBe(403);
        expect(fetch.mock.calls).toHaveLength(0);
        // Activate postgres's lazy query before Bun inspects its rejection.
        await expect(
          Promise.resolve(owned.database.client`
            UPDATE factory.change_agent_turn_intent SET terminal_outcome=NULL
            WHERE turn_id=(SELECT id FROM factory.agent_turn WHERE command_id=${commandID})`),
        ).rejects.toThrow("immutable");
        peer.releaseRemoval();
        await until(
          observe,
          (row) => row.state === "completed",
          "normal checkpoint settlement",
          owned.publishActivity,
        );
      } finally {
        fetch.mockRestore();
      }
    });
  }, 20_000);

  for (const scenario of ["cleanup-abort", "provider-error"] as const)
    test(`restart resumes terminal cleanup without replay or reclassification: ${scenario}`, async () => {
      await runCase(scenario, async ({ owned, controller, commandID, peer, observe, finish }) => {
        finish();
        await until(
          async () => peer.snapshot().removals,
          (count) => count === 1,
          "durable checkpoint before restart",
          owned.publishActivity,
        );
        const checkpoint = (await terminal(owned, commandID)).checkpoint;
        expect(checkpoint).not.toBeNull();
        const shuttingDown = controller.shutdown();
        peer.releaseRemoval();
        await shuttingDown;
        expect((await observe()).state).toBe("running");
        await owned.database.client`UPDATE factory.agent_turn
          SET owner_expires_at=clock_timestamp()-interval '1 second'
          WHERE command_id=${commandID} AND state='running'`;
        await owned.controller().recover();
        await until(
          observe,
          (row) => ["completed", "failed"].includes(row.state),
          "restarted checkpoint settlement",
          owned.publishActivity,
        );
        expect((await observe()).state).toBe(
          scenario === "provider-error" ? "failed" : "completed",
        );
        if (scenario === "provider-error")
          expect((await observe()).summary).toBe(providerError.message);
        expect((await terminal(owned, commandID)).checkpoint).toEqual(checkpoint);
        expect(owned.requests()).toBe(1);
      });
    }, 20_000);

  for (const action of ["Stop", "authority-loss"] as const)
    test(`${action} during terminal cleanup cannot publish the checkpoint as completion`, async () => {
      await runCase(
        "cleanup-abort",
        async ({ owned, controller, commandID, peer, observe, finish }) => {
          finish();
          await until(
            async () => peer.snapshot().removals,
            (count) => count === 1,
            "held cleanup before authority change",
            owned.publishActivity,
          );
          expect((await terminal(owned, commandID)).checkpoint).not.toBeNull();
          if (action === "Stop") await controller.stop(owned.changeID);
          else
            await owned.database.client`DELETE FROM factory.project_membership
          WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
          peer.releaseRemoval();
          const row = await until(
            observe,
            (value) => value.state !== "running",
            "stopped or fenced checkpoint",
            owned.publishActivity,
          );
          expect(row.state).not.toBe("completed");
          if (action === "Stop")
            expect(row).toMatchObject({ state: "stopped", summary: "Stopped by the user" });
          expect(owned.commitCalls).toEqual([]);
          expect(owned.requests()).toBe(1);
        },
      );
    }, 20_000);

  test("provider dispatch during native observation invalidates a stale terminal checkpoint", async () => {
    await runCase("unchanged-success", async ({ owned, commandID, peer, observe, finish }) => {
      const request = owned.hub.request.bind(owned.hub);
      const releaseHistory = Promise.withResolvers<void>();
      let held = false;
      let running = false;
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ owned: true }));
      owned.hub.request = async (...args) => {
        const path = new URL(args[2].url).pathname;
        if (path === "/api/session/active" && running)
          return Response.json({ data: { [owned.sessionID]: { type: "running" } } });
        const response = await request(...args);
        if (path.endsWith("/message") && peer.snapshot().terminalHistoryReads > 0 && !held) {
          held = true;
          await releaseHistory.promise;
          args[2].signal.throwIfAborted();
        }
        return response;
      };
      try {
        finish();
        await until(
          async () => held,
          (value) => value,
          "history held after epoch sample",
          owned.publishActivity,
        );
        running = true;
        const response = await relay(owned)();
        expect(response.status).toBe(200);
        await response.body?.cancel();
        expect(fetch.mock.calls).toHaveLength(1);
        releaseHistory.resolve();
        await until(
          async () => peer.snapshot().terminalHistoryReads,
          (count) => count >= 2,
          "new active observation after raced dispatch",
          owned.publishActivity,
        );
        expect(await terminal(owned, commandID)).toEqual({ checkpoint: null, epoch: "1" });
        expect((await observe()).state).toBe("running");
        expect(peer.snapshot()).toMatchObject({ interrupts: 0, removals: 0 });
        expect(owned.commitCalls).toEqual([]);
      } finally {
        running = false;
        releaseHistory.resolve();
        owned.hub.request = request;
        fetch.mockRestore();
      }
    });
  }, 20_000);
}

let server: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
let identity: PostgresIdentity;
beforeAll(async () => {
  const supplied = process.env["FACTORY_TEST_POSTGRES"];
  if (supplied) identity = JSON.parse(supplied) as PostgresIdentity;
  else {
    server = await ownedPostgresServer();
    identity = server.identity;
  }
}, 90_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);
registerControllerCleanupRegression(async () => {
  const resource = await ownedTestDatabase(identity, crypto.randomUUID());
  const previous = process.env["DATABASE_URL"];
  try {
    process.env["DATABASE_URL"] = resource.url;
    return { database: createDatabase(3), dispose: resource.dispose };
  } catch (cause) {
    await resource.dispose();
    throw cause;
  } finally {
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
  }
});
