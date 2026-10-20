import { expect, test } from "bun:test";
import { classifyAgentTurn } from "../../apps/factory/src/agent/controller";
import {
  ensureOpenCodeMessageBoundary,
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
} from "../../apps/factory/src/agent/opencode-client";
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
