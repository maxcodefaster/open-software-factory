import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "../../scripts/owned-client-process";
import { fixtureValue } from "../fixtures/value";

type Call = {
  args: string[];
  cwd: string;
  executable: string;
  directoryMode: number;
  configMode: number;
  config: {
    mcp: { servers: Record<string, { type: string; url: string; codemode: boolean }> };
    permissions: { action: string; resource: string; effect: string }[];
  };
};

async function localClient(
  selection: "path" | "override" | "missing",
  failure?: "api" | "version" | "location" | "run",
) {
  const parent = resolve(".factory/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "local-opencode-mcp-"));
  const temporary = resolve(directory, "user-1000 tmp");
  const bin = resolve(directory, "bin");
  const log = resolve(directory, "calls.jsonl");
  const executable = resolve(bin, selection === "override" ? "custom opencode" : "opencode");
  await mkdir(temporary);
  await mkdir(bin);
  // Only this synthetic CLI is executable on PATH. It cannot reach a service or model.
  await writeFile(
    executable,
    `#!${process.execPath} --no-env-file
import { appendFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
const args = process.argv.slice(2), cwd = process.cwd();
const configPath = resolve(cwd, "opencode.json");
const config = await readFile(configPath, "utf8").then(JSON.parse).catch(() => undefined);
await appendFile(process.env.CALL_LOG, JSON.stringify({
  args, cwd, executable: process.argv[1], config,
  directoryMode: (await stat(cwd)).mode & 0o777,
  configMode: config ? (await stat(configPath)).mode & 0o777 : 0,
}) + "\\n");
const name = Object.keys(config?.mcp?.servers ?? {})[0];
const path = args[2]?.split("?")[0];
if (process.env.FAILURE === "api" && path === "/api/info") {
  console.error("Bearer synthetic-secret");
  process.exit(7);
}
if (args[0] === "--version") {
  if (process.env.FAILURE === "version") {
    console.error("Bearer synthetic-secret"); process.exit(7);
  }
  console.log("2.3.2");
}
else if (args[0] === "run") {
  console.log("Bearer synthetic-secret");
  console.error("https://factory.example/callback?code=synthetic-code&state=synthetic-state");
  process.exit(process.env.FAILURE === "run" ? 7 : 0);
} else if (args[0] === "api") {
  const body = args[3] === "--data" ? JSON.parse(args[4]) : undefined;
  let result = {};
  if (path === "/api/info") result = { version: "2.3.2" };
  else if (path === "/api/integration") result = {
    data: [{ id: name, methods: [{ id: "native-oauth", type: "oauth" }] }],
  };
  else if (path?.endsWith("/connect/oauth")) result = {
    data: { url: "https://factory.example/owned-consent" },
  };
  else if (path === "/api/mcp") result = {
    data: [{ name, status: { status: "connected" } }],
  };
  else if (path === "/api/session") result = {
    data: { id: "owned-session", location: {
      directory: process.env.FAILURE === "location" ? "/not-the-owned-location" : body.location.directory,
    } },
  };
  console.log(JSON.stringify(result));
}
`,
    { mode: 0o700 },
  );
  const fixture = resolve("test/fixtures/local-opencode-mcp.ts");
  const script = `
    const { mock } = await import("bun:test");
    const events = [];
    const owned = executable => {
      if (executable !== ${JSON.stringify(executable)})
        throw Error("Unowned executable refused by local OpenCode regression");
    };
    const bunSpawn = Bun.spawn.bind(Bun);
    Bun.spawn = (command, ...options) => {
      owned(Array.isArray(command) ? command[0] : command.cmd[0]);
      return bunSpawn(command, ...options);
    };
    const childProcess = await import("node:child_process");
    const spawn = childProcess.spawn;
    mock.module("node:child_process", () => ({
      ...childProcess, spawn: (command, ...options) => {
        owned(command); return spawn(command, ...options);
      },
    }));
    const fs = await import("node:fs/promises");
    const mkdir = fs.mkdir, mkdtemp = fs.mkdtemp;
    const ownedTemp = path => {
      if (!String(path).startsWith(${JSON.stringify(`${temporary}/`)}))
        throw Error("Non-portable OpenCode temp directory refused by regression");
    };
    mock.module("node:fs/promises", () => ({
      ...fs,
      mkdir: (path, ...options) => { ownedTemp(path); return mkdir(path, ...options); },
      mkdtemp: (path, ...options) => { ownedTemp(path); return mkdtemp(path, ...options); },
    }));
    // Stub only the consent UI, in this child: no browser or shared module mocks.
    mock.module("@playwright/test", () => ({
      expect: locator => ({
        toBeVisible: async () => events.push("visible:" + locator.name),
      }),
    }));
    const { proveLocalOpenCodeMCP } = await import(${JSON.stringify(fixture)});
    const browser = { newPage: async () => ({
      goto: async url => events.push("goto:" + url),
      getByRole: (role, options) => ({
        name: options.name,
        click: async () => events.push("click:" + options.name),
      }),
      screenshot: async () => events.push("screenshot"),
      close: async () => events.push("close"),
    }) };
    let result, error;
    try {
      result = await proveLocalOpenCodeMCP({
        factoryURL: "https://factory.example", workspaceID: "owned-workspace",
        browser, evidenceDirectory: ${JSON.stringify(directory)},
      });
    } catch (cause) { error = cause.message; }
    console.log(JSON.stringify({ result, error, events }));
  `;
  let calls: Call[] = [];
  try {
    const child = await runProcess([process.execPath, "--no-env-file", "-e", script], {
      cwd: directory,
      env: {
        PATH: bin,
        HOME: directory,
        TMPDIR: temporary,
        CALL_LOG: log,
        ...(selection === "path"
          ? {}
          : {
              FACTORY_LOCAL_OPENCODE_BINARY:
                selection === "missing" ? resolve(bin, "missing") : executable,
            }),
        ...(failure ? { FAILURE: failure } : {}),
      },
    });
    calls = await readFile(log, "utf8")
      .then((source) =>
        source
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Call),
      )
      .catch(() => []);
    const result = JSON.parse(child.stdout) as {
      result?: { cliVersion: string; serverVersion: string; serverName: string };
      error?: string;
      events: string[];
    };
    const proofDirectory = calls.find((call) => call.config)?.cwd;
    return {
      ...result,
      calls,
      temporary,
      executable,
      config: proofDirectory
        ? JSON.parse(await readFile(resolve(proofDirectory, "opencode.json"), "utf8"))
        : undefined,
      stdout: await readFile(resolve(directory, "local-opencode.jsonl"), "utf8").catch(() => ""),
      stderr: await readFile(resolve(directory, "local-opencode.stderr.log"), "utf8").catch(
        () => "",
      ),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each(["path", "override"] as const)(
  "installed OpenCode from %s uses private host temp storage and keeps native consent and Location",
  async (selection) => {
    const proof = await localClient(selection);
    expect(proof.error).toBeUndefined();
    expect(proof.result).toMatchObject({ cliVersion: "2.3.2", serverVersion: "2.3.2" });
    const first = fixtureValue(proof.calls[0], "first local OpenCode command");
    expect(first.cwd.startsWith(`${proof.temporary}/factory-mcp-`)).toBe(true);
    expect(first.directoryMode).toBe(0o700);
    expect(first.configMode).toBe(0o600);
    for (const call of proof.calls) {
      expect(call.executable).toBe(proof.executable);
      expect(call.cwd).toBe(first.cwd);
      if (call.args[0] === "api" && call.args[2]?.includes("?"))
        expect(new URLSearchParams(call.args[2].split("?")[1]).get("location[directory]")).toBe(
          first.cwd,
        );
    }
    const name = proof.result?.serverName ?? "";
    expect(first.config.mcp.servers).toEqual({
      [name]: { type: "remote", url: "https://factory.example/api/mcp", codemode: false },
    });
    const permissions = [
      { action: "*", resource: "*", effect: "deny" },
      { action: `${name}_*`, resource: "*", effect: "allow" },
    ];
    expect(first.config.permissions).toEqual(permissions);
    const session = proof.calls.find((call) => call.args[2] === "/api/session");
    expect(JSON.parse(session?.args[4] ?? "{}")).toMatchObject({
      agent: "build",
      model: { providerID: "github-copilot", id: "gpt-6.1-sol" },
      location: { directory: first.cwd },
      permissions,
    });
    const run = proof.calls.find((call) => call.args[0] === "run");
    expect(run?.args.slice(0, 10)).toEqual([
      "run",
      "--session",
      "owned-session",
      "--model",
      "github-copilot/gpt-6.1-sol",
      "--agent",
      "build",
      "--format",
      "json",
      "--auto",
    ]);
    expect(proof.events).toEqual([
      "goto:https://factory.example/owned-consent",
      "visible:Connect to Factory",
      "screenshot",
      "click:Connect client",
      "close",
    ]);
    expect(proof.calls.some((call) => call.args.join(" ") === `mcp logout ${name}`)).toBe(true);
    expect(
      proof.calls.some(
        (call) =>
          call.args[1] === "delete" && call.args[2]?.startsWith(`/api/experimental/mcp/${name}?`),
      ),
    ).toBe(true);
    expect(proof.config.mcp.servers).toEqual({});
    expect(proof.stdout).toBe("Bearer <REDACTED>\n");
    expect(proof.stderr).not.toContain("synthetic-");
  },
);

test("missing installed OpenCode fails explicitly without falling back or opening consent", async () => {
  const proof = await localClient("missing");
  expect(proof.error).toContain("FACTORY_LOCAL_OPENCODE_BINARY");
  expect(proof.calls).toEqual([]);
  expect(proof.events).toEqual([]);
});

test.each(["api", "version", "location", "run"] as const)(
  "local OpenCode %s failure stays a failure without leaking credentials or bypassing Location",
  async (failure) => {
    const proof = await localClient("override", failure);
    expect(proof.result).toBeUndefined();
    expect(proof.error).toContain(
      failure === "api" || failure === "version"
        ? "Sensitive diagnostics suppressed"
        : failure === "location"
          ? "explicit isolated Location"
          : "sanitized diagnostics retained",
    );
    expect(proof.error).not.toContain("synthetic-secret");
    if (failure === "location")
      expect(proof.calls.some((call) => call.args[0] === "run")).toBe(false);
    if (failure === "location" || failure === "run") {
      expect(proof.events.at(-1)).toBe("close");
      expect(proof.config.mcp.servers).toEqual({});
      expect(proof.calls.some((call) => call.args[0] === "mcp")).toBe(true);
    }
  },
);
