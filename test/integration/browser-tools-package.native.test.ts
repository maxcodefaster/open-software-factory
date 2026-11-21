import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { requirePublishedRuntimeArtifacts } from "../../scripts/factory/artifacts";
import upstream from "../../upstream.json";

test("packaged browser worker initializes the pinned MCP with its restricted tool configuration", async () => {
  const image =
    process.env["FACTORY_BROWSER_TOOLS_IMAGE"] ??
    (await requirePublishedRuntimeArtifacts(process.env["FACTORY_STATE_DIRECTORY"] ?? ".factory"))[
      "browser-tools"
    ];
  if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Browser package proof requires an immutable browser-tools image");
  const owner = crypto.randomUUID();
  const name = `factory-browser-package-${owner}`;
  const directory = await mkdtemp(join(tmpdir(), "factory-browser-package-"));
  let id = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const docker = async (args: string[]) => {
    const result = await runCommand(["docker", ...args], undefined, {
      timeoutMS: 15_000,
      outputBytes: 1 << 20,
    });
    if (result.exitCode) throw new Error(`Owned browser package Docker command failed: ${args[0]}`);
    return result.stdout.trim();
  };
  console.info(`Owned browser package fixture: ${name}`);
  try {
    // Only this fixture's two public configuration files enter the worker.
    await writeFile(
      join(directory, "apps.json"),
      JSON.stringify([{ name: "app", kind: "app", target: "http://127.0.0.1:3000" }]),
      { mode: 0o644 },
    );
    await writeFile(
      join(directory, "authority.json"),
      JSON.stringify({
        sessionId: owner,
        expiresAt: new Date(Date.now() + 25_000).toISOString(),
      }),
      { mode: 0o644 },
    );
    id = await docker([
      "create",
      "--pull=never",
      "--name",
      name,
      "--label",
      `factory.browser-package=${owner}`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--memory",
      "1408m",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
      "--interactive",
      "--mount",
      `type=bind,src=${directory},dst=/factory/browser/config,readonly`,
      "--entrypoint",
      "/usr/local/bin/factory-browser-worker",
      image,
    ]);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    const worker = Bun.spawn(["docker", "start", "--attach", "--interactive", id], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    child = worker;
    deadline = setTimeout(() => child?.kill("SIGTERM"), 15_000);
    const reader = worker.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const reply = async (expectedID: number) => {
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const message = JSON.parse(line);
          if (message.id !== expectedID) continue;
          expect(message.error).toBeUndefined();
          return message.result;
        }
        const next = await reader.read();
        if (next.done) throw new Error("Pinned browser worker exited before its MCP reply");
        pending += decoder.decode(next.value, { stream: true });
        if (Buffer.byteLength(pending) > 1 << 20)
          throw new Error("Browser package reply exceeds its bound");
      }
    };
    worker.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "factory-package-proof", version: "1" },
        },
      }) + "\n",
    );
    expect((await reply(1)).serverInfo.version).toBe(upstream.chromeDevToolsMcp.version);
    worker.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    worker.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
    );
    const tools = (await reply(2)).tools.map((tool: { name: string }) => tool.name);
    for (const allowed of [
      "navigate_page",
      "take_snapshot",
      "take_screenshot",
      "click",
      "fill",
      "press_key",
    ])
      expect(tools).toContain(allowed);
    for (const denied of [
      "evaluate_script",
      "set_logpoints",
      "list_network_requests",
      "get_network_request",
      "performance_start_trace",
      "memory_take_snapshot",
      "webmcp_call_tool",
    ])
      expect(tools).not.toContain(denied);
    worker.stdin.end();
    expect(await worker.exited).toBe(0);
  } finally {
    if (deadline) clearTimeout(deadline);
    try {
      if (id) {
        const observed = JSON.parse(await docker(["inspect", "--format", "{{json .}}", id]));
        expect(observed.Id).toBe(id);
        expect(observed.Config.Labels["factory.browser-package"]).toBe(owner);
        await docker(["rm", "--force", id]);
      }
    } finally {
      if (child?.exitCode === null) child.kill("SIGTERM");
      await child?.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 45_000);
