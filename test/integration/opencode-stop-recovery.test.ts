import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { ensureOpenCodeMessageBoundary } from "../../apps/factory/src/agent/opencode-client";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { connectorBoundary } from "../fixtures/connector-boundary";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

type Owned = Awaited<ReturnType<typeof fixture>>;
type Process = Awaited<ReturnType<typeof pinnedOpenCode>>;
type Boundary = Awaited<ReturnType<typeof connectorBoundary>>;

async function withEmptySession(
  run: (owned: Owned, boundary: Boundary, process: Process) => Promise<void>,
) {
  const process = await pinnedOpenCode();
  try {
    const owned = await fixture();
    let boundary: Boundary | undefined;
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
      if (!claimed?.ownerToken) throw new Error("Owned empty Session Turn claim required");
      await store.beginDispatch(turn.id, claimed.ownerToken);
      await owned.database.client`UPDATE factory.change_agent_turn_intent
        SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${turn.id}`;
      await owned.database.client`UPDATE factory.change_agent_session
        SET state = 'starting', active_turn_id = ${turn.id} WHERE change_id = ${owned.changeID}`;
      const boundaryClient = boundary.client;
      await observe(
        () => boundaryClient.model.list({ location: { directory: "/workspace/project" } }),
        (models) =>
          models.data.some((model) => model.providerID === "factory" && model.id === buildModelID),
        "Owned Session model did not become available",
      );
      await boundary.client.session.create({
        id: owned.sessionID,
        title: "Owned Stop before message boundary",
        location: { directory: "/workspace/project" },
        model: { providerID: "factory", id: buildModelID },
      });
      expect(
        (await boundary.client.message.list({ sessionID: owned.sessionID, limit: 1 })).data,
      ).toEqual([]);
      await run(owned, boundary, process);
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
}

async function completeLaterStart(owned: Owned, process: Process, previousRequests = 0) {
  expect((await process.control()).providerRequests).toBe(previousRequests);
  await process.control("/release", "POST");
  const nextCommand = crypto.randomUUID();
  await owned.controller().start(owned.changeID, owned.userID, nextCommand);
  await observe(
    () => owned.controller().get(owned.changeID),
    (current) => current.state === "committed",
    "Owned later Start did not commit",
  );
  expect((await owned.turn(nextCommand))?.state).toBe("completed");
  expect((await process.control()).providerRequests).toBe(previousRequests + 1);
}

test("Stop on an empty native Session confirms without inference and permits a later Start", async () => {
  await withEmptySession(async (owned, _boundary, process) => {
    const view = await owned.controller().stop(owned.changeID);
    expect(view.stopPending).toBe(false);
    expect(view.state).toBe("stopped");
    await completeLaterStart(owned, process);
  });
}, 60_000);

test("lost native interrupt response recovers an empty Session without repeating interrupt", async () => {
  await withEmptySession(async (owned, boundary, process) => {
    let interrupts = 0;
    owned.hub.request = async (...args) => {
      const response = await boundary.hub.request(...args);
      if (args[3].endsWith("/interrupt")) {
        interrupts += 1;
        await response.arrayBuffer();
        throw new Error("Owned loss after native interruption");
      }
      return response;
    };
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    await expect(stop.confirm(owned.changeID)).rejects.toThrow("Transport");
    expect((await owned.controller().get(owned.changeID)).stopPending).toBe(true);
    expect(await stop.confirm(owned.changeID)).toBe(true);
    expect(interrupts).toBe(1);
    expect((await owned.controller().get(owned.changeID)).stopPending).toBe(false);
    await completeLaterStart(owned, process);
  });
}, 60_000);

test.each(["before-prompt", "promoted"] as const)(
  "lost interrupt response recovers nonempty native Session without replay: %s",
  async (state) => {
    await withEmptySession(async (owned, boundary, process) => {
      await ensureOpenCodeMessageBoundary(boundary.client, owned.sessionID);
      const turns = await owned.database.client<Array<{ promptID: string; text: string }>>`
        SELECT intent.prompt_id AS "promptID", intent.prompt_text AS text
        FROM factory.change_agent_turn_intent intent
        JOIN factory.change_agent_session session ON session.active_turn_id = intent.turn_id
        WHERE session.change_id = ${owned.changeID}`;
      const input = turns[0];
      if (!input) throw new Error("Owned assigned input required");
      if (state === "promoted") {
        await boundary.client.session.prompt({
          sessionID: owned.sessionID,
          id: `msg_warmup_${crypto.randomUUID().replaceAll("-", "")}`,
          text: "Retain this completed history. Reply without tools.",
          delivery: "queue",
          resume: true,
        });
        await observe(
          process.control,
          (current) => current.providerRequests === 1,
          "Owned promoted Stop warmup did not reach the provider",
        );
        await process.control("/release", "POST");
        await observe(
          () => boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 }),
          (messages) =>
            messages.data.some(
              (message) => message.type === "assistant" && !!message.time.completed,
            ),
          "Owned promoted Stop warmup did not complete",
        );
        await process.control("/hold", "POST");
        await boundary.client.session.prompt({
          sessionID: owned.sessionID,
          id: input.promptID,
          text: input.text,
          delivery: "queue",
          resume: true,
        });
        await observe(
          process.control,
          (current) => current.providerRequests === 2,
          "Owned promoted Stop input did not reach the held provider",
        );
        expect(
          (
            await boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 })
          ).data.some((message) => message.id === input.promptID),
        ).toBe(true);
      }
      const retained = resolve(process.scratch, "project", "retained.txt");
      await Bun.write(retained, "Developer edits survive promoted Stop\n");
      const mutations: string[] = [];
      owned.hub.request = async (...args) => {
        if (args[2].method === "POST") mutations.push(args[3]);
        const response = await boundary.hub.request(...args);
        if (args[3].endsWith("/interrupt")) {
          await response.arrayBuffer();
          throw new Error("Owned lost nonempty native interruption response");
        }
        return response;
      };
      const stop = createChangeAgentStop(owned.database, owned.hub);
      await stop.persist(owned.changeID);
      await expect(stop.confirm(owned.changeID)).rejects.toThrow("Transport");
      expect((await owned.controller().get(owned.changeID)).stopPending).toBe(true);
      expect(await stop.confirm(owned.changeID)).toBe(true);
      expect(mutations).toEqual([`/api/session/${owned.sessionID}/interrupt`]);
      expect(await Bun.file(retained).text()).toBe("Developer edits survive promoted Stop\n");
      const before = await boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 });
      expect(before.data.some((message) => message.id === input.promptID)).toBe(
        state === "promoted",
      );
      await completeLaterStart(owned, process, state === "promoted" ? 2 : 0);
      const after = await boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 });
      expect(after.data.some((message) => message.id === input.promptID)).toBe(
        state === "promoted",
      );
    });
  },
  60_000,
);

