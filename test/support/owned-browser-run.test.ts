import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareBrowserBuild } from "../fixtures/browser-build";

async function browserFixture() {
  const root = resolve(import.meta.dirname, "../..");
  const parent = resolve(root, ".factory/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "browser-build-ownership-"));
  for (const path of ["scripts/testing", "test/fixtures"])
    await mkdir(resolve(directory, path), { recursive: true });
  for (const path of [
    "scripts/testing/test-prerequisites.ts",
    "scripts/owned-client-process.ts",
    "test/fixtures/browser-build.ts",
    "test/fixtures/owned-browser-run.ts",
  ])
    await writeFile(resolve(directory, path), await readFile(resolve(root, path)));
  // Resolve the same installed dependencies without installing anything in the fixture.
  const { symlink } = await import("node:fs/promises");
  await symlink(resolve(root, "node_modules"), resolve(directory, "node_modules"), "dir");
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({ scripts: { "factory:build": "node fake-build.mjs" } }),
  );
  await writeFile(
    resolve(directory, "fake-build.mjs"),
    `import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const directory = process.env.FACTORY_BUILD_DIRECTORY;
await writeFile("build-called", directory);
await mkdir(directory + "/server", {recursive: true});
await mkdir(directory + "/client/assets", {recursive: true});
await writeFile(directory + "/server/entry.js", "owned browser build");
if (process.env.BUILD_FAILURE) { console.error("controlled build failure"); process.exit(7); }
if (process.env.CANCEL_BUILD) {
  const grandchild = spawn("node", ["--input-type=module", "--eval", \`
    import {writeFileSync} from "node:fs";
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => {});
    writeFileSync("grandchild.json", JSON.stringify({pid:process.pid}));
    setInterval(() => {}, 1000);
  \`], {stdio:"inherit"});
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
  while (true) {
    try { await readFile("grandchild.json"); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await writeFile("ready.json", JSON.stringify({pid:process.pid, grandchild:grandchild.pid}));
  setInterval(() => {}, 1000);
}
`,
  );
  await writeFile(
    resolve(directory, "test/fixtures/postgres-server.ts"),
    `import { writeFile, readFile, rm } from "node:fs/promises";
const identity = { owner: crypto.randomUUID(), url: "postgresql://unused/owned" };
export async function closeOwnedPostgresServer(input) {
  const owner = JSON.parse(await readFile("postgres-owned", "utf8"));
  if (input.owner !== owner.owner) throw new Error("PostgreSQL ownership mismatch");
  if (process.env.CLOSE_FAILURE) throw new Error("PostgreSQL cleanup outcome unknown");
  await rm("postgres-owned");
  await writeFile("postgres-disposed", "disposed");
}
export async function ownedPostgresServer() {
  await writeFile("postgres-owned", JSON.stringify(identity));
  if (process.env.CANCEL_DATABASE) {
    const settled = new Promise(resolve => {
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => setTimeout(resolve, 50));
    });
    await writeFile("ready.json", JSON.stringify({pid:process.pid}));
    await settled;
  }
  return {identity, dispose: () => closeOwnedPostgresServer(identity)};
}`,
  );
  const id = crypto.randomUUID();
  const state = resolve(directory, ".factory/test-results/browser-runs", id, "state.json");
  async function command(action: string, environment: Record<string, string | undefined>) {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "test/fixtures/owned-browser-run.ts", action, id],
      { cwd: directory, env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }
  return { directory, id, state, command };
}

