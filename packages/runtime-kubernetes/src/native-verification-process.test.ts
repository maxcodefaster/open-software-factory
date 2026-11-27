import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runtimeVerificationProcess } from "./verification-process";

type RunnerObservation = {
  argv: string[];
  cwd: string;
  config: string;
  env: Record<string, string>;
};

async function eventually<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(20);
    }
  }
}

async function withVerification(
  options: {
    libc?: "glibc" | "musl" | "unsupported";
    runner?: "success" | "failure" | "signal" | "missing";
    publication?: boolean;
    handle?: string;
  },
  check: (fixture: {
    child: ReturnType<typeof Bun.spawn>;
    stderr: Promise<string>;
    root: string;
    workspace: string;
    port: number;
    observation: () => Promise<RunnerObservation>;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "factory-native-verification-")));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("The owned supervisor fixture needs the pinned host Node");
    const workspace = join(root, 'Work\'s "selected" checkout', "project");
    const tools = join(root, "tools");
    const home = join(root, "home");
    const projectBin = join(root, "project-bin");
    await mkdir(workspace, { recursive: true });
    await mkdir(home);
    await mkdir(projectBin);
    await mkdir(join(tools, "usr/local/bin"), { recursive: true });
    await writeFile(
      join(projectBin, "node"),
      '#!/bin/sh\nprintf project-node > "$OWNED_PROJECT_NODE"\nexit 91\n',
      { mode: 0o555 },
    );
    const libc = options.libc ?? "glibc";
    for (const candidate of ["glibc", "musl"]) {
      const directory = join(tools, "opt/factory/language-tools", candidate);
      await mkdir(join(directory, "lib"), { recursive: true });
      // These owned executables stand in for the two mounted ABIs and delegate
      // only the supervisor JavaScript to real host Node. PATH Node is a tripwire.
      await writeFile(
        join(directory, "node"),
        `#!/bin/sh
printf '%s %s\\n' '${candidate}' "$1" >> "$OWNED_RUNTIME_CALLS"
test -z "\${BUN_OPTIONS+x}\${BUN_INSPECT+x}\${NODE_OPTIONS+x}\${NODE_PATH+x}\${LD_PRELOAD+x}\${LD_AUDIT+x}" || exit 92
test "$LD_LIBRARY_PATH" = "${directory}/lib" || exit 93
if [ "$1" = --version ]; then exit ${candidate === libc ? 0 : 1}; fi
export OWNED_NATIVE_RUNTIME=${candidate}
exec "$OWNED_HOST_NODE" "$@"
`,
        { mode: 0o555 },
      );
    }
    if (options.runner !== "missing")
      await writeFile(
        join(tools, "usr/local/bin/forgejo-runner"),
        `#!${node}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.OWNED_RUNNER_OBSERVATION, JSON.stringify({
  argv, cwd: process.cwd(), env: process.env,
  config: fs.readFileSync(argv[argv.length - 1], "utf8"),
}));
console.log("owned runner stdout");
console.error("owned runner stderr");
if (process.env.OWNED_RUNNER_MODE === "signal") process.kill(process.pid, "SIGTERM");
else process.exit(process.env.OWNED_RUNNER_MODE === "failure" ? 17 : 0);
`,
        { mode: 0o555 },
      );
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Owned health port missing");
    const port = address.port;
    await new Promise<void>((done, reject) =>
      listener.close((error) => (error ? reject(error) : done())),
    );
    const process = runtimeVerificationProcess({
      forgeURL: "https://forge.example",
      runnerUUID: "owned-runner-uuid",
      runnerToken: "owned-runner-token",
      runnerLabel: options.publication ? "factory-publication" : "factory-verification",
      ...(options.handle === undefined ? {} : { handle: options.handle }),
      ...(options.publication
        ? {
            publication: {
              id: "owned-release",
              version: "1.2.3",
              credentialURL: "https://factory.example/internal/releases/owned/credentials",
              credentialToken: "owned-publication-token",
              registryURL: "https://registry.example:444",
            },
          }
        : {}),
    });
    // Remap only the owned tools mount and health port, never the selected runtime.
    const command = Bun.spawn(
      process.command.map((part) =>
        part
          .replaceAll("/opt/factory-tools", tools)
          .replace('server.listen(4500, "127.0.0.1")', `server.listen(${port}, "127.0.0.1")`),
      ),
      {
        cwd: workspace,
        env: {
          PATH: `${projectBin}:${Bun.env["PATH"]}`,
          HOME: home,
          ...process.env,
          BUN_OPTIONS: "--preload=/project/untrusted.mjs",
          BUN_INSPECT: "1",
          NODE_OPTIONS: "--require=/project/untrusted.cjs",
          NODE_PATH: projectBin,
          LD_PRELOAD: "",
          LD_AUDIT: "",
          LD_LIBRARY_PATH: "/project/untrusted-libraries",
          HTTP_PROXY: "http://owned-proxy.invalid:3128",
          HTTPS_PROXY: "http://owned-proxy.invalid:3128",
          NO_PROXY: "127.0.0.1",
          OWNED_HOST_NODE: node,
          OWNED_RUNTIME_CALLS: join(root, "runtime-calls"),
          OWNED_PROJECT_NODE: join(root, "project-node-used"),
          OWNED_RUNNER_OBSERVATION: join(root, "runner.json"),
          OWNED_RUNNER_MODE: options.runner ?? "success",
        },
        stdout: "ignore",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    child = command;
    await check({
      child: command,
      stderr: new Response(command.stderr).text(),
      root,
      workspace,
      port,
      observation: () =>
        eventually(() => Bun.file(join(root, "runner.json")).json() as Promise<RunnerObservation>),
    });
    expect(await Bun.file(join(root, "project-node-used")).exists()).toBe(false);
  } finally {
    child?.kill();
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}

test.each(["glibc", "musl"] as const)(
  "native Verification executes mounted %s Node and one exact job, retaining the completed channel",
  async (libc) => {
    const handle = 'owned exact job "attempt"; not-a-shell-command';
    await withVerification({ libc, handle, publication: true }, async (fixture) => {
      const runner = await fixture.observation();
      expect(runner.argv).toEqual([
        "one-job",
        "--wait",
        "--handle",
        handle,
        "--config",
        join(fixture.root, "home/.factory-runner/config.yml"),
      ]);
      expect(runner.cwd).toBe(fixture.workspace);
      expect(runner.env).toMatchObject({
        OWNED_NATIVE_RUNTIME: libc,
        LD_LIBRARY_PATH: join(fixture.root, `tools/opt/factory/language-tools/${libc}/lib`),
        HTTP_PROXY: "http://owned-proxy.invalid:3128",
        HTTPS_PROXY: "http://owned-proxy.invalid:3128",
        NODE_USE_ENV_PROXY: "1",
        FACTORY_CHECKOUT_ROOT: fixture.workspace,
        FACTORY_RELEASE_SOURCE: fixture.workspace,
      });
      for (const key of ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "LD_PRELOAD", "LD_AUDIT"])
        expect(runner.env).not.toHaveProperty(key);
      const config = parse(runner.config);
      expect(config.runner).toMatchObject({
        capacity: 1,
        timeout: "30m",
        shutdown_timeout: "1m",
        envs: {
          NODE_USE_ENV_PROXY: "1",
          FACTORY_CHECKOUT_ROOT: fixture.workspace,
          FACTORY_RELEASE_SOURCE: fixture.workspace,
          FACTORY_RELEASE_ID: "owned-release",
          FACTORY_RELEASE_VERSION: "1.2.3",
          FACTORY_RELEASE_CREDENTIAL_TOKEN: "owned-publication-token",
          FACTORY_RELEASE_CREDENTIAL_URL:
            "https://factory.example/internal/releases/owned/credentials",
          FACTORY_RELEASE_REGISTRY: "registry.example:444",
          FACTORY_RELEASE_REGISTRY_URL: "https://registry.example:444",
        },
      });
      expect(config.server.connections.factory).toEqual({
        url: "https://forge.example",
        uuid: "owned-runner-uuid",
        token: "owned-runner-token",
        fetch_interval: "1s",
        labels: ["factory-publication:host", "factory-release-owned-release:host"],
      });
      expect(config.cache.enabled).toBe(false);
      expect(config.host.workdir_parent).toBe("/tmp/factory-actions");
      expect(await readFile(join(fixture.root, "runtime-calls"), "utf8")).toBe(
        `${libc === "musl" ? "glibc --version\n" : ""}${libc} --version\n${libc} -e\n`,
      );
      await eventually(async () => {
        const log = join(fixture.root, "home/.factory-runner/runner.log");
        expect(await readFile(log, "utf8")).toBe("owned runner stdout\nowned runner stderr\n");
        expect((await stat(log)).mode & 0o777).toBe(0o600);
      });
      const health = `http://127.0.0.1:${fixture.port}`;
      await eventually(async () => {
        const response = await fetch(`${health}/health`);
        expect(response.status).toBe(200);
      });
      expect((await fetch(`${health}/not-health`)).status).toBe(404);
      // A runner verdict is not a Stop: Factory still owns the saved-work handoff.
      await Bun.sleep(50);
      expect(fixture.child.exitCode).toBeNull();
      expect((await stat(runner.argv.at(-1) as string)).mode & 0o777).toBe(0o600);
      fixture.child.kill();
      await fixture.child.exited;
      expect(await fixture.stderr).toBe("");
    });
  },
);

