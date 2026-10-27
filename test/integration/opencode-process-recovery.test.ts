import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { classifyAgentTurn } from "../../apps/factory/src/agent/turn-outcome";
import {
  createOpenCodeClient,
  decodeOpenCodeAdmission,
  promptRecordedOpenCodeInput,
} from "../../apps/factory/src/agent/opencode-client";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import upstream from "../../upstream.json";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { pinnedOpenCode } from "../fixtures/pinned-opencode";

async function until<T>(observe: () => Promise<T>, accepts: (value: T) => boolean) {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await observe();
      if (accepts(result)) return result;
    } catch (cause) {
      lastError = cause;
    }
    await Bun.sleep(100);
  }
  throw new Error("Pinned process observation timed out", { cause: lastError });
}

test("pinned OpenCode retains exact queued admission across actual process loss", async () => {
  const id = crypto.randomUUID();
  const process = await pinnedOpenCode();
  const { control, transport, scratch } = process;
  try {
    let losePromptResponse = false;
    const client = createOpenCodeClient(async (request, path) => {
      const response = await transport(request, path);
      if (losePromptResponse && path.endsWith("/prompt") && response.ok) {
        losePromptResponse = false;
        await response.arrayBuffer();
        throw new Error("Owned lost response after real durable admission");
      }
      return response;
    });
    await until(
      () => client.server.info(),
      () => true,
    );
    expect((await client.server.info()).version).toBe(upstream.openCode.version);
    const sessionID = `ses_factory_${id.replaceAll("-", "")}`;
    const model = { providerID: "factory", id: buildModelID };
    const input = {
      id: sessionID,
      title: "Owned process proof",
      location: { directory: "/workspace/project" },
      model,
      permissions: [{ action: "*", resource: "*", effect: "allow" as const }],
    };
    const first = await client.session.create(input);
    expect(first.id).toBe(sessionID);
    expect((await client.session.create(input)).id).toBe(sessionID);
    const prompt = {
      sessionID,
      id: `msg_factory_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Reply with the owned process proof only. Do not use tools.",
      delivery: "queue" as const,
      resume: false,
    };
    losePromptResponse = true;
    await expect(client.session.prompt(prompt)).rejects.toThrow("Transport");
    expect(losePromptResponse).toBe(false);
    const queuedAdmission = await client.session.prompt(prompt);
    const recordedInput = {
      sessionID,
      promptID: prompt.id,
      text: prompt.text,
      bootstrap: false,
    };
    expect(decodeOpenCodeAdmission(queuedAdmission, recordedInput).state).toBe("queued");
    expect(queuedAdmission).toMatchObject({ id: prompt.id, sessionID, delivery: "queue" });
    expect(queuedAdmission).not.toHaveProperty("promotedSeq");
    expect((await client.message.list({ sessionID, limit: 100 })).data).toHaveLength(0);
    expect((await control()).providerRequests).toBe(0);
    await expect(
      promptRecordedOpenCodeInput(
        client,
        { ...recordedInput, text: "Conflicting replacement" },
        false,
      ),
    ).rejects.toThrow("does not match its recorded input");
    // Native retries identify the retained input. Factory validates that receipt,
    // rather than assuming a changed retry payload replaces it or is rejected upstream.
    expect(await client.session.inbox.list({ sessionID })).toMatchObject([
      { id: prompt.id, delivery: "queue", payload: { text: prompt.text } },
    ]);
    const before = await control();
    expect((await control("/kill", "POST")).running).toBe(false);
    await control("/restart", "POST");
    await until(
      () => client.server.info(),
      () => true,
    );
    const after = await control();
    expect(after.generation).toBe(before.generation + 1);
    expect(after.pid).not.toBe(before.pid);
    expect((await client.session.get({ sessionID })).model).toMatchObject(model);
    expect(await client.session.prompt(prompt)).toEqual(queuedAdmission);
    expect((await control()).providerRequests).toBe(0);
    expect((await client.message.list({ sessionID, limit: 100 })).data).toHaveLength(0);
    expect(await client.session.inbox.list({ sessionID })).toMatchObject([{ id: prompt.id }]);
    await control("/release", "POST");
    expect((await client.session.prompt({ ...prompt, resume: true })).id).toBe(prompt.id);
    await until(
      () => control(),
      (state) => state.providerRequests === 1,
    );
    await until(
      () => client.message.list({ sessionID, limit: 100 }),
      (messages) =>
        messages.data.some(
          (message) => message.type === "assistant" && message.time.completed !== undefined,
        ),
    );
    expect(
      (await client.message.list({ sessionID, limit: 100 })).data.filter(
        (message) => message.type === "user" && message.id === prompt.id,
      ),
    ).toHaveLength(1);
    expect((await client.session.prompt({ ...prompt, resume: true })).id).toBe(prompt.id);
    expect((await control()).providerRequests).toBe(1);
    const completedMessages = await client.message.list({ sessionID, limit: 100 });
    const promotedAdmission = await client.session.prompt(prompt);
    expect((await promptRecordedOpenCodeInput(client, recordedInput, false)).state).toBe(
      "promoted",
    );
    expect(promotedAdmission).toMatchObject({ id: prompt.id, sessionID });
    expect((await control()).providerRequests).toBe(1);
    expect(
      classifyAgentTurn(
        completedMessages.data.map((message) => ({
          id: message.id,
          type: message.type,
          created: message.time.created,
          ...(message.type === "assistant"
            ? { completed: message.time.completed, finish: message.finish, error: message.error }
            : {}),
        })),
        prompt.id,
        false,
      ),
    ).toEqual({ state: "succeeded" });
    console.log(
      "Pinned completed message order",
      (await client.message.list({ sessionID, limit: 100 })).data.map((message) => ({
        id: message.id,
        type: message.type,
        time: message.time,
        ...(message.type === "assistant" ? { finish: message.finish, error: message.error } : {}),
      })),
    );
    await control("/hold", "POST");
    const interrupted = {
      ...prompt,
      id: `msg_factory_${crypto.randomUUID().replaceAll("-", "")}`,
      resume: true,
    };
    expect((await client.session.prompt(interrupted)).id).toBe(interrupted.id);
    await until(
      () => control(),
      (state) => state.providerRequests === 2,
    );
    const running = await control();
    expect((await client.session.active())[sessionID]).toBeDefined();
    await control("/kill", "POST");
    await control("/restart", "POST");
    await until(
      () => client.server.info(),
      () => true,
    );
    expect((await control()).pid).not.toBe(running.pid);
    const recovered = await client.message.list({ sessionID, limit: 100 });
    const _interruptedAdmission = await client.session.prompt({ ...interrupted, resume: false });
    expect(
      (
        await promptRecordedOpenCodeInput(
          client,
          {
            ...recordedInput,
            promptID: interrupted.id,
          },
          false,
        )
      ).state,
    ).toBe("promoted");
    expect((await control()).providerRequests).toBe(2);
    // A queue wake is not an explicit forced Session resume. Even if promotion
    // races Factory's queued observation, repeating this ID cannot replay the
    // already promoted interrupted provider attempt when no inputs are pending.
    expect((await client.session.prompt({ ...interrupted, resume: true })).id).toBe(interrupted.id);
    await Bun.sleep(150);
    expect((await control()).providerRequests).toBe(2);
    expect((await client.session.active())[sessionID]).toBeUndefined();
    expect(
      recovered.data.some((message) => message.type === "user" && message.id === interrupted.id),
    ).toBe(true);
    expect(
      classifyAgentTurn(
        recovered.data.map((message) => ({
          id: message.id,
          type: message.type,
          created: message.time.created,
          ...(message.type === "assistant"
            ? { completed: message.time.completed, finish: message.finish, error: message.error }
            : {}),
        })),
        interrupted.id,
        false,
      ),
    ).toEqual({ state: "pending" });
    console.log("Pinned killed-provider state", {
      active: await client.session.active(),
      messages: recovered.data.map((message) => ({
        id: message.id,
        type: message.type,
        time: message.time,
        ...(message.type === "assistant" ? { finish: message.finish, error: message.error } : {}),
      })),
      providerRequests: (await control()).providerRequests,
    });
    expect((await control()).providerRequests).toBe(2);
    // Real PostgreSQL + Factory controller/client + pinned OpenCode. Only inference
    // content and the eventual forge commit/push are controlled fixture responses.
    const owned = await fixture();
    try {
      await client.session.create({ ...input, id: owned.sessionID });
      let acceptedControllerPrompts = 0;
      let loseControllerResponse = true;
      owned.hub.request = async (_attemptID, _channel, request, path) => {
        const response = await transport(request, path);
        if (path.endsWith("/prompt") && response.ok) {
          acceptedControllerPrompts += 1;
          if (loseControllerResponse) {
            loseControllerResponse = false;
            await response.arrayBuffer();
            throw new Error("Owned Factory response loss after actual OpenCode admission");
          }
        }
        return response;
      };
      const commandID = crypto.randomUUID();
      await owned
        .controller()
        .prompt(
          owned.changeID,
          "Reply with the owned process proof only. Do not use tools.",
          owned.userID,
          commandID,
        );
      await until(
        () => owned.turn(commandID),
        (turn) => turn?.state === "uncertain",
      );
      await until(
        () => control(),
        (state) => state.providerRequests === 3,
      );
      await owned.controller().recover();
      await until(
        () => owned.controller().get(owned.changeID),
        (view) => view.state === "working" && view.turn?.state === "running",
      );
      expect(acceptedControllerPrompts).toBe(1);
      expect((await control()).providerRequests).toBe(3);
      await control("/release", "POST");
      await until(
        () => owned.controller().get(owned.changeID),
        (view) => view.state === "committed",
      );
      expect(await owned.turn(commandID)).toMatchObject({ state: "completed" });
      expect(acceptedControllerPrompts).toBe(1);
      expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
      expect((await control()).providerRequests).toBe(3);
      console.log("Actual Factory/controller/PostgreSQL recovery passed", {
        acceptedControllerPrompts,
        providerRequests: 3,
        commits: owned.commitCalls.length,
      });
    } finally {
      await owned.dispose();
    }
    // Seed Factory's actual dispatched intent/expired lease, then recover a
    // real pinned queued admission. This is controller/SQL proof, not an HTTP
    // admission crash or a Factory server process kill.
    const queuedOwned = await fixture();
    try {
      await client.session.create({ ...input, id: queuedOwned.sessionID });
      const admission = createChangeAdmission(queuedOwned.database, buildModelID);
      const { turn } = await admission.admit(queuedOwned.changeID, queuedOwned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Reply with the queued recovery proof only. Do not use tools.",
      });
      const store = createAgentTurnStore(queuedOwned.database);
      const claimed = await store.claimPending(turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned queued dispatch required");
      await store.beginDispatch(turn.id, claimed.ownerToken);
      await queuedOwned.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id = ${queuedOwned.attemptID} WHERE turn_id = ${turn.id}`;
      await queuedOwned.database.client`UPDATE factory.change_agent_session
        SET state = 'starting', active_turn_id = ${turn.id} WHERE change_id = ${queuedOwned.changeID}`;
      await queuedOwned.database.client`UPDATE factory.agent_turn
        SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${turn.id}`;
      const intent = await admission.intent(turn.id);
      const queued = await client.session.prompt({
        sessionID: intent.sessionID,
        id: intent.promptID,
        text: intent.text,
        delivery: "queue",
        resume: false,
      });
      expect(decodeOpenCodeAdmission(queued, intent).state).toBe("queued");
      expect(
        (await client.message.list({ sessionID: intent.sessionID, limit: 100 })).data,
      ).toHaveLength(0);
      expect((await control()).providerRequests).toBe(3);
      let recoveryAdmissions = 0;
      let recoveryWakes = 0;
      queuedOwned.hub.request = async (_attemptID, _channel, request, path) => {
        if (path.endsWith("/prompt")) {
          const body = (await request.clone().json()) as { resume: boolean };
          if (body.resume) recoveryWakes += 1;
          else recoveryAdmissions += 1;
        }
        return transport(request, path);
      };
      await Promise.all([queuedOwned.controller().recover(), queuedOwned.controller().recover()]);
      await until(
        () => queuedOwned.controller().get(queuedOwned.changeID),
        (view) => view.state === "committed",
      );
      expect((await queuedOwned.turn(turn.commandId))?.state).toBe("completed");
      expect(recoveryAdmissions).toBeGreaterThan(0);
      expect(recoveryWakes).toBe(1);
      expect((await control()).providerRequests).toBe(4);
      expect(queuedOwned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
      await queuedOwned.controller().recover();
      expect(recoveryWakes).toBe(1);
      expect((await control()).providerRequests).toBe(4);
      console.log("Actual queued admission/controller/PostgreSQL recovery passed", {
        recoveryAdmissions,
        recoveryWakes,
        providerRequests: 4,
      });
    } finally {
      // The losing recovery controller observes another live owner's lease
      // on a one-second interval. Let it observe the terminal decision before
      // ending this isolated SQL pool; completion does not join that observer.
      await queuedOwned.controller().stop(queuedOwned.changeID);
      await queuedOwned.dispose();
    }

    const stopOwned = await fixture();
    const interruptEntered = Promise.withResolvers<void>();
    const releaseInterrupt = Promise.withResolvers<void>();
    let heldStop: Promise<unknown> | undefined;
    let interruptHeld = false;
    let stopPrompts = 0;
    try {
      await control("/hold", "POST");
      await client.session.create({ ...input, id: stopOwned.sessionID });
      stopOwned.hub.request = async (_attemptID, _channel, request, path) => {
        if (path.endsWith("/interrupt") && !interruptHeld) {
          interruptHeld = true;
          interruptEntered.resolve();
          await releaseInterrupt.promise;
        }
        if (path.endsWith("/prompt")) stopPrompts += 1;
        return transport(request, path);
      };
      const firstCommand = crypto.randomUUID();
      await stopOwned
        .controller()
        .prompt(
          stopOwned.changeID,
          "Reply with the stopped process proof only. Do not use tools.",
          stopOwned.userID,
          firstCommand,
        );
      await until(
        () => control(),
        (state) => state.providerRequests === 5,
      );
      heldStop = stopOwned.controller().stop(stopOwned.changeID);
      await interruptEntered.promise;
      const blockedCommand = crypto.randomUUID();
      await expect(
        stopOwned
          .controller()
          .prompt(
            stopOwned.changeID,
            "Must not reach this retained Session",
            stopOwned.userID,
            blockedCommand,
          ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await stopOwned.turn(blockedCommand)).toBeUndefined();
      expect(stopPrompts).toBe(1);
      expect((await control()).providerRequests).toBe(5);
      releaseInterrupt.resolve();
      await heldStop;
      expect((await stopOwned.controller().get(stopOwned.changeID)).stopPending).toBe(false);
      expect((await stopOwned.turn(firstCommand))?.state).toBe("stopped");
      const nextCommand = crypto.randomUUID();
      await stopOwned
        .controller()
        .prompt(
          stopOwned.changeID,
          "Reply with the resumed process proof only. Do not use tools.",
          stopOwned.userID,
          nextCommand,
        );
      await until(
        () => control(),
        (state) => state.providerRequests === 6,
      );
      expect(stopPrompts).toBe(2);
      await control("/release", "POST");
      await until(
        () => stopOwned.controller().get(stopOwned.changeID),
        (view) => view.state === "committed" && view.turn?.commandId === nextCommand,
      );
      expect((await stopOwned.turn(nextCommand))?.state).toBe("completed");
      expect(stopOwned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
      console.log("Pinned held Stop and acknowledged resume passed", {
        stopPrompts,
        providerRequests: 6,
        commits: stopOwned.commitCalls.length,
      });
    } finally {
      releaseInterrupt.resolve();
      await heldStop?.catch(() => undefined);
      await control("/release", "POST");
      await stopOwned.dispose();
    }
    console.log("Owned pinned process probe passed", {
      scratch,
      generation: (await control()).generation,
      providerRequests: (await control()).providerRequests,
    });
  } catch (cause) {
    console.error("Owned process diagnostics", await process.diagnostics());
    throw cause;
  } finally {
    await process.dispose();
  }
}, 120_000);
