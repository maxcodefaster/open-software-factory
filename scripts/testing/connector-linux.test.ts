import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the real check launcher in a subprocess. Docker's deliberately small
// stand-in records daemon-side lifetime separately from the docker CLI process.
const docker = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), root = process.env.CONNECTOR_LAUNCHER_TEST;
const state = root + "/state", log = root + "/calls";
appendFileSync(log, JSON.stringify(args) + "\\n");
const saved = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
if (args[0] === "network" && args[1] === "create") {
  saved.owner = args[args.indexOf("--label") + 1].split("=")[1];
  writeFileSync(state, JSON.stringify(saved));
  if (process.env.CONNECTOR_LAUNCHER_PHASE === "network") await Bun.sleep(300);
} else if (args[0] === "run") {
  saved.container = true; writeFileSync(state, JSON.stringify(saved));
  if (process.env.CONNECTOR_LAUNCHER_PHASE === "complete") process.exit(23);
  setInterval(() => {}, 1000);
} else if (args[0] === "inspect") {
  if (!saved.container) process.exit(1);
  console.log(process.env.CONNECTOR_LAUNCHER_FOREIGN ? "foreign-owner" : saved.owner);
} else if (args[0] === "network" && args[1] === "inspect") {
  console.log(saved.owner);
}
`;

async function fixture(phase = "run", foreign = false) {
  const directory = await mkdtemp(join(tmpdir(), "connector-launcher-"));
  const executable = join(directory, "docker");
  await writeFile(executable, docker);
  await chmod(executable, 0o700);
  const child = Bun.spawn([process.execPath, resolve("scripts/testing/connector-linux.ts")], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
      CONNECTOR_LAUNCHER_TEST: directory,
      CONNECTOR_LAUNCHER_PHASE: phase,
      ...(foreign ? { CONNECTOR_LAUNCHER_FOREIGN: "1" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const calls = async () =>
    (await readFile(join(directory, "calls"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  return {
    child,
    calls,
    output,
    async started(command: string) {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        if ((await calls()).some((args) => args[0] === command)) return;
        if (child.exitCode !== null) throw new Error(`Launcher exited before ${command}`);
        await Bun.sleep(10);
      }
      throw new Error(`Launcher did not reach ${command}`);
    },
    async dispose() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await output;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const) {
  test(`Connector Linux ${signal} removes its exact owned container and network`, async () => {
    const f = await fixture();
    try {
      await f.started("run");
      f.child.kill(signal);
      expect(await f.child.exited).toBe(code);
      const calls = await f.calls();
      const run = calls.find((args) => args[0] === "run");
      const name = run?.[(run?.indexOf("--name") ?? -1) + 1];
      if (!name) throw new Error("Owned Connector fixture name was not recorded");
      expect(name).toMatch(/^factory-connector-check-[a-f0-9-]{36}$/);
      expect(calls).toContainEqual(["rm", "--force", name]);
      expect(calls).toContainEqual(["network", "rm", name]);
    } finally {
      await f.dispose();
    }
  }, 15_000);
}

test("Connector Linux cancellation during network creation never starts the check", async () => {
  const f = await fixture("network");
  try {
    await f.started("network");
    f.child.kill("SIGTERM");
    expect(await f.child.exited).toBe(143);
    const calls = await f.calls();
    expect(calls.some((args) => args[0] === "run")).toBe(false);
    expect(calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(true);
  } finally {
    await f.dispose();
  }
}, 15_000);

test("Connector Linux preserves the check failure after owned cleanup", async () => {
  const f = await fixture("complete");
  try {
    expect(await f.child.exited).toBe(23);
    expect((await f.calls()).some((args) => args[0] === "rm")).toBe(true);
  } finally {
    await f.dispose();
  }
}, 15_000);

test("Connector Linux cancellation refuses cleanup after container ownership changes", async () => {
  const f = await fixture("run", true);
  try {
    await f.started("run");
    f.child.kill("SIGTERM");
    expect(await f.child.exited).toBe(1);
    expect((await f.calls()).some((args) => args[0] === "rm")).toBe(false);
    expect((await f.output)[1]).toContain("container ownership changed");
  } finally {
    await f.dispose();
  }
}, 15_000);
