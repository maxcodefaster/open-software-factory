import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  cancelQueuedOpenCodeInput,
  confirmSettledOpenCodeInput,
  decodeOpenCodeAdmission,
  ensureOpenCodeMessageBoundary,
  interruptOpenCodeSession,
  promptRecordedOpenCodeInput,
} from "../../apps/factory/src/agent/opencode-client";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("native OpenCode 2 retains queued work through process loss, executes once and cancels without touching files", async () => {
  const process = await pinnedOpenCode();
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  const input = {
    sessionID,
    promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Reply briefly without tools.",
    bootstrap: false,
  };
  try {
    await process.client.session.create({
      id: sessionID,
      title: "Owned native Build proof",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(process.client, sessionID);
    expect(
      (await process.client.model.list({})).data.some(
        (model) => model.providerID === "factory" && model.id === buildModelID,
      ),
    ).toBe(true);
    expect((await promptRecordedOpenCodeInput(process.client, input, false)).state).toBe("queued");
    const queued = await process.client.session.inbox.list({ sessionID });
    expect(queued).toHaveLength(1);
    expect(decodeOpenCodeAdmission(queued[0], input).id).toBe(input.promptID);
    expect((await process.control()).providerRequests).toBe(0);
    const before = await process.control();
    await process.control("/kill", "POST");
    await process.control("/restart", "POST");
    await observe(
      () => process.client.server.info().catch(() => null),
      (value) => Boolean(value),
      "Owned native restart did not become ready",
      45_000,
    );
    await ensureOpenCodeMessageBoundary(process.client, sessionID);
    expect((await process.control()).generation).toBe(before.generation + 1);
    expect(await process.client.session.inbox.list({ sessionID })).toEqual(queued);
    await process.control("/release", "POST");
    await promptRecordedOpenCodeInput(process.client, input, true);
    await observe(
      () => process.client.message.list({ sessionID, limit: 100 }),
      (value) =>
        value.data.some((message) => message.type === "assistant" && message.time.completed),
    );
    expect((await process.control()).providerRequests).toBe(1);
    expect((await promptRecordedOpenCodeInput(process.client, input, false)).state).toBe(
      "promoted",
    );
    expect((await process.control()).providerRequests).toBe(1);
    const pending = { ...input, promptID: `${input.promptID}_cancel` };
    await promptRecordedOpenCodeInput(process.client, pending, false);
    const manual = resolve(process.scratch, "project", "manual.txt");
    await Bun.write(manual, "Developer draft must survive cancellation\n");
    expect(await interruptOpenCodeSession(process.client, sessionID)).toBe("interrupted");
    expect(await cancelQueuedOpenCodeInput(process.client, sessionID, pending.promptID)).toBe(true);
    expect(await readFile(manual, "utf8")).toBe("Developer draft must survive cancellation\n");
    expect(await confirmSettledOpenCodeInput(process.client, sessionID, pending.promptID)).toBe(
      true,
    );
    expect((await process.control()).providerRequests).toBe(1);
  } catch (cause) {
    console.log("Owned native recovery diagnostics", await process.diagnostics());
    throw cause;
  } finally {
    await process.dispose();
  }
}, 120_000);
