import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createChangeAgentTransport } from "../../apps/factory/src/agent/change-transport";
import {
  createOpenCodeClient,
  decodeOpenCodeAdmission,
  ensureOpenCodeMessageBoundary,
} from "../../apps/factory/src/agent/opencode-client";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { connectorBoundary } from "../fixtures/connector-boundary";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("Stop before native Session creation confirms without inference and fences late dispatch", async () => {
  const process = await pinnedOpenCode();
  try {
    const owned = await fixture();
    let boundary: Awaited<ReturnType<typeof connectorBoundary>> | undefined;
    try {
      boundary = await connectorBoundary(process, owned.attemptID);
      owned.hub.request = boundary.hub.request.bind(boundary.hub);
      const admission = createChangeAdmission(owned.database, buildModelID);
      const { turn } = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      });
      const store = createAgentTurnStore(owned.database);
      const claimed = await store.claimPending(turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned pre-Session Turn claim required");
      expect(await owned.writers.prepareAgent(owned.changeID, turn.id)).toBe(true);
      await store.beginDispatch(turn.id, claimed.ownerToken);
      await owned.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${turn.id}`;
      await owned.database.client`UPDATE factory.change_agent_session
        SET state = 'starting', active_turn_id = ${turn.id} WHERE change_id = ${owned.changeID}`;
      const guarded = createOpenCodeClient(
        createChangeAgentTransport(
          owned.database,
          owned.hub,
          owned.attemptID,
          turn.id,
          claimed.ownerToken,
        ),
      );
      await expect(
        boundary.client.session.get({ sessionID: owned.sessionID }),
      ).rejects.toMatchObject({
        _tag: "SessionNotFoundError",
        sessionID: owned.sessionID,
      });
      const view = await owned.controller().stop(owned.changeID);
      expect(view.stopPending).toBe(false);
      expect(view.state).toBe("stopped");
      expect((await owned.turn(turn.commandId))?.state).toBe("stopped");
      await expect(
        guarded.session.create({
          id: owned.sessionID,
          title: "Revoked late Session create",
          location: { directory: "/workspace/project" },
          model: { providerID: "factory", id: buildModelID },
        }),
      ).rejects.toHaveProperty("cause.message", "Build authority changed before dispatch");
      await expect(
        boundary.client.session.get({ sessionID: owned.sessionID }),
      ).rejects.toMatchObject({
        _tag: "SessionNotFoundError",
        sessionID: owned.sessionID,
      });
      expect((await process.control()).providerRequests).toBe(0);
      await process.control("/release", "POST");
      const nextCommand = crypto.randomUUID();
      await owned.controller().start(owned.changeID, owned.userID, nextCommand);
      await observe(
        () => owned.controller().get(owned.changeID),
        (current) => current.state === "committed",
      );
      expect((await owned.turn(nextCommand))?.state).toBe("completed");
      expect((await process.control()).providerRequests).toBe(1);
      const original = await admission.intent(turn.id);
      const messages = await boundary.client.message.list({
        sessionID: owned.sessionID,
        limit: 100,
      });
      expect(messages.data.some((message) => message.id === original.promptID)).toBe(false);
    } finally {
      try {
        await owned.dispose();
      } finally {
        await boundary?.dispose();
      }
    }
  } finally {
    await process.dispose();
  }
}, 60_000);

test("Stop and retained Session reads wait for an earlier held native create", async () => {
  const process = await pinnedOpenCode();
  try {
    const owned = await fixture();
    let boundary: Awaited<ReturnType<typeof connectorBoundary>> | undefined;
    let delay: Awaited<ReturnType<NonNullable<typeof boundary>["delay"]>> | undefined;
    let creating: Promise<unknown> | undefined;
    try {
      boundary = await connectorBoundary(process, owned.attemptID);
      owned.hub.request = boundary.hub.request.bind(boundary.hub);
      const admission = createChangeAdmission(owned.database, buildModelID);
      const { turn } = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      });
      const store = createAgentTurnStore(owned.database);
      const claimed = await store.claimPending(turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned held Create Turn claim required");
      expect(await owned.writers.prepareAgent(owned.changeID, turn.id)).toBe(true);
      await store.beginDispatch(turn.id, claimed.ownerToken);
      await owned.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${turn.id}`;
      await owned.database.client`UPDATE factory.change_agent_session
        SET state = 'starting', active_turn_id = ${turn.id} WHERE change_id = ${owned.changeID}`;
      delay = await boundary.delay("reconnect", "session-create");
      const transport = createChangeAgentTransport(
        owned.database,
        owned.hub,
        owned.attemptID,
        turn.id,
        claimed.ownerToken,
      );
      const held = delay;
      const guarded = createOpenCodeClient((request, path) =>
        transport(new Request(request, { signal: held.signal }), path),
      );
      // Adopt caller failure immediately; the native observation outlives reconnect.
      creating = guarded.session
        .create({
          id: owned.sessionID,
          title: "Owned held Session create",
          location: { directory: "/workspace/project" },
          model: { providerID: "factory", id: buildModelID },
        })
        .catch(() => undefined);
      await delay.detach();
      // Session recovery reads share the Connector's ordered admission fence.
      // Health remains responsive, but a GET cannot jump the held create.
      await boundary.client.server.info();
      let readSettled = false;
      const retained = boundary.client.session
        .get({ sessionID: owned.sessionID })
        .then(
          (session) => ({ session, error: undefined }),
          (error: unknown) => ({ session: undefined, error }),
        )
        .finally(() => {
          readSettled = true;
        });
      const stopping = owned.controller().stop(owned.changeID);
      try {
        await observe(
          () => owned.turn(turn.commandId),
          (current) => current?.state === "stopped",
        );
        expect((await owned.controller().get(owned.changeID)).stopPending).toBe(true);
        await boundary.client.server.info();
        expect(
          await Promise.race([
            delay.interrupted.promise.then(() => true),
            Bun.sleep(100).then(() => false),
          ]),
        ).toBe(false);
        expect(readSettled).toBe(false);
        delay.release.resolve();
        await stopping;
        const observed = await retained;
        expect(observed.error).toBeUndefined();
        expect(observed.session?.id).toBe(owned.sessionID);
        expect(await delay.interrupted.promise).toBe(false);
      } finally {
        delay.release.resolve();
        await stopping;
        await creating;
      }
      expect((await boundary.client.session.get({ sessionID: owned.sessionID })).id).toBe(
        owned.sessionID,
      );
      // The create arrived before interrupt. Ordered complete history now
      // proves that this Session has no input; it is not an absence claim.
      expect((await owned.controller().get(owned.changeID)).stopPending).toBe(false);
      await expect(
        guarded.session.switchAgent({ sessionID: owned.sessionID, agent: "build" }),
      ).rejects.toHaveProperty("cause.message", "Build authority changed before dispatch");
      expect((await process.control()).providerRequests).toBe(0);
    } finally {
      delay?.release.resolve();
      await creating;
      try {
        await owned.dispose();
      } finally {
        await boundary?.dispose();
      }
    }
  } finally {
    await process.dispose();
  }
}, 60_000);

