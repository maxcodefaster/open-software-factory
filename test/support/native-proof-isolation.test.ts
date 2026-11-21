import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ownedBrowserHost } from "../fixtures/browser-host";

const root = resolve(import.meta.dirname, "../..");
type SpawnHost = NonNullable<Parameters<typeof ownedBrowserHost>[1]>;

async function probe(mode = "ready") {
  const parent = resolve(root, ".factory/test-results/browser-host-isolation");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "probe-"));
  await writeFile(resolve(directory, ".env"), "FACTORY_BROWSER_ENV_PROBE=must-not-load-dotenv\n");
  const script = `
    import { appendFileSync, writeFileSync } from "node:fs";
    const mode = ${JSON.stringify(mode)};
    const id = crypto.randomUUID();
    writeFileSync("environment.json", JSON.stringify({
      probe: process.env.FACTORY_BROWSER_ENV_PROBE ?? "isolated",
      model: process.env.FACTORY_MODEL_API_KEY,
      live: process.env.FACTORY_LEARNING_MODEL_LIVE,
      proof: process.env.FACTORY_NATIVE_PROOF,
      objects: process.env.FACTORY_OBJECT_S3_SECRET_KEY,
      build: process.env.FACTORY_BUILD_DIRECTORY,
      postgres: process.env.FACTORY_TEST_POSTGRES,
    }));
    process.on("SIGTERM", () => {
      appendFileSync("cleanup", process.pid + "\\n");
      if (mode !== "stuck-cleanup") process.exit(mode === "cleanup-failure" ? 7 : 0);
    });
    console.error("provider credential: private-diagnostic");
    console.log("Owned private-diagnostic");
    if (mode === "exit") process.exit(0);
    if (mode !== "silent") {
      const ready = JSON.stringify({
        fixtureBase: mode === "malformed" ? "private-diagnostic" : "http://127.0.0.1:12345",
        id,
        databaseURL: "owned-database-" + id,
      });
      process.stdout.write(ready.slice(0, 15));
      process.stdout.write(ready.slice(15) + "\\n");
    }
    setInterval(() => {}, 1000);
  `;
  const commands: string[][] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  let child: ReturnType<SpawnHost> | undefined;
  let closed: Promise<void> | undefined;
  const spawnHost: SpawnHost = (command, options) => {
    commands.push(command);
    environments.push(options.env);
    expect(options.cwd).toBe(root);
    // Run a cheap protocol peer using the launcher's actual executable/flags.
    // No PostgreSQL, cache, application or browser is started here.
    const [executable, ...args] = command;
    if (!executable) throw new Error("Probe command is empty");
    child = spawn(executable, [...args.slice(0, -1), "-e", script], {
      cwd: directory,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = new Promise((complete) => child?.once("close", () => complete()));
    return child;
  };
  return {
    directory,
    spawnHost,
    commands,
    environments,
    child: () => child,
    async cleanup() {
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("owned browser launcher disables dotenv, filters live inputs and retains only explicit fixture dependencies", async () => {
  const peer = await probe();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    FACTORY_MODEL_API_KEY: "private-model-key",
    FACTORY_LEARNING_MODEL_LIVE: "1",
    FACTORY_NATIVE_PROOF: "private-proof",
    FACTORY_OBJECT_S3_SECRET_KEY: "private-object-key",
    FACTORY_BUILD_DIRECTORY: "/owned/browser-build",
    FACTORY_TEST_POSTGRES: "owned-lane-daemon",
  };
  delete environment["FACTORY_BROWSER_ENV_PROBE"];
  const before = { ...environment };
  const diagnostics: unknown[] = [];
  const info = spyOn(console, "info").mockImplementation((message) => diagnostics.push(message));
  try {
    const fixture = await ownedBrowserHost({ environment }, peer.spawnHost);
    try {
      expect(peer.commands).toEqual([
        ["mise", "exec", "--", "bun", "--no-env-file", "test/fixtures/skill-browser-host.ts"],
      ]);
      expect(
        JSON.parse(await readFile(resolve(peer.directory, "environment.json"), "utf8")),
      ).toEqual({
        probe: "isolated",
        build: "/owned/browser-build",
        postgres: "owned-lane-daemon",
      });
      expect(peer.environments[0]).not.toBe(environment);
      expect(environment).toEqual(before);
      expect(diagnostics).toEqual([`Owned browser host: ${fixture.id}`]);
    } finally {
      await Promise.all([fixture.dispose(), fixture.dispose()]);
    }
    expect(await readFile(resolve(peer.directory, "cleanup"), "utf8")).toBe(
      `${peer.child()?.pid}\n`,
    );
    expect(peer.child()?.exitCode).toBe(0);
  } finally {
    info.mockRestore();
    await peer.cleanup();
  }
});

test("browser hosts retain separate identities and disposing one does not stop its peer", async () => {
  const first = await probe();
  const second = await probe();
  let a: Awaited<ReturnType<typeof ownedBrowserHost>> | undefined;
  let b: Awaited<ReturnType<typeof ownedBrowserHost>> | undefined;
  try {
    a = await ownedBrowserHost({}, first.spawnHost);
    b = await ownedBrowserHost({}, second.spawnHost);
    expect(a.id).not.toBe(b.id);
    expect(a.databaseURL).not.toBe(b.databaseURL);
    expect(first.child()?.pid).not.toBe(second.child()?.pid);
    await a.dispose();
    expect(first.child()?.exitCode).toBe(0);
    expect(second.child()?.exitCode).toBeNull();
    expect(second.child()?.signalCode).toBeNull();
    await b.dispose();
    expect(await readFile(resolve(second.directory, "cleanup"), "utf8")).toBe(
      `${second.child()?.pid}\n`,
    );
  } finally {
    try {
      await Promise.all([a?.dispose(), b?.dispose()]);
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  }
});

for (const [mode, message] of [
  ["silent", "readiness timed out"],
  ["malformed", "invalid readiness"],
  ["exit", "exited before readiness: 0"],
] as const) {
  test(`browser host ${mode} readiness fails without raw diagnostics and joins its owned child`, async () => {
    const peer = await probe(mode);
    try {
      const failure = await ownedBrowserHost({ readinessTimeoutMS: 1000 }, peer.spawnHost).then(
        () => undefined,
        (cause: Error) => cause,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain(message);
      expect(failure?.message).not.toContain("private-diagnostic");
      expect(peer.child()?.exitCode).toBe(0);
      if (mode !== "exit")
        expect(await readFile(resolve(peer.directory, "cleanup"), "utf8")).toBe(
          `${peer.child()?.pid}\n`,
        );
    } finally {
      await peer.cleanup();
    }
  });
}

test("browser host spawn failure rejects promptly without publishing raw errors", async () => {
  const child = spawn("/nonexistent-owned-browser-host", [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  const failure = await ownedBrowserHost({ readinessTimeoutMS: 1000 }, () => child).then(
    () => undefined,
    (cause: Error) => cause,
  );
  expect(failure?.message).toContain("Owned browser host");
  expect(failure?.message).not.toContain("/nonexistent-owned-browser-host");
  expect(closed).toBe(true);
});

for (const mode of ["cleanup-failure", "stuck-cleanup"]) {
  test(`browser host ${mode} never reports successful resource cleanup`, async () => {
    const peer = await probe(mode);
    try {
      const fixture = await ownedBrowserHost({ cleanupTimeoutMS: 100 }, peer.spawnHost);
      await expect(fixture.dispose()).rejects.toThrow(
        mode === "cleanup-failure" ? "resource cleanup failed: 7" : "resource cleanup unconfirmed",
      );
      expect(await readFile(resolve(peer.directory, "cleanup"), "utf8")).toBe(
        `${peer.child()?.pid}\n`,
      );
      if (mode === "cleanup-failure") expect(peer.child()?.exitCode).toBe(7);
      else expect(peer.child()?.signalCode).toBe("SIGKILL");
    } finally {
      await peer.cleanup();
    }
  });
}

test("maintained browser CLI starts Playwright with explicit arguments/environment and no workspace dotenv", async () => {
  const peer = await probe();
  const files = [
    "scripts/testing/browser.ts",
    "scripts/testing/test-prerequisites.ts",
    "scripts/owned-client-process.ts",
  ];
  try {
    for (const file of files) {
      const target = resolve(peer.directory, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(resolve(root, file)));
    }
    const build = resolve(peer.directory, "test/fixtures/browser-build.ts");
    await mkdir(dirname(build), { recursive: true });
    await writeFile(
      build,
      'export function prepareBrowserBuild() { throw Error("No build in discovery"); }',
    );
    const cli = resolve(peer.directory, "node_modules/@playwright/test/cli.js");
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(
      cli,
      `console.log(JSON.stringify({
        args: process.argv.slice(2),
        probe: process.env.FACTORY_BROWSER_ENV_PROBE ?? "isolated",
        explicit: process.env.OWNED_CLI_PROBE,
      }));`,
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      OWNED_CLI_PROBE: "explicit-owned-input",
    };
    delete environment["FACTORY_BROWSER_ENV_PROBE"];
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/testing/browser.ts", "--list"],
      { cwd: peer.directory, env: environment, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      args: ["test", "--list"],
      probe: "isolated",
      explicit: "explicit-owned-input",
    });
  } finally {
    await peer.cleanup();
  }
});