test("owned browser setup borrows the outer invocation build and close retains it", async () => {
  const fixture = await browserFixture();
  const environment: Record<string, string | undefined> = {};
  let builds = 0;
  const dispose = await prepareBrowserBuild(environment, async (input) => {
    builds++;
    const directory = input["FACTORY_BUILD_DIRECTORY"] ?? "";
    await mkdir(resolve(directory, "server"), { recursive: true });
    await mkdir(resolve(directory, "client/assets"), { recursive: true });
    await writeFile(resolve(directory, "server/entry.js"), "outer invocation build");
  });
  const borrowed = environment["FACTORY_BUILD_DIRECTORY"] ?? "";
  try {
    const setup = await fixture.command("setup", environment);
    expect(setup.code, setup.stderr).toBe(0);
    await expect(access(resolve(fixture.directory, "build-called"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const state = JSON.parse(await readFile(fixture.state, "utf8"));
    expect(state.build).toEqual({ directory: borrowed, ownership: "borrowed" });
    const reader = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        'const {ownedBrowserEnvironment} = await import("./test/fixtures/owned-browser-run.ts"); console.log(JSON.stringify(await ownedBrowserEnvironment()));',
      ],
      {
        cwd: fixture.directory,
        env: { ...process.env, FACTORY_BROWSER_RUN_ID: fixture.id },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const input = JSON.parse(await new Response(reader.stdout).text());
    expect(await reader.exited).toBe(0);
    expect(input.FACTORY_BUILD_DIRECTORY).toBe(borrowed);
    expect(JSON.parse(input.FACTORY_TEST_POSTGRES)).toEqual(state.postgres);
    const close = await fixture.command("close", environment);
    expect(close.code, close.stderr).toBe(0);
    expect(await readFile(resolve(borrowed, "server/entry.js"), "utf8")).toBe(
      "outer invocation build",
    );
    expect(builds).toBe(1);
    await expect(access(fixture.state)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(resolve(fixture.directory, "postgres-disposed"), "utf8")).toBe(
      "disposed",
    );
  } finally {
    await dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a failed owned build removes its partial artifact before admitting PostgreSQL", async () => {
  const fixture = await browserFixture();
  const build = resolve(
    fixture.directory,
    ".factory/test-results/application-builds",
    `browser-${fixture.id}`,
  );
  try {
    const setup = await fixture.command("setup", {
      FACTORY_BUILD_DIRECTORY: undefined,
      BUILD_FAILURE: "1",
    });
    expect(setup.code).not.toBe(0);
    expect(setup.stderr).toContain("Owned browser build failed");
    expect(await readFile(resolve(fixture.state, "../build.log"), "utf8")).toContain(
      "controlled build failure",
    );
    for (const path of [build, fixture.state, resolve(fixture.directory, "postgres-owned")])
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an incomplete borrowed build is refused before creating PostgreSQL or replacing output", async () => {
  const fixture = await browserFixture();
  const build = resolve(fixture.directory, "caller-build");
  await mkdir(build);
  await writeFile(resolve(build, "sentinel"), "caller artifact");
  try {
    const setup = await fixture.command("setup", { FACTORY_BUILD_DIRECTORY: build });
    expect(setup.code).not.toBe(0);
    for (const path of ["build-called", "postgres-owned"])
      await expect(access(resolve(fixture.directory, path))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(await readFile(resolve(build, "sentinel"), "utf8")).toBe("caller artifact");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const ownership of ["owned", "borrowed"]) {
  test(`unconfirmed PostgreSQL cleanup retains ${ownership} build and the exact state for retry`, async () => {
    const fixture = await browserFixture();
    const build = resolve(fixture.directory, "caller-build");
    const environment = { FACTORY_BUILD_DIRECTORY: ownership === "borrowed" ? build : undefined };
    if (ownership === "borrowed") {
      await mkdir(resolve(build, "server"), { recursive: true });
      await mkdir(resolve(build, "client/assets"), { recursive: true });
      await writeFile(resolve(build, "server/entry.js"), "caller artifact");
    }
    try {
      const setup = await fixture.command("setup", environment);
      expect(setup.code, setup.stderr).toBe(0);
      const original = await readFile(fixture.state, "utf8");
      const state = JSON.parse(original);
      const close = await fixture.command("close", { ...environment, CLOSE_FAILURE: "1" });
      expect(close.code).not.toBe(0);
      expect(close.stderr).toContain("PostgreSQL cleanup outcome unknown");
      expect(await readFile(fixture.state, "utf8")).toBe(original);
      await access(resolve(state.build.directory, "server/entry.js"));
      const retry = await fixture.command("close", { ...environment, CLOSE_FAILURE: undefined });
      expect(retry.code, retry.stderr).toBe(0);
      if (ownership === "borrowed")
        expect(await readFile(resolve(build, "server/entry.js"), "utf8")).toBe("caller artifact");
      else await expect(access(state.build.directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("cleanup refuses a state that claims another owner's build directory", async () => {
  const fixture = await browserFixture();
  const environment = { FACTORY_BUILD_DIRECTORY: undefined };
  try {
    const setup = await fixture.command("setup", environment);
    expect(setup.code, setup.stderr).toBe(0);
    const source = await readFile(fixture.state, "utf8");
    const state = JSON.parse(source);
    state.build.directory = resolve(fixture.directory, "other-owner");
    await mkdir(state.build.directory);
    await writeFile(fixture.state, JSON.stringify(state));
    const close = await fixture.command("close", environment);
    expect(close.code).not.toBe(0);
    expect(close.stderr).toContain("Owned browser run identity mismatch");
    await access(resolve(fixture.directory, "postgres-owned"));
    await access(state.build.directory);
    await writeFile(fixture.state, source);
    expect((await fixture.command("close", environment)).code).toBe(0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const stage of ["build", "database"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`browser setup ${signal} during ${stage} cleans its confirmed ownership`, async () => {
      const fixture = await browserFixture();
      const borrowed = resolve(fixture.directory, "caller-build");
      if (stage === "database") {
        await mkdir(resolve(borrowed, "server"), { recursive: true });
        await mkdir(resolve(borrowed, "client/assets"), { recursive: true });
        await writeFile(resolve(borrowed, "server/entry.js"), "caller artifact");
      }
      const child = spawn(
        process.execPath,
        ["--no-env-file", "test/fixtures/owned-browser-run.ts", "setup", fixture.id],
        {
          cwd: fixture.directory,
          env: {
            ...process.env,
            FACTORY_BUILD_DIRECTORY: stage === "database" ? borrowed : undefined,
            CANCEL_BUILD: stage === "build" ? "1" : undefined,
            CANCEL_DATABASE: stage === "database" ? "1" : undefined,
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk;
      });
      const exited = new Promise<number | null>((complete, fail) => {
        child.once("error", fail);
        child.once("exit", complete);
      });
      let ready: { pid: number; grandchild?: number } | undefined;
      try {
        const deadline = Date.now() + 4000;
        while (!ready) {
          try {
            ready = JSON.parse(await readFile(resolve(fixture.directory, "ready.json"), "utf8"));
          } catch {
            if (Date.now() >= deadline) throw new Error(`Browser setup not ready: ${output}`);
            await Bun.sleep(20);
          }
        }
        child.kill(signal);
        const code = await exited;
        expect(code, output).toBe(signal === "SIGINT" ? 130 : 143);
        if (ready?.grandchild) expect(() => process.kill(ready?.grandchild ?? 0, 0)).toThrow();
        await expect(access(fixture.state)).rejects.toMatchObject({ code: "ENOENT" });
        const owned = resolve(
          fixture.directory,
          ".factory/test-results/application-builds",
          `browser-${fixture.id}`,
        );
        await expect(access(owned)).rejects.toMatchObject({ code: "ENOENT" });
        if (stage === "database") {
          expect(await readFile(resolve(borrowed, "server/entry.js"), "utf8")).toBe(
            "caller artifact",
          );
          expect(await readFile(resolve(fixture.directory, "postgres-disposed"), "utf8")).toBe(
            "disposed",
          );
        } else
          await expect(access(resolve(fixture.directory, "postgres-owned"))).rejects.toMatchObject({
            code: "ENOENT",
          });
      } finally {
        for (const pid of [ready?.grandchild, ready?.pid, child.pid]) {
          if (pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (cause) {
              expect(cause).toMatchObject({ code: "ESRCH" });
            }
          }
        }
        await exited;
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }, 12_000);
  }
}

test("owned browser setup records its independent build and close deletes exactly that artifact", async () => {
  const fixture = await browserFixture();
  const environment = { FACTORY_BUILD_DIRECTORY: undefined };
  try {
    const setup = await fixture.command("setup", environment);
    expect(setup.code, setup.stderr).toBe(0);
    const state = JSON.parse(await readFile(fixture.state, "utf8"));
    expect(state.build).toEqual({
      directory: resolve(
        fixture.directory,
        ".factory/test-results/application-builds",
        `browser-${fixture.id}`,
      ),
      ownership: "owned",
    });
    const close = await fixture.command("close", environment);
    expect(close.code, close.stderr).toBe(0);
    await expect(access(state.build.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(fixture.state)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const collision of ["evidence", "build"] as const) {
  test(`owned browser setup refuses an existing ${collision} before creating resources`, async () => {
    const id = crypto.randomUUID();
    const evidence = resolve(".factory/test-results/browser-runs", id);
    const build = resolve(".factory/test-results/application-builds", `browser-${id}`);
    const occupied = collision === "evidence" ? evidence : build;
    await mkdir(occupied, { recursive: true });
    const sentinel = resolve(occupied, "existing.txt");
    await writeFile(sentinel, "Retain the existing run");
    try {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "test/fixtures/owned-browser-run.ts", "setup", id],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("EEXIST");
      expect(stdout).not.toContain("Owned test PostgreSQL intended");
      expect(await readFile(sentinel, "utf8")).toBe("Retain the existing run");
    } finally {
      await rm(evidence, { recursive: true, force: true });
      await rm(build, { recursive: true, force: true });
    }
  });
}
