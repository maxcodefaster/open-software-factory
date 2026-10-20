import { expect, test } from "bun:test";
import {
  nativeInputSkills,
  nativeSkillId,
  nativeSkillManifest,
  observedNativeSkillIds,
} from "../../apps/factory/src/skills/native";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import {
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
  syncOpenCodeInputGuidance,
} from "../../apps/factory/src/agent/opencode-client";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("native Build loads required guidance and Factory system policy before inference", async () => {
  const required = {
    id: crypto.randomUUID(),
    revision: 1,
    content: {
      ...requirementsInterviewSkill,
      key: "owned-required-rule",
      roles: ["build" as const],
      manualOnly: false,
      instructions: "Owned required Skill must be present before inference.",
    },
    digest: "a".repeat(64),
    published: true,
  };
  const optional = {
    ...required,
    id: crypto.randomUUID(),
    content: {
      ...required.content,
      key: "owned-optional-rule",
      instructions: "Optional guidance remains available on demand.",
    },
  };
  const revisions = [required, optional];
  const owned = await pinnedOpenCode(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    nativeSkillManifest(revisions),
  );
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  const input = {
    sessionID,
    promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Return a brief answer without using tools.",
    bootstrap: false,
    skills: nativeInputSkills("Return a brief answer without using tools.", revisions, [
      required.id,
    ]),
  };
  try {
    await owned.client.session.create({
      id: sessionID,
      title: "Owned required Skill proof",
      agent: "build",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        ...revisions.map((revision) => ({
          action: "skill",
          resource: nativeSkillId(revision),
          effect: "allow" as const,
        })),
      ],
    });
    await syncOpenCodeInputGuidance(owned.client, {
      ...input,
      skillManifest: nativeSkillManifest(revisions),
    });
    await promptRecordedOpenCodeInput(owned.client, input, true);
    const before = await observe(
      () => owned.control(),
      (state) => state.heldCodingRequests === 1,
      "Native input did not reach the owned provider",
    );
    expect(before.providerRequests).toBe(1);
    expect(before.requiredSkillRequests).toBe(1);
    expect(before.factoryPolicyRequests).toBe(1);
    await owned.control("/release", "POST");
    await observe(
      () => observeOpenCodeWork(owned.client, sessionID),
      (work) => !work.running,
    );
    const history = await readOpenCodeInputMessages(owned.client, sessionID, input.promptID);
    expect(
      observedNativeSkillIds(
        history.data,
        input.promptID,
        revisions.map((item) => item.id),
      ),
    ).toEqual([required.id]);
    expect((await owned.control()).providerRequests).toBe(1);
  } catch (cause) {
    console.log("Owned required Skill diagnostics", await owned.diagnostics());
    throw cause;
  } finally {
    await owned.dispose();
  }
}, 120_000);
