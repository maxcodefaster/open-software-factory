import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeAgentProcess } from "./agent-process";

test("native Coding starts from the read-only tools mount, not injected executables or Project loader hooks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "factory-native-agent-")));
  try {
    const workspace = join(root, "project");
    const tools = join(root, "tools");
    await mkdir(workspace);
    const initialized = Bun.spawn(["git", "init", "--quiet", workspace], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await initialized.exited).toBe(0);
    for (const libc of ["glibc", "musl"]) {
      const directory = join(tools, "opt/factory/opencode", libc);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "bun"),
        `#!/bin/sh
if [ "$1" = --version ]; then exit ${libc === "glibc" ? 1 : 0}; fi
test -z "\${BUN_OPTIONS-}" && test -z "\${NODE_OPTIONS-}" && test -z "\${LD_PRELOAD-}" || exit 9
printf '%s\\n' "$1" "$OPENCODE_DB"
`,
        { mode: 0o555 },
      );
    }
    const process = runtimeAgentProcess({
      modelBaseURL: "https://factory.test/model",
      modelToken: "owned",
      modelID: "owned",
      modelIDs: ["owned"],
      browserToolsImage: `registry.test/browser@sha256:${"a".repeat(64)}`,
      browserURL: "https://factory.test/browser",
      browserToken: "owned",
    });
    const command = Bun.spawn(
      process.command.map((part) => part.replaceAll("/opt/factory-tools", tools)),
      {
        cwd: workspace,
        env: {
          ...globalThis.process.env,
          ...process.env,
          BUN_OPTIONS: "--preload=/project/untrusted.mjs",
          NODE_OPTIONS: "--require=/project/untrusted.cjs",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, output, error] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(output.trim().split("\n")).toEqual([
      join(tools, "opt/factory/opencode/server/server.mjs"),
      join(workspace, ".git/factory-opencode.db"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([undefined, "medium", "high"] as const)(
  "the native agent process retains its admitted configuration and scoped capabilities: %s",
  (reasoningEffort) => {
    const agent = {
      modelBaseURL: "https://factory.test/internal/model/owned/v1",
      modelToken: "owned-generation-model-token",
      modelID: "gpt-5.6-terra",
      modelIDs: ["gpt-5.6-terra", "approved-alternative", "gpt-6.1-sol"],
      ...(reasoningEffort ? { reasoningEffort } : {}),
      browserToolsImage: `registry.test/browser@sha256:${"a".repeat(64)}`,
      browserURL: "https://factory.test/internal/build-browser/owned",
      browserToken: "owned-generation-browser-token",
    };
    const process = runtimeAgentProcess(agent);
    expect(process.name).toBe("agent");
    expect(process.command.slice(0, 2)).toEqual(["sh", "-c"]);
    const command = process.command[2];
    expect(command).toContain("/opt/factory-tools/opt/factory/opencode/$factory_libc/bun");
    expect(command).toContain(
      'exec "$factory_runtime" /opt/factory-tools/opt/factory/opencode/server/server.mjs',
    );
    expect(command).toContain("git_dir=$(git rev-parse --absolute-git-dir)");
    expect(command).toContain('OPENCODE_DB="$git_dir/factory-opencode.db"');
    expect(command).not.toContain("/workspace/project");
    expect(command).not.toMatch(/opencode web|\.config\/opencode/);
    expect(process.env.OPENCODE_PASSWORD).toBe(agent.modelToken);
    expect(process.env).not.toHaveProperty("FACTORY_BUILD_BROWSER_COMMAND");
    expect(process.env.FACTORY_BUILD_BROWSER_URL).toBe(agent.browserURL);
    expect(process.env.FACTORY_BUILD_BROWSER_TOKEN).toBe(agent.browserToken);
    const config = JSON.parse(process.env.FACTORY_OPENCODE_CONFIG);
    const provider = config.providers.factory;
    expect(config.skills).toEqual(["/run/factory-skills/admitted"]);
    expect(provider.env).toEqual(["FACTORY_OPENCODE_TOKEN"]);
    expect(provider.settings).toMatchObject({
      transport: "http",
      compaction: { type: "summary" },
      baseURL: agent.modelBaseURL,
      apiKey: agent.modelToken,
      reasoningEffort: reasoningEffort ?? "none",
    });
    expect(provider.websocket).toBeUndefined();
    expect(provider.package).toBe(
      reasoningEffort
        ? "@opencode/ai/providers/openai/responses"
        : "@opencode/ai/providers/openai/chat",
    );
    expect(provider.models).toEqual({
      "gpt-5.6-terra": { name: "gpt-5.6-terra" },
      "approved-alternative": { name: "approved-alternative" },
      "gpt-6.1-sol": {
        name: "gpt-6.1-sol",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
    });
    expect(JSON.stringify(process)).not.toMatch(
      /FACTORY_AUTH_SECRET|FACTORY_MODEL_API_KEY|FACTORY_FORGEJO_TOKEN/,
    );
  },
);

test.each(["", "services/python", "folder with spaces/backend"])(
  "OpenCode retains its database in the checkout Git directory from workspace %s",
  async (folder) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "factory-agent-cwd-")));
    try {
      const cwd = join(root, folder);
      await mkdir(cwd, { recursive: true });
      const initialized = Bun.spawn(["git", "init", "--quiet", root], {
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await initialized.exited).toBe(0);
      const process = runtimeAgentProcess({
        modelBaseURL: "https://factory.test/model",
        modelToken: "owned",
        modelID: "owned",
        modelIDs: ["owned"],
        browserToolsImage: `registry.test/browser@sha256:${"a".repeat(64)}`,
        browserURL: "https://factory.test/browser",
        browserToken: "owned",
      });
      const startup = process.command[2]?.split("\n")[0];
      if (!startup) throw new Error("Missing packaged OpenCode startup command");
      const command = Bun.spawn(["sh", "-c", `${startup}; printf %s "$OPENCODE_DB"`], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, output] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
      ]);
      expect(exit).toBe(0);
      expect(output).toBe(join(root, ".git/factory-opencode.db"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
