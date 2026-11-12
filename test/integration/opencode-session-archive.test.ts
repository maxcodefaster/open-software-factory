import { expect, test } from "bun:test";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  cancelQueuedOpenCodeInput,
  confirmSettledOpenCodeInput,
  ensureOpenCodeMessageBoundary,
  interruptOpenCodeSession,
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
} from "../../apps/factory/src/agent/opencode-client";
import {
  importNativeSessionArchive,
  readNativeSessionArchive,
  saveNativeSessionArchive,
} from "../../apps/factory/src/agent/session-archive";
import { buildModelID } from "../fixtures/change-agent-turns";
import { docker, observe, pinnedOpenCode } from "../fixtures/pinned-opencode";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { retainedArchiveObjects } from "../fixtures/retained-archive-objects";

test("pinned native export/import preserves completed conversation and tool results without executing history", async () => {
  const producer = await pinnedOpenCode();
  let replacement: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  const input = {
    sessionID,
    promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Perform the owned tool then answer briefly.",
    bootstrap: false,
  };
  let storage: Awaited<ReturnType<typeof retainedArchiveObjects>> | undefined;
  let failure: unknown;
  try {
    expect(
      await docker(
        "exec",
        producer.container,
        "node",
        "-e",
        "console.log(require('/opt/factory/opencode/server/node_modules/@opencode/server/package.json').version)",
      ),
    ).toBe("2.0.27");
    const namespace = process.env["FACTORY_ARCHIVE_TEST_NAMESPACE"];
    storage = namespace ? await retainedArchiveObjects(namespace) : undefined;
    const objects = storage?.objects ?? memoryPrivateObjects();
    const source = resolve(producer.scratch, "project", "uncommitted.txt");
    await Bun.write(source, "Owned available uncommitted Source\n");
    await producer.client.session.create({
      id: sessionID,
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(producer.client, sessionID);
    await producer.control("/tool", "POST");
    await producer.control("/release", "POST");
    await promptRecordedOpenCodeInput(producer.client, input, true);
    await observe(
      () => observeOpenCodeWork(producer.client, sessionID),
      (work) => !work.running,
    );
    // A real native shell result has an observable side effect. Import must not
    // repeat this command into the replacement filesystem.
    await producer.client.session.shell({
      sessionID,
      command: "printf 'once\\n' >> side-effect.txt; printf 'confirmed owned result'",
    });
    await observe(
      () => producer.client.message.list({ sessionID, limit: 100 }),
      (page) =>
        page.data.some((message) => message.type === "shell" && message.status === "exited"),
    );
    const raw = await producer.client.session.export({ sessionID, sanitize: false });
    const sanitized = await producer.client.session.export({ sessionID, sanitize: true });
    console.info("Owned native transfer output availability", {
      rawShellOutputs: raw.messages.filter(
        (message) => message.type === "shell" && message.output !== undefined,
      ).length,
      sanitizedShellOutputs: sanitized.messages.filter(
        (message) => message.type === "shell" && message.output !== undefined,
      ).length,
    });
    const saved = await saveNativeSessionArchive(
      producer.client,
      objects,
      {
        turnID: crypto.randomUUID(),
        runtimeAttemptID: crypto.randomUUID(),
        sessionID,
        promptID: input.promptID,
      },
      { revision: "a".repeat(40), availableUncommittedFile: "uncommitted.txt" },
    );
    expect(saved.manifest.producer.version).toBe("2.0.27");
    expect(saved.summary.tools.some((tool) => tool.name === "shell" && tool.completed === 1)).toBe(
      true,
    );
    const restored = await readNativeSessionArchive(objects, saved.key, saved.manifestSHA256);
    expect(
      restored.native.messages.some(
        (message) => message.type === "user" && message.text === input.text,
      ),
    ).toBe(true);
    expect(
      restored.native.messages.some(
        (message) =>
          message.type === "shell" && message.output?.output.includes("confirmed owned result"),
      ),
    ).toBe(true);
    expect(
      restored.native.messages.some(
        (message) => message.type === "shell" && message.status === "exited" && message.exit === 0,
      ),
    ).toBe(true);
    expect(
      restored.native.messages.some(
        (message) =>
          message.type === "assistant" &&
          message.content.some(
            (part) =>
              part.type === "tool" &&
              part.state.status === "completed" &&
              part.state.content.length > 0,
          ),
      ),
    ).toBe(true);
    replacement = await pinnedOpenCode();
    // Existing durable Source, not container state or credentials, prepares the
    // fresh fixture. No claim that this is the production cross-node Source path.
    await copyFile(source, resolve(replacement.scratch, "project", "uncommitted.txt"));
    expect((await replacement.control()).providerRequests).toBe(0);
    const imported = await importNativeSessionArchive(replacement.client, restored.native);
    expect(imported.id).toBe(sessionID);
    expect((await replacement.control()).providerRequests).toBe(0);
    expect((await observeOpenCodeWork(replacement.client, sessionID)).running).toBe(false);
    expect(await replacement.client.session.inbox.list({ sessionID })).toEqual([]);
    const history = await replacement.client.session.export({ sessionID });
    expect(history.messages.map((message) => message.id)).toEqual(
      restored.native.messages.map((message) => message.id),
    );
    expect(
      history.messages.some((message) => message.type === "user" && message.text === input.text),
    ).toBe(true);
    expect(
      history.messages.some(
        (message) =>
          message.type === "shell" && message.output?.output.includes("confirmed owned result"),
      ),
    ).toBe(true);
    expect(await readFile(resolve(replacement.scratch, "project", "uncommitted.txt"), "utf8")).toBe(
      "Owned available uncommitted Source\n",
    );
    expect(
      await Bun.file(resolve(replacement.scratch, "project", "side-effect.txt")).exists(),
    ).toBe(false);
    await replacement.control("/release", "POST");
    // The only inference in the replacement follows this explicit Continue.
    await promptRecordedOpenCodeInput(
      replacement.client,
      {
        ...input,
        promptID: `${input.promptID}_continue`,
        text: "Continue explicitly. Keep prior results; do not run tools.",
      },
      true,
    );
    const continued = replacement;
    await observe(
      () => continued.client.session.active(),
      (active) => !Object.hasOwn(active, sessionID),
    );
    expect((await replacement.control()).providerRequests).toBe(1);
    expect(
      await Bun.file(resolve(replacement.scratch, "project", "side-effect.txt")).exists(),
    ).toBe(false);
    expect(await readFile(resolve(producer.scratch, "project", "side-effect.txt"), "utf8")).toBe(
      "once\n",
    );
    // Failure never changes the last successfully saved object pointer.
    await expect(
      saveNativeSessionArchive(
        producer.client,
        {
          ...objects,
          put: async () => {
            throw new Error("Owned write failure");
          },
        },
        {
          ...saved.manifest.checkpoint,
          turnID: crypto.randomUUID(),
        },
        saved.manifest.source,
      ),
    ).rejects.toThrow("Owned write failure");
    expect(
      (await readNativeSessionArchive(objects, saved.key, saved.manifestSHA256)).manifest,
    ).toEqual(saved.manifest);
  } catch (cause) {
    failure = cause;
  }
  const cleanup = await Promise.allSettled([
    storage?.dispose(),
    replacement?.dispose(),
    producer.dispose(),
  ]);
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...failures.map((result) => result.reason)],
      "Owned archive cleanup is unconfirmed",
    );
  if (failure) throw failure;
}, 180_000);