test("lost native cancellation response recovers queued Stop without replaying mutations", async () => {
  await withEmptySession(async (owned, boundary, process) => {
    await ensureOpenCodeMessageBoundary(boundary.client, owned.sessionID);
    const previousPrompt = `msg_previous_${crypto.randomUUID().replaceAll("-", "")}`;
    await boundary.client.session.prompt({
      sessionID: owned.sessionID,
      id: previousPrompt,
      text: "Retain this prior completed input. Reply without tools.",
      delivery: "queue",
      resume: true,
    });
    await process.control("/release", "POST");
    await observe(
      () => boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 }),
      (messages) =>
        messages.data.some((message) => message.type === "assistant" && !!message.time.completed),
    );
    const before = await boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 });
    expect(before.data.some((message) => message.id === previousPrompt)).toBe(true);
    const turns = await owned.database.client<Array<{ promptID: string; text: string }>>`
      SELECT intent.prompt_id AS "promptID", intent.prompt_text AS text
      FROM factory.change_agent_turn_intent intent
      JOIN factory.change_agent_session session ON session.active_turn_id = intent.turn_id
      WHERE session.change_id = ${owned.changeID}`;
    const input = turns[0];
    if (!input) throw new Error("Owned assigned input required");
    await boundary.client.session.prompt({
      sessionID: owned.sessionID,
      id: input.promptID,
      text: input.text,
      delivery: "queue",
      resume: false,
    });
    const retained = resolve(process.scratch, "project", "retained.txt");
    await Bun.write(retained, "Developer edits survive lost cancellation response\n");
    const mutations: string[] = [];
    owned.hub.request = async (...args) => {
      if (["POST", "DELETE"].includes(args[2].method)) mutations.push(args[3]);
      const response = await boundary.hub.request(...args);
      if (args[2].method === "DELETE" && args[3].endsWith(`/inbox/${input.promptID}`)) {
        await response.arrayBuffer();
        throw new Error("Owned loss after native Inbox cancellation");
      }
      return response;
    };
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    await expect(stop.confirm(owned.changeID)).rejects.toThrow("Transport");
    expect((await owned.controller().get(owned.changeID)).stopPending).toBe(true);
    expect(mutations).toEqual([
      `/api/session/${owned.sessionID}/interrupt`,
      `/api/session/${owned.sessionID}/inbox/${input.promptID}`,
    ]);
    expect(await stop.confirm(owned.changeID)).toBe(true);
    expect(mutations).toHaveLength(2);
    expect((await owned.controller().get(owned.changeID)).stopPending).toBe(false);
    expect(
      (await boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 })).data,
    ).toEqual(before.data);
    expect(await Bun.file(retained).text()).toBe(
      "Developer edits survive lost cancellation response\n",
    );
    await completeLaterStart(owned, process, 1);
    const after = await boundary.client.message.list({ sessionID: owned.sessionID, limit: 100 });
    expect(after.data.some((message) => message.id === input.promptID)).toBe(false);
    expect(after.data.some((message) => message.id === previousPrompt)).toBe(true);
  });
}, 60_000);

