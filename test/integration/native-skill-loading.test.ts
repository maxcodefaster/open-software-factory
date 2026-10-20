import { test, expect } from "bun:test";
import { pinnedOpenCode, observe } from "../fixtures/pinned-opencode";
import { nativeSkillManifest, nativeSkillId } from "../../apps/factory/src/skills/native";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import { promptRecordedOpenCodeInput } from "../../apps/factory/src/agent/opencode-client";
import upstream from "../../upstream.json";

test("pinned native OpenCode discovers only admitted packages and retains explicit skill input without inference", async () => {
  const previous = process.env["FACTORY_OPENCODE_PACKAGED_SERVER"];
  process.env["FACTORY_OPENCODE_PACKAGED_SERVER"] = "1";
  const revision = {
    id: crypto.randomUUID(),
    revision: 1,
    content: {
      ...requirementsInterviewSkill,
      roles: ["build" as const],
      manualOnly: true,
      files: [
        { path: "assets/logo.bin", body: "AAECAw==", encoding: "base64" as const },
        {
          path: "scripts/check.sh",
          body: "#!/bin/sh\necho exact\n",
          encoding: "utf8" as const,
          executable: true,
        },
      ],
    },
    digest: "a".repeat(64),
    published: true,
  };
  const processFixture = await pinnedOpenCode(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    upstream.openCode.version,
    nativeSkillManifest([revision]),
  );
  try {
    const listed = await processFixture.client.skill.list({
      location: { directory: "/workspace/project" },
    });
    expect(
      listed.data.filter((skill) => !skill.path.startsWith("/builtin/")).map((skill) => skill.id),
    ).toEqual([nativeSkillId(revision)]);
    const admitted = listed.data.find((skill) => skill.id === nativeSkillId(revision));
    expect(admitted?.autoinvoke).toBe(false);
    expect(admitted?.content).toContain(revision.content.instructions);
    const input = {
      sessionID: `ses_skill_${crypto.randomUUID().replaceAll("-", "")}`,
      promptID: `msg_skill_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Use /requirements-interview with this exact package.",
      bootstrap: false,
      skills: [{ id: nativeSkillId(revision) }],
    };
    await processFixture.client.session.create({
      id: input.sessionID,
      title: "Owned skill package proof",
      location: { directory: "/workspace/project" },
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: nativeSkillId(revision), effect: "allow" },
      ],
    });
    expect((await promptRecordedOpenCodeInput(processFixture.client, input, false)).state).toBe(
      "queued",
    );
    const before = await processFixture.client.session.inbox.list({ sessionID: input.sessionID });
    expect(JSON.stringify(before)).toContain(revision.content.instructions.replaceAll("\n", "\\n"));
    expect(before[0]?.type).toBe("user");
    expect((await processFixture.control()).providerRequests).toBe(0);
    const shell = await processFixture.client.shell.create({
      location: { directory: "/workspace/project" },
      command: `/opt/factory/admitted-skills/${nativeSkillId(revision)}/scripts/check.sh`,
    });
    const output = await observe(
      () =>
        processFixture.client.shell.output({
          id: shell.data.id,
          location: { directory: "/workspace/project" },
        }),
      (value) => JSON.stringify(value).includes("exact"),
      "Owned packaged script did not execute",
    );
    expect(JSON.stringify(output)).toContain("exact");
    await processFixture.control("/kill", "POST");
    await processFixture.control("/restart", "POST");
    await observe(
      () => processFixture.client.server.info().catch(() => null),
      (value) => Boolean(value),
      "Owned skill server did not restart",
      45000,
    );
    expect(await processFixture.client.session.inbox.list({ sessionID: input.sessionID })).toEqual(
      before,
    );
    expect((await processFixture.control()).providerRequests).toBe(0);
  } finally {
    await processFixture.dispose();
    if (previous === undefined) delete process.env["FACTORY_OPENCODE_PACKAGED_SERVER"];
    else process.env["FACTORY_OPENCODE_PACKAGED_SERVER"] = previous;
  }
}, 120000);