test.each(["none", "stream-close", "reconnect"] as const)(
  "stopped queued input cannot be consumed by a later Build wake: %s",
  async (loss) => {
    const process = await pinnedOpenCode();
    try {
      const owned = await fixture();
      let boundary: Awaited<ReturnType<typeof connectorBoundary>> | undefined;
      let delay: Awaited<ReturnType<NonNullable<typeof boundary>["delay"]>> | undefined;
      try {
        boundary = await connectorBoundary(process, owned.attemptID);
        owned.hub.request = boundary.hub.request.bind(boundary.hub);
        // Parent/runtime readiness and commit/push remain injected by the owned
        // fixture. HTTP uses the actual authenticated Hub and native child.
        await boundary.client.session.create({
          id: owned.sessionID,
          title: "Owned revoked queue proof",
          location: { directory: "/workspace/project" },
          model: { providerID: "factory", id: buildModelID },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        });
        // Factory establishes this native, inference-free message boundary before
        // admitting the first input. A queued input itself is not a boundary.
        await ensureOpenCodeMessageBoundary(boundary.client, owned.sessionID);
        const admission = createChangeAdmission(owned.database, buildModelID);
        const { turn } = await admission.admit(owned.changeID, owned.userID, {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "This revoked input must never run. Reply without tools.",
        });
        const store = createAgentTurnStore(owned.database);
        const claimed = await store.claimPending(turn.id);
        if (!claimed?.ownerToken) throw new Error("Owned queued Turn claim required");
        expect(await owned.writers.prepareAgent(owned.changeID, turn.id)).toBe(true);
        await store.beginDispatch(turn.id, claimed.ownerToken);
        await owned.database
          .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${turn.id}`;
        await owned.database
          .client`UPDATE factory.change_agent_session SET state = 'starting', active_turn_id = ${turn.id} WHERE change_id = ${owned.changeID}`;
        const intent = await admission.intent(turn.id);
        const transport = createChangeAgentTransport(
          owned.database,
          owned.hub,
          owned.attemptID,
          turn.id,
          claimed.ownerToken,
        );
        const guarded = createOpenCodeClient(transport);
        const retained = resolve(process.scratch, "project", "retained.txt");
        await Bun.write(retained, "Developer edits survive queued Stop\n");
        delay = loss === "none" ? undefined : await boundary.delay(loss);
        const delayed = delay;
        const enqueue = delayed
          ? createOpenCodeClient((request, path) =>
              transport(new Request(request, { signal: delayed.signal }), path),
            )
          : guarded;
        const prompt = enqueue.session
          .prompt({
            sessionID: intent.sessionID,
            id: intent.promptID,
            text: intent.text,
            delivery: "queue",
            resume: false,
          })
          .then(
            (admitted) => ({ ok: true as const, admitted }),
            () => ({ ok: false as const }),
          );
        if (delay) await delay.detach();
        else {
          const queued = await prompt;
          if (!queued.ok) throw new Error("Owned queue admission required");
          expect(decodeOpenCodeAdmission(queued.admitted, intent).state).toBe("queued");
        }
        expect((await process.control()).providerRequests).toBe(0);
        const stopping = owned.controller().stop(owned.changeID);
        try {
          await observe(
            () => owned.turn(turn.commandId),
            (turn) => turn?.state === "stopped",
          );
          if (delay) {
            expect((await owned.controller().get(owned.changeID)).stopPending).toBe(true);
            await boundary.client.server.info();
            expect(
              await Promise.race([
                delay.interrupted.promise.then(() => true),
                Bun.sleep(100).then(() => false),
              ]),
            ).toBe(false);
            delay.release.resolve();
          }
          await stopping;
        } finally {
          delay?.release.resolve();
          await stopping;
          await prompt;
        }
        expect((await owned.turn(turn.commandId))?.state).toBe("stopped");
        expect((await owned.controller().get(owned.changeID)).stopPending).toBe(false);
        expect(await Bun.file(retained).text()).toBe("Developer edits survive queued Stop\n");
        await expect(
          guarded.session.prompt({
            sessionID: intent.sessionID,
            id: intent.promptID,
            text: intent.text,
            delivery: "queue",
            resume: true,
          }),
        ).rejects.toThrow();
        expect((await process.control()).providerRequests).toBe(0);
        await process.control("/release", "POST");
        const nextCommand = crypto.randomUUID();
        await owned
          .controller()
          .prompt(
            owned.changeID,
            "Only this later input may run. Reply without tools.",
            owned.userID,
            nextCommand,
          );
        await observe(
          async () => {
            const view = await owned.controller().get(owned.changeID);
            if (view.state === "failed")
              throw new Error(`Owned later Build failed: ${view.lastError}`);
            return view;
          },
          (view) => view.state === "committed",
        );
        const messages = await process.client.message.list({
          sessionID: owned.sessionID,
          limit: 100,
        });
        expect(messages.data.some((message) => message.id === intent.promptID)).toBe(false);
        expect((await process.control()).providerRequests).toBe(1);
      } finally {
        try {
          delay?.release.resolve();
          await process.control("/release", "POST");
        } finally {
          try {
            await owned.dispose();
          } finally {
            await boundary?.dispose();
          }
        }
      }
    } finally {
      await process.dispose();
    }
  },
  60_000,
);