test("lost cancellation before native acceptance retains the queue and never repeats Stop mutations", async () => {
  await withEmptySession(async (owned, boundary, process) => {
    await ensureOpenCodeMessageBoundary(boundary.client, owned.sessionID);
    const turns = await owned.database.client<Array<{ promptID: string; text: string }>>`
      SELECT intent.prompt_id AS "promptID", intent.prompt_text AS text
      FROM factory.change_agent_turn_intent intent
      JOIN factory.change_agent_session session ON session.active_turn_id = intent.turn_id
      WHERE session.change_id = ${owned.changeID}`;
    const input = turns[0];
    if (!input) throw new Error("Owned assigned input required");
    await boundary.client.session.prompt({
      sessionID: owned.sessionID,
      id: input.promptID,
      text: input.text,
      delivery: "queue",
      resume: false,
    });
    const mutations: string[] = [];
    owned.hub.request = async (...args) => {
      if (["POST", "DELETE"].includes(args[2].method)) mutations.push(args[3]);
      if (args[2].method === "DELETE" && args[3].endsWith(`/inbox/${input.promptID}`))
        throw new Error("Owned loss before native Inbox cancellation");
      return boundary.hub.request(...args);
    };
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    await expect(stop.confirm(owned.changeID)).rejects.toThrow("Transport");
    expect(await stop.confirm(owned.changeID)).toBe(false);
    expect(await stop.confirm(owned.changeID)).toBe(false);
    expect(mutations).toEqual([
      `/api/session/${owned.sessionID}/interrupt`,
      `/api/session/${owned.sessionID}/inbox/${input.promptID}`,
    ]);
    expect(
      (await boundary.client.session.inbox.list({ sessionID: owned.sessionID })).map(
        (item) => item.id,
      ),
    ).toEqual([input.promptID]);
    expect(
      (await boundary.client.session.get({ sessionID: owned.sessionID })).revert,
    ).toBeUndefined();
    expect((await owned.controller().get(owned.changeID)).stopPending).toBe(true);
    await expect(
      createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toHaveProperty("code", "conflict");
    expect((await process.control()).providerRequests).toBe(0);
  });
}, 60_000);

test.each(["empty", "nonempty"] as const)(
  "%s-Session recovery fences an original Stop held before frame send",
  async (state) => {
    await withEmptySession(async (owned, boundary, process) => {
      if (state === "nonempty")
        await ensureOpenCodeMessageBoundary(boundary.client, owned.sessionID);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let interruptFrames = 0;
      let held = true;
      owned.hub.request = async (attempt, channel, request, path, beforeSend) => {
        if (held && path.endsWith("/interrupt")) {
          return boundary.hub.request(attempt, channel, request, path, async (send) => {
            entered.resolve();
            await release.promise;
            if (!beforeSend) throw new Error("Owned Stop must have a frame-send guard");
            await beforeSend(() => {
              interruptFrames += 1;
              send();
            });
          });
        }
        return boundary.hub.request(attempt, channel, request, path, beforeSend);
      };
      const stop = createChangeAgentStop(owned.database, owned.hub);
      await stop.persist(owned.changeID);
      const original = stop.confirm(owned.changeID).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await entered.promise;
        expect(await stop.confirm(owned.changeID)).toBe(true);
        expect((await owned.controller().get(owned.changeID)).stopPending).toBe(false);
        await completeLaterStart(owned, process);
        held = false;
        release.resolve();
        const outcome = await original;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok)
          expect(outcome.error).toHaveProperty(
            "cause.message",
            "Stop authority changed before dispatch",
          );
        expect(interruptFrames).toBe(0);
        expect((await owned.controller().get(owned.changeID)).state).toBe("committed");
      } finally {
        held = false;
        release.resolve();
        await original;
      }
    });
  },
  60_000,
);

test("a native queued input without messages is not an empty-Session recovery proof", async () => {
  await withEmptySession(async (owned, boundary, process) => {
    const turns = await owned.database.client<Array<{ promptID: string; text: string }>>`
      SELECT intent.prompt_id AS "promptID", intent.prompt_text AS text
      FROM factory.change_agent_turn_intent intent
      JOIN factory.change_agent_session session ON session.active_turn_id = intent.turn_id
      WHERE session.change_id = ${owned.changeID}`;
    const input = turns[0];
    if (!input) throw new Error("Owned assigned input required");
    await boundary.client.session.prompt({
      sessionID: owned.sessionID,
      id: input.promptID,
      text: input.text,
      delivery: "queue",
      resume: false,
    });
    expect(
      (await boundary.client.message.list({ sessionID: owned.sessionID, limit: 1 })).data,
    ).toEqual([]);
    let interrupts = 0;
    owned.hub.request = async (...args) => {
      if (args[3].endsWith("/interrupt")) interrupts += 1;
      return boundary.hub.request(...args);
    };
    const stop = createChangeAgentStop(owned.database, owned.hub);
    await stop.persist(owned.changeID);
    expect(await stop.confirm(owned.changeID)).toBe(false);
    expect(await stop.confirm(owned.changeID)).toBe(false);
    expect(interrupts).toBe(1);
    expect((await owned.controller().get(owned.changeID)).stopPending).toBe(true);
    await expect(
      createChangeAdmission(owned.database, buildModelID).admit(owned.changeID, owned.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toHaveProperty("code", "conflict");
    expect((await process.control()).providerRequests).toBe(0);
  });
}, 60_000);