test("native Verification exposes the actual checkout cwd without a handle or publication capabilities", async () => {
  await withVerification({}, async (fixture) => {
    const runner = await fixture.observation();
    expect(runner.argv).toEqual([
      "one-job",
      "--wait",
      "--config",
      join(fixture.root, "home/.factory-runner/config.yml"),
    ]);
    // The Work process cwd is already remapped; spaces and quotes must survive
    // runner YAML serialization without a shell cd or a fixed checkout path.
    expect(runner.cwd).toBe(fixture.workspace);
    expect(runner.env["FACTORY_CHECKOUT_ROOT"]).toBe(fixture.workspace);
    const config = parse(runner.config);
    expect(config.runner.envs).toEqual({ FACTORY_CHECKOUT_ROOT: fixture.workspace });
    expect(config.host.workdir_parent).toBe("/tmp/factory-actions");
    expect(Object.keys(runner.env).filter((key) => key.startsWith("FACTORY_RELEASE_"))).toEqual([]);
  });
});

test.each(["failure", "signal", "missing"] as const)(
  "native Verification terminates rather than keeping a healthy shell on runner %s",
  async (runner) => {
    await withVerification({ runner, handle: "owned-exact-job" }, async (fixture) => {
      expect(await fixture.child.exited).toBe(1);
      expect(await fixture.stderr).toContain("Verification runner failed; inspect its runtime log");
      if (runner === "missing")
        expect(await Bun.file(join(fixture.root, "runner.json")).exists()).toBe(false);
      else
        expect((await fixture.observation()).argv.slice(0, 4)).toEqual([
          "one-job",
          "--wait",
          "--handle",
          "owned-exact-job",
        ]);
      await expect(
        fetch(`http://127.0.0.1:${fixture.port}/health`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
    });
  },
);

test("native Verification refuses unsupported mounted Node ABIs without using Project Node", async () => {
  await withVerification({ libc: "unsupported" }, async (fixture) => {
    expect(await fixture.child.exited).toBe(1);
    expect(await fixture.stderr).toContain(
      "Factory node requires the read-only tools image and a supported glibc or musl Project runtime.",
    );
    expect(await readFile(join(fixture.root, "runtime-calls"), "utf8")).toBe(
      "glibc --version\nmusl --version\n",
    );
    expect(await Bun.file(join(fixture.root, "runner.json")).exists()).toBe(false);
  });
});
