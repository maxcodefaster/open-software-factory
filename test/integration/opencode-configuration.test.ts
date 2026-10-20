import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { docker, observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("packaged OpenCode loads only Factory configuration and admitted skills", async () => {
  const owned = await pinnedOpenCode();
  const location = { directory: "/workspace/project" };
  try {
    await docker(
      "exec",
      owned.container,
      "node",
      "-e",
      [
        'const fs = require("node:fs");',
        'const global = "/root/.config/opencode/opencode.json";',
        "const config = JSON.parse(fs.readFileSync(global, 'utf8'));",
        "config.tool_output = { max_lines: 7, max_bytes: 777 };",
        "fs.writeFileSync(global, JSON.stringify(config));",
        "for (const [directory, name] of [",
        '  ["/root/.config/opencode/skills/owned-global", "owned-global"],',
        '  ["/root/.agents/skills/owned-compatibility", "owned-compatibility"],',
        '  ["/root/.claude/skills/owned-claude", "owned-claude"],',
        '  ["/workspace/project/.opencode/skills/owned-project", "owned-project"],',
        "]) {",
        "  fs.mkdirSync(directory, { recursive: true });",
        '  fs.writeFileSync(directory + "/SKILL.md", `---\\nname: ${name}\\ndescription: Unadmitted owned test skill\\n---\\nDo not load this skill.\\n`);',
        "}",
      ].join("\n"),
    );
    await owned.client.location.reload();
    await observe(
      () =>
        owned.client.model
          .list({ location })
          .then(() => true)
          .catch(() => false),
      (ready) => ready,
      "Owned configuration reload did not settle",
      45_000,
    );
    const entries = await owned.client.config.get({ location });
    const skills = (await owned.client.skill.list({ location })).data;
    const configuredProvider = entries
      .flatMap((entry) => (entry.type === "document" ? [entry.info.providers?.["factory"]] : []))
      .find((provider) => provider !== undefined);
    expect(configuredProvider?.settings?.transport).toBe("http");
    expect(configuredProvider?.settings?.compaction).toEqual({ type: "summary" });
    expect(
      entries.some((entry) => entry.type === "document" && entry.info.compaction?.auto === true),
    ).toBe(true);
    expect({
      ambientConfig: entries.some(
        (entry) => entry.type === "document" && entry.info.tool_output?.max_lines === 7,
      ),
      ambientSkills: skills
        .filter((skill) => skill.id.startsWith("owned-"))
        .map((skill) => skill.id),
    }).toEqual({ ambientConfig: false, ambientSkills: [] });
    expect(
      entries.some(
        (entry) =>
          entry.type === "directory" &&
          resolve(entry.path) === "/opt/factory/opencode/server/config",
      ),
    ).toBe(true);
    await docker(
      "exec",
      "--user",
      "1000:1000",
      owned.container,
      "sh",
      "-c",
      "test -d /opt/factory/opencode/server/config && test -r /opt/factory/opencode/server/config/opencode.json && test ! -w /opt/factory/opencode/server/config && test ! -w /opt/factory/opencode/server/config/opencode.json && test -r /opt/factory/opencode/server/config/AGENTS.md && test ! -w /opt/factory/opencode/server/config/AGENTS.md",
    );
    expect((await owned.control()).providerRequests).toBe(0);
  } catch (cause) {
    console.log("Owned configuration isolation diagnostics", await owned.diagnostics());
    throw cause;
  } finally {
    await owned.dispose();
  }
}, 120_000);