test("pinned restart keeps an unrelated synthetic notification as a Stop barrier after exact user-input cancellation", async () => {
  const producer = await pinnedOpenCode();
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  const queued = {
    sessionID,
    promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Keep this user input queued.",
    bootstrap: false,
  };
  try {
    await producer.client.session.create({
      id: sessionID,
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(producer.client, sessionID);
    // The standalone user-shell API deliberately leaves a synthetic notification
    // queued. It is not the Factory input we are subsequently authorized to cancel.
    await producer.client.session.shell({
      sessionID,
      command: "printf 'once\\n' >> synthetic-side-effect.txt; printf 'owned user shell result'",
    });
    const pending = await producer.client.session.inbox.list({ sessionID });
    expect(pending.some((input) => input.type === "synthetic")).toBe(true);
    const syntheticIDs = pending
      .filter((input) => input.type === "synthetic")
      .map((input) => input.id);
    await promptRecordedOpenCodeInput(producer.client, queued, false);
    const before = await producer.control();
    expect(before.providerRequests).toBe(0);
    await producer.control("/kill", "POST");
    await producer.control("/restart", "POST");
    await observe(
      async () =>
        producer.client.server
          .info()
          .then(() => true)
          .catch(() => false),
      Boolean,
      "Owned retained server did not become ready",
    );
    await ensureOpenCodeMessageBoundary(producer.client, sessionID);
    expect(await interruptOpenCodeSession(producer.client, sessionID)).toBe("interrupted");
    expect(await cancelQueuedOpenCodeInput(producer.client, sessionID, queued.promptID)).toBe(
      false,
    );
    const retained = await producer.client.session.inbox.list({ sessionID });
    expect(retained.some((input) => input.id === queued.promptID)).toBe(false);
    expect(retained.filter((input) => input.type === "synthetic").map((input) => input.id)).toEqual(
      syntheticIDs,
    );
    expect(await confirmSettledOpenCodeInput(producer.client, sessionID, queued.promptID)).toBe(
      false,
    );
    expect((await producer.control()).providerRequests).toBe(0);
    expect(
      await readFile(resolve(producer.scratch, "project", "synthetic-side-effect.txt"), "utf8"),
    ).toBe("once\n");
  } finally {
    await producer.dispose();
  }
}, 180_000);

test("pinned cold server restart preserves queued input without treating idle compute as Stop confirmation or replaying completed tools", async () => {
  const producer = await pinnedOpenCode();
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  const initial = {
    sessionID,
    promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Perform the owned shell tool once, then answer briefly.",
    bootstrap: false,
  };
  const queued = {
    ...initial,
    promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Queued work must wait for an explicit decision.",
  };
  try {
    await producer.client.session.create({
      id: sessionID,
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(producer.client, sessionID);
    await producer.control("/tool-effect", "POST");
    await producer.control("/release", "POST");
    await promptRecordedOpenCodeInput(producer.client, initial, true);
    await observe(
      () => producer.control(),
      (state) => state.providerRequests > 0,
    );
    await observe(
      () => observeOpenCodeWork(producer.client, sessionID),
      (work) => !work.running,
    );
    await observe(
      () => producer.client.message.list({ sessionID, limit: 100 }),
      (page) =>
        page.data.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some(
              (part) => part.type === "tool" && part.state.status === "completed",
            ),
        ),
    );
    await observe(
      () => observeOpenCodeWork(producer.client, sessionID),
      (work) => !work.running,
    );
    const completed = await producer.client.session.export({ sessionID, sanitize: false });
    expect(await producer.client.session.inbox.list({ sessionID })).toHaveLength(0);
    expect(
      completed.messages.some(
        (message) =>
          message.type === "assistant" &&
          message.content.some(
            (part) =>
              part.type === "tool" &&
              part.state.status === "completed" &&
              JSON.stringify(part.state.content).includes("owned completed tool result"),
          ),
      ),
    ).toBe(true);
    const requests = (await producer.control()).providerRequests;
    expect(requests).toBeGreaterThan(0);
    await producer.control("/hold", "POST");
    expect((await promptRecordedOpenCodeInput(producer.client, queued, false)).state).toBe(
      "queued",
    );
    expect(await confirmSettledOpenCodeInput(producer.client, sessionID, queued.promptID)).toBe(
      false,
    );
    const before = await producer.control();
    expect(before.providerRequests).toBe(requests);
    await producer.control("/kill", "POST");
    expect((await producer.control()).running).toBe(false);
    await producer.control("/restart", "POST");
    await observe(
      async () =>
        producer.client.server
          .info()
          .then(() => true)
          .catch(() => false),
      Boolean,
      "Owned cold server did not become ready",
    );
    // These are the same read-only activation/history probes used by Factory.
    // None may grant permission to execute a persisted queued input.
    await ensureOpenCodeMessageBoundary(producer.client, sessionID);
    const after = await producer.control();
    expect(after.generation).toBe(before.generation + 1);
    expect(after.providerRequests).toBe(requests);
    expect((await observeOpenCodeWork(producer.client, sessionID)).running).toBe(false);
    expect(
      (await producer.client.session.inbox.list({ sessionID })).some(
        (input) => input.id === queued.promptID,
      ),
    ).toBe(true);
    expect(await confirmSettledOpenCodeInput(producer.client, sessionID, queued.promptID)).toBe(
      false,
    );
    const history = await producer.client.session.export({ sessionID, sanitize: false });
    expect(history.messages.map((message) => message.id)).toEqual(
      completed.messages.map((message) => message.id),
    );
    const sideEffect = resolve(producer.scratch, "project", "restart-side-effect.txt");
    expect(await readFile(sideEffect, "utf8")).toBe("once\n");
    // Keep the existing ordered interrupt/cancellation contract even though
    // compute is idle. Restart alone is not an input-settlement proof.
    expect(await interruptOpenCodeSession(producer.client, sessionID)).toBe("interrupted");
    const canceled = await cancelQueuedOpenCodeInput(producer.client, sessionID, queued.promptID);
    if (!canceled) {
      const current = await observeOpenCodeWork(producer.client, sessionID);
      console.info("Owned cold-queue cancellation observation", {
        queued: (await producer.client.session.inbox.list({ sessionID })).map((input) => ({
          id: input.id,
          type: input.type,
          target: input.id === queued.promptID,
        })),
        hasRevert: Boolean((await producer.client.session.get({ sessionID })).revert),
        running: current.running,
        unknownShell: current.unknownShell,
        shells: current.shells.length,
        providerRequests: (await producer.control()).providerRequests,
      });
      // Mutation acknowledgment is not settlement. Observe only; never repeat
      // the interrupt/cancel when its outcome is still uncertain.
      await observe(
        () => confirmSettledOpenCodeInput(producer.client, sessionID, queued.promptID),
        Boolean,
        "Owned queued input did not settle after its single cancellation",
      );
    }
    expect(await confirmSettledOpenCodeInput(producer.client, sessionID, queued.promptID)).toBe(
      true,
    );
    expect((await producer.control()).providerRequests).toBe(requests);
    await producer.control("/release", "POST");
    await promptRecordedOpenCodeInput(
      producer.client,
      {
        ...initial,
        promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
        text: "Continue explicitly without tools. Preserve the recorded completed result.",
      },
      true,
    );
    await observe(
      () => producer.control(),
      (state) => state.providerRequests === requests + 1,
    );
    await observe(
      () => observeOpenCodeWork(producer.client, sessionID),
      (work) => !work.running,
    );
    expect((await producer.control()).providerRequests).toBe(requests + 1);
    expect(await readFile(sideEffect, "utf8")).toBe("once\n");
  } finally {
    await producer.dispose();
  }
}, 180_000);
