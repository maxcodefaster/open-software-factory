import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ensureOpenCodeMessageBoundary,
  listOpenCodeSessionTree,
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
  readOpenCodeWorkspace,
} from "../../apps/factory/src/agent/opencode-adapter";
import { classifyAgentTurn } from "../../apps/factory/src/agent/turn-outcome";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("native history beyond page one identifies the exact completed input without inference replay", async () => {
  const owned = await pinnedOpenCode();
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  const input = {
    sessionID,
    promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Reply briefly without tools.",
    bootstrap: false,
  };
  try {
    await owned.client.session.create({
      id: sessionID,
      title: "Owned paginated native history proof",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(owned.client, sessionID);
    await owned.control("/release", "POST");
    await promptRecordedOpenCodeInput(owned.client, input, true);
    await observe(
      () => owned.client.message.list({ sessionID, limit: 100 }),
      (page) =>
        page.data.some(
          (message) =>
            message.type === "assistant" &&
            Boolean(message.time.completed) &&
            message.finish === "stop",
        ),
    );
    expect((await owned.control()).providerRequests).toBe(1);
    // Metadata transitions generate real native records without more inference.
    for (let index = 0; index < 110; index++)
      await owned.client.session.switchAgent({
        sessionID,
        agent: index % 2 === 0 ? "plan" : "build",
      });
    const work = await observe(
      () => observeOpenCodeWork(owned.client, sessionID),
      (work) => !work.running,
    );
    const recent = await owned.client.message.list({ sessionID, limit: 100, order: "desc" });
    expect(recent.cursor.next).toBeDefined();
    expect(recent.data.some((message) => message.id === input.promptID)).toBe(false);
    const history = await readOpenCodeInputMessages(owned.client, sessionID, input.promptID);
    expect(history.data.length).toBeGreaterThan(100);
    expect(
      classifyAgentTurn(
        history.data.map((message) => ({
          id: message.id,
          type: message.type,
          created: message.time.created,
          ...(message.type === "assistant"
            ? {
                completed: message.time.completed,
                finish: message.finish,
                error: message.error,
              }
            : {}),
        })),
        input.promptID,
        work.running,
      ),
    ).toEqual({ state: "succeeded" });
    expect((await promptRecordedOpenCodeInput(owned.client, input, false)).state).toBe("promoted");
    expect((await owned.control()).providerRequests).toBe(1);
  } catch (cause) {
    console.log("Owned paginated history diagnostics", await owned.diagnostics());
    throw cause;
  } finally {
    await owned.dispose();
  }
}, 120_000);

test.each(["/workspaces/project", "/code/python/backend"])(
  "pinned native OpenCode retains default-location history and tool results at %s without inference on reads",
  async (directory) => {
    const owned = await pinnedOpenCode(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      directory,
    );
    const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const childID = `${sessionID}_child`;
    const input = {
      sessionID,
      promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Perform the owned shell tool once, then answer briefly.",
      bootstrap: false,
    };
    try {
      expect((await owned.control()).providerRequests).toBe(0);
      expect((await owned.client.location.get()).directory).toBe(directory);
      expect(await readOpenCodeWorkspace(owned.client)).toEqual({
        location: { directory },
        checkoutDirectory: directory,
      });
      // Do not pass a location override: the native server's real cwd owns it.
      const session = await owned.client.session.create({
        id: sessionID,
        title: "Owned actual-directory history proof",
        model: { providerID: "factory", id: buildModelID },
      });
      expect(session.location.directory).toBe(directory);
      expect((await owned.client.session.get({ sessionID })).location.directory).toBe(directory);
      const child = await owned.client.session.create({
        id: childID,
        parentID: sessionID,
        title: "Owned idle child at the actual directory",
        model: { providerID: "factory", id: buildModelID },
      });
      expect(child.location.directory).toBe(directory);
      expect(await listOpenCodeSessionTree(owned.client, sessionID)).toEqual([sessionID, childID]);
      await ensureOpenCodeMessageBoundary(owned.client, sessionID);
      expect((await owned.control()).providerRequests).toBe(0);
      // The controlled provider emits one real native shell call without paid keys.
      await owned.control("/tool-effect", "POST");
      await owned.control("/release", "POST");
      await promptRecordedOpenCodeInput(owned.client, input, true);
      await observe(
        () => readOpenCodeInputMessages(owned.client, sessionID, input.promptID),
        (page) =>
          page.data.some(
            (message) =>
              message.type === "assistant" &&
              Boolean(message.time.completed) &&
              message.finish === "stop",
          ),
      );
      await observe(
        () => observeOpenCodeWork(owned.client, sessionID),
        (work) => !work.running,
      );
      const before = await owned.control();
      expect(before.providerRequests).toBeGreaterThan(0);
      const history = await readOpenCodeInputMessages(owned.client, sessionID, input.promptID);
      const tools = history.data.flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      );
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ name: "shell", state: { status: "completed" } });
      expect(JSON.stringify(tools[0])).toContain("owned completed tool result");
      const sideEffect = resolve(owned.scratch, "project", "restart-side-effect.txt");
      expect(await readFile(sideEffect, "utf8")).toBe("once\n");
      expect(
        await Bun.file(resolve(owned.scratch, "project", ".git", "factory-opencode.db")).exists(),
      ).toBe(true);
      const completed = await owned.client.session.export({ sessionID, sanitize: false });
      expect((await owned.control()).providerRequests).toBe(before.providerRequests);
      await owned.control("/hold", "POST");
      expect((await owned.control("/kill", "POST")).running).toBe(false);
      await owned.control("/restart", "POST");
      await observe(
        () =>
          owned.client.model
            .list({ location: { directory } })
            .then(() => true)
            .catch(() => false),
        Boolean,
        "Owned actual-directory server did not become ready after restart",
        45_000,
      );
      // Native location, Session, tree and retained-message reads must neither
      // infer nor replay the completed tool after the actual server restarts.
      expect((await owned.client.location.get()).directory).toBe(directory);
      expect(await readOpenCodeWorkspace(owned.client)).toEqual({
        location: { directory },
        checkoutDirectory: directory,
      });
      expect((await owned.client.session.get({ sessionID })).location.directory).toBe(directory);
      expect(await listOpenCodeSessionTree(owned.client, sessionID)).toEqual([sessionID, childID]);
      expect(await observeOpenCodeWork(owned.client, sessionID)).toMatchObject({
        location: { directory },
        sessionIDs: [sessionID, childID],
        running: false,
      });
      const retained = await owned.client.session.export({ sessionID, sanitize: false });
      expect(retained.messages.map((message) => message.id)).toEqual(
        completed.messages.map((message) => message.id),
      );
      expect(await readOpenCodeInputMessages(owned.client, sessionID, input.promptID)).toEqual(
        history,
      );
      expect(await readFile(sideEffect, "utf8")).toBe("once\n");
      const after = await owned.control();
      expect(after.generation).toBe(before.generation + 1);
      expect(after.providerRequests).toBe(before.providerRequests);
      expect(after.heldRequests).toBe(0);
    } catch (cause) {
      console.log("Owned actual-directory history diagnostics", {
        directory,
        ...(await owned.diagnostics()),
      });
      throw cause;
    } finally {
      await owned.dispose();
    }
  },
  120_000,
);
