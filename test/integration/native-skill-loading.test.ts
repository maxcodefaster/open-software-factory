import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "#runtime-kubernetes/command";
import {
  installedOpenCodeSkillIDs,
  promptRecordedOpenCodeInput,
} from "../../apps/factory/src/agent/opencode-adapter";
import { nativeSkillId, nativeSkillManifest } from "../../apps/factory/src/skills/native";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import upstream from "../../upstream.json";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

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
    upstream.openCode.version,
    nativeSkillManifest([revision]),
  );
  try {
    const listed = await processFixture.client.skill.list({
      location: { directory: "/workspace/project" },
    });
    expect(installedOpenCodeSkillIDs(listed.data)).toEqual([nativeSkillId(revision)]);
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

test("native OpenCode discovers exact packages installed after location activation without inference", async () => {
  const revision = {
    id: crypto.randomUUID(),
    revision: 1,
    content: { ...requirementsInterviewSkill, roles: ["build" as const] },
    digest: "a".repeat(64),
    published: true,
  };
  const owned = await pinnedOpenCode();
  try {
    const list = () => owned.client.skill.list({ location: { directory: "/workspace/project" } });
    expect(installedOpenCodeSkillIDs((await list()).data)).toEqual([]);
    const file = resolve(owned.scratch, "late-admitted-skills.json");
    await writeFile(file, JSON.stringify(nativeSkillManifest([revision])), { mode: 0o600 });
    const installed = await runCommand(
      [
        "docker",
        "exec",
        "--interactive",
        owned.container,
        "/opt/factory/opencode/musl/bun",
        "/opt/factory/opencode/server/install-skills.mjs",
      ],
      await readFile(file, "utf8"),
      { timeoutMS: 15_000, outputBytes: 1 << 20 },
    );
    expect(installed.exitCode).toBe(0);
    const processBefore = await owned.control();
    const discovered = await observe(
      list,
      (view) =>
        JSON.stringify(installedOpenCodeSkillIDs(view.data)) ===
        JSON.stringify([nativeSkillId(revision)]),
      "Native watcher did not publish the exact newly installed package",
      10_000,
    );
    expect(installedOpenCodeSkillIDs(discovered.data)).toEqual([nativeSkillId(revision)]);
    const processAfter = await owned.control();
    expect({ pid: processAfter.pid, generation: processAfter.generation }).toEqual({
      pid: processBefore.pid,
      generation: processBefore.generation,
    });
    expect((await owned.control()).providerRequests).toBe(0);
  } finally {
    await owned.dispose();
  }
}, 120_000);
