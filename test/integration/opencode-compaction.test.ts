import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { classifyAgentTurn } from "../../apps/factory/src/agent/turn-outcome";
import { nativeInputSkills, nativeSkillManifest } from "../../apps/factory/src/skills/native";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import {
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
  syncOpenCodeInputGuidance,
} from "../../apps/factory/src/agent/opencode-client";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("native automatic summary compaction retains Factory policy and resumes the exact queued input once", async () => {
  const required = {
    id: crypto.randomUUID(),
    revision: 1,
    content: {
      ...requirementsInterviewSkill,
      key: "owned-compaction-rule",
      roles: ["build" as const],
      manualOnly: false,
      instructions: "Owned required Skill must be present before inference.",
    },
    digest: "a".repeat(64),
    published: true,
  };
  const owned = await pinnedOpenCode(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    nativeSkillManifest([required]),
    {
      modelID: buildModelID,
      package: "@opencode/ai/providers/openai/chat",
      settings: {},
      model: { limit: { context: 64_000, input: 48_000, output: 4_000 } },
    },
  );
  const sessionID = `ses_compaction_${crypto.randomUUID().replaceAll("-", "")}`;
  const warm = {
    sessionID,
    promptID: `msg_warm_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Reply briefly without tools.",
    bootstrap: false,
    skills: nativeInputSkills("Reply briefly without tools.", [required], [required.id]),
  };
  const next = {
    ...warm,
    promptID: `msg_next_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Finish the owned compaction proof. Reply briefly without tools.",
  };
  const inputIDs = [warm.promptID];
  async function outcome(input: typeof warm) {
    const [work, messages] = await Promise.all([
      observeOpenCodeWork(owned.client, sessionID),
      readOpenCodeInputMessages(owned.client, sessionID, input.promptID),
    ]);
    return classifyAgentTurn(
      messages.data.map((message) => ({
        id: message.id,
        type: message.type,
        created: message.time.created,
        ...(message.type === "assistant"
          ? { completed: message.time.completed, finish: message.finish, error: message.error }
          : {}),
      })),
      input.promptID,
      work.running,
    );
  }
  try {
    await owned.client.session.create({
      id: sessionID,
      title: "Owned automatic compaction proof",
      agent: "build",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await syncOpenCodeInputGuidance(owned.client, {
      ...warm,
      skillManifest: nativeSkillManifest([required]),
    });
    await owned.control("/release", "POST");
    await promptRecordedOpenCodeInput(owned.client, warm, true);
    await observe(
      () => outcome(warm),
      (result) => result.state === "succeeded",
    );
    expect((await owned.control()).providerRequests).toBe(1);
    // Only this owned fixture has a smaller model window. Exercise the native
    // threshold without sending long inputs to a paid provider.
    for (let index = 0; index < 10; index++) {
      const id = `msg_history_${crypto.randomUUID().replaceAll("-", "")}`;
      inputIDs.push(id);
      await owned.client.session.synthetic({
        sessionID,
        id,
        text: `Owned earlier context ${index}: ${"bounded historic fixture ".repeat(1_000)}`,
        delivery: "queue",
        resume: false,
      });
    }
    inputIDs.push(next.promptID);
    await promptRecordedOpenCodeInput(owned.client, next, true);
    await observe(
      () => outcome(next),
      (result) => result.state === "succeeded",
      "Native automatic compaction did not complete the queued input",
      30_000,
    );
    const outcomes: Array<{ type: string; reason: string }> = [];
    const delivered: string[] = [];
    for await (const event of owned.client.session.log({ sessionID, follow: false })) {
      if (event.type === "log.synced") break;
      if (event.type === "session.inbox.delivered") delivered.push(event.data.inboxID);
      if (event.type === "session.compaction.started" || event.type === "session.compaction.ended")
        outcomes.push({ type: event.type, reason: event.data.reason });
    }
    expect(outcomes).toContainEqual({ type: "session.compaction.ended", reason: "auto" });
    for (const id of inputIDs)
      expect(delivered.filter((deliveredID) => deliveredID === id)).toEqual([id]);
    expect((await promptRecordedOpenCodeInput(owned.client, next, false)).state).toBe("promoted");
    const state = await owned.control();
    expect(state.summaryRequests).toBeGreaterThan(0);
    expect(state.providerRequests).toBe(inputIDs.length + state.summaryRequests);
    expect(state.factoryPolicyRequests).toBe(inputIDs.length);
    expect(state.requiredSkillRequests).toBe(inputIDs.length);
    await Bun.write(
      resolve(".factory/test-results/opencode-roles-20261020/native-compaction.json"),
      JSON.stringify(
        { sessionID, modelID: buildModelID, inputIDs, delivered, outcomes, ...state },
        null,
        2,
      ),
    );
  } catch (cause) {
    console.log("Owned native compaction diagnostics", await owned.diagnostics());
    throw cause;
  } finally {
    await owned.dispose();
  }
}, 120_000);
