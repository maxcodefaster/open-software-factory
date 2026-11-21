import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { needsOwnedBrowserHost, runBrowserChecks } from "./browser";

async function runnerFixture(stage: string, postgresUnknown = false) {
  const root = resolve(import.meta.dirname, "../..");
  const parent = resolve(root, ".factory/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "outer-browser-cancellation-"));
  for (const path of ["scripts/testing", "test/fixtures", "bin", "node_modules/@playwright/test"])
    await mkdir(resolve(directory, path), { recursive: true });
  for (const path of [
    "scripts/testing/browser.ts",
    "scripts/testing/test-prerequisites.ts",
    "scripts/owned-client-process.ts",
    "test/fixtures/browser-build.ts",
  ])
    await writeFile(resolve(directory, path), await readFile(resolve(root, path)));
  await writeFile(
    resolve(directory, "fixture-owner.ts"),
    `
import { appendFile, writeFile } from "node:fs/promises";
export const record = (event: string) => appendFile("events", event + "\\n");
export async function observe(stage: string) {
  if (process.env["FIXTURE_STAGE"] !== stage) return;
  const settled = new Promise(resolve => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => setTimeout(resolve, 50));
  });
  await writeFile("ready.json", JSON.stringify({pid: process.pid}));
  await settled;
}
`,
  );
  await writeFile(
    resolve(directory, "test/fixtures/postgres-server.ts"),
    `
import { readFile, rm, writeFile } from "node:fs/promises";
import { record, observe } from "../../fixture-owner";
export async function ownedPostgresServer() {
  const identity = {owner: crypto.randomUUID(), url:"owned-fixture-database"};
  await writeFile("postgres-identity.json", JSON.stringify(identity));
  await writeFile("postgres-owned", identity.owner);
  await record("postgres-started");
  await observe("postgres");
  if (process.env["FIXTURE_POSTGRES_UNKNOWN"]) throw Error("PostgreSQL create outcome unknown");
  await record("postgres-confirmed");
  return {identity, async dispose() {
    if (await readFile("postgres-owned", "utf8") !== identity.owner) throw Error("PostgreSQL ownership mismatch");
    await rm("postgres-owned");
    await record("postgres-disposed");
  }};
}
`,
  );
  await writeFile(
    resolve(directory, "test/fixtures/factory-process.ts"),
    `
import { readFile, writeFile } from "node:fs/promises";
import { record, observe } from "../../fixture-owner";
export async function factoryProcess() {
  await record("factory-started");
  await writeFile("factory-postgres.json", process.env["FACTORY_TEST_POSTGRES"]);
  await observe("factory");
  await record("factory-confirmed");
  const processes = [];
  return {
    id:"owned-factory", base:"http://127.0.0.1:12345", databaseURL:"owned-fixture-database", processes,
    async startPlanningCache() {
      await record("cache-started");
      await observe("cache");
      await record("cache-confirmed");
    },
    async start() {
      await record("server-started");
      const child = Bun.spawn([process.execPath, "--no-env-file", "server.mjs"], {stdout:"inherit", stderr:"inherit"});
      processes.push(child);
      while (!await Bun.file("server-ready.json").exists()) await Bun.sleep(10);
      if (process.env["FIXTURE_STAGE"] === "server") {
        await child.exited;
        throw Error("Owned Factory startup interrupted");
      }
    },
    connect() {
      const client = async () => { await record("seed-query"); return [{id:"owned-admin"}]; };
      client.end = async () => {};
      return {client};
    },
    async dispose() {
      for (const child of processes) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await child.exited;
      }
      await record("factory-disposed");
    },
  };
}
`,
  );
  await writeFile(
    resolve(directory, "server.mjs"),
    `
import {writeFileSync} from "node:fs";
const stop = () => { if (process.env.FIXTURE_STAGE !== "server") process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
writeFileSync("server-ready.json", JSON.stringify({pid:process.pid}));
if (process.env.FIXTURE_STAGE === "server") writeFileSync("ready.json", JSON.stringify({pid:process.pid}));
setInterval(() => {}, 1000);
`,
  );
  await writeFile(
    resolve(directory, "process.mjs"),
    `
import {spawn, spawnSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
const stage = process.env.FIXTURE_COMMAND_STAGE ?? process.argv[2];
await writeFile(stage + "-started", "started");
if (stage === "build") {
  const directory = process.env.FACTORY_BUILD_DIRECTORY;
  await mkdir(directory + "/server", {recursive:true});
  await mkdir(directory + "/client/assets", {recursive:true});
  await writeFile(directory + "/server/entry.js", "owned outer build");
}
if (stage !== process.env.FIXTURE_STAGE) process.exit(0);
const grandchild = spawn("node", ["--input-type=module", "--eval", \`
  import {writeFileSync} from "node:fs";
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  writeFileSync("grandchild.json", JSON.stringify({pid:process.pid}));
  setInterval(() => {}, 1000);
\`], {stdio:"inherit"});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  writeFileSync("command-signal", signal);
  process.exit(0);
});
while (true) {
  try { await readFile("grandchild.json"); break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
}
const group = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {encoding:"utf8"}).stdout.trim());
await writeFile("ready.json", JSON.stringify({pid:process.pid, grandchild:grandchild.pid, group}));
setInterval(() => {}, 1000);
`,
  );
  await writeFile(
    resolve(directory, "node_modules/@playwright/test/cli.js"),
    'process.env.FIXTURE_COMMAND_STAGE = "run"; await import(process.env.FIXTURE_DIRECTORY + "/process.mjs");',
  );
  const mise = resolve(directory, "bin/mise");
  await writeFile(
    mise,
    `#!/bin/sh\nexec node ${JSON.stringify(resolve(directory, "process.mjs"))} build\n`,
  );
  await chmod(mise, 0o755);
  const retained = resolve(directory, ".factory/test-results/application-builds/retained");
  await mkdir(resolve(retained, "server"), { recursive: true });
  await mkdir(resolve(retained, "client/assets"), { recursive: true });
  await writeFile(resolve(retained, "server/entry.js"), "caller-owned build");
  return { directory, stage, retained, postgresUnknown };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    return false;
  }
}

async function bounded<T>(operation: Promise<T>, message: string, milliseconds = 4000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const stage of [
  "build",
  "postgres",
  "postgres-unknown",
  "factory",
  "cache",
  "server",
  "run",
]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const outcome =
      stage === "postgres-unknown"
        ? "retains the unconfirmed create"
        : "joins owned children and closes exact resources";
    test(`outer browser CLI ${signal} during ${stage} ${outcome}`, async () => {
      const fixture = await runnerFixture(
        stage === "postgres-unknown" ? "postgres" : stage,
        stage === "postgres-unknown",
      );
      const child = spawn(process.execPath, ["--no-env-file", "scripts/testing/browser.ts"], {
        cwd: fixture.directory,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${resolve(fixture.directory, "bin")}:${process.env["PATH"]}`,
          FIXTURE_DIRECTORY: fixture.directory,
          FIXTURE_STAGE: fixture.stage,
          FIXTURE_POSTGRES_UNKNOWN: fixture.postgresUnknown ? "1" : undefined,
          FACTORY_BUILD_DIRECTORY: stage === "postgres" ? fixture.retained : undefined,
          FACTORY_BROWSER_BASE_URL: undefined,
          FACTORY_BROWSER_LANE: "ui",
          FACTORY_TEST_POSTGRES: "must-not-adopt-another-owner",
        },
      });
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
      let ready: { pid: number; grandchild?: number; group?: number } | undefined;
      try {
        ready = await (async () => {
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            try {
              return JSON.parse(await readFile(resolve(fixture.directory, "ready.json"), "utf8"));
            } catch {
              await Bun.sleep(20);
            }
          }
          throw new Error(`Outer browser ${stage} did not become ready: ${output}`);
        })();
        child.kill(signal);
        const code = await bounded(
          exited,
          `Outer browser did not finish after ${signal}: ${output}`,
        );
        expect(code, output).toBe(signal === "SIGINT" ? 130 : 143);
        if (ready?.grandchild) {
          expect(alive(ready.grandchild), `owned grandchild ${ready.grandchild} survived`).toBe(
            false,
          );
          expect(await readFile(resolve(fixture.directory, "command-signal"), "utf8")).toBe(signal);
        }
        const server = await readFile(
          resolve(fixture.directory, "server-ready.json"),
          "utf8",
        ).catch(() => undefined);
        if (server) expect(alive(JSON.parse(server).pid)).toBe(false);
        const events = await readFile(resolve(fixture.directory, "events"), "utf8").catch(() => "");
        if (stage === "postgres-unknown") {
          expect(output).toContain("PostgreSQL create outcome unknown");
          expect(events).toBe("postgres-started\n");
          expect(await readFile(resolve(fixture.directory, "postgres-owned"), "utf8")).toBe(
            JSON.parse(await readFile(resolve(fixture.directory, "postgres-identity.json"), "utf8"))
              .owner,
          );
        } else if (stage !== "build") {
          expect(events).toContain("postgres-confirmed\n");
          expect(events).toContain("postgres-disposed\n");
          await expect(access(resolve(fixture.directory, "postgres-owned"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else expect(events).toBe("");
        if (["factory", "cache", "server", "run"].includes(stage)) {
          expect(events).toContain("factory-disposed\n");
          expect(await readFile(resolve(fixture.directory, "factory-postgres.json"), "utf8")).toBe(
            await readFile(resolve(fixture.directory, "postgres-identity.json"), "utf8"),
          );
          expect(events.indexOf("factory-disposed")).toBeLessThan(
            events.indexOf("postgres-disposed"),
          );
        }
        if (stage === "postgres" || stage === "postgres-unknown")
          expect(events).not.toContain("factory-started");
        if (stage === "factory") expect(events).not.toContain("cache-started");
        if (stage === "cache") expect(events).not.toContain("server-started");
        if (stage !== "run")
          await expect(access(resolve(fixture.directory, "run-started"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        expect(await readFile(resolve(fixture.retained, "server/entry.js"), "utf8")).toBe(
          "caller-owned build",
        );
        expect(
          await readdir(resolve(fixture.directory, ".factory/test-results/application-builds")),
        ).toEqual(["retained"]);
      } finally {
        const server = await readFile(
          resolve(fixture.directory, "server-ready.json"),
          "utf8",
        ).catch(() => undefined);
        for (const pid of [
          ready?.grandchild,
          server ? JSON.parse(server).pid : undefined,
          ready?.pid,
          child.pid,
        ]) {
          if (pid && alive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (cause) {
              expect(cause).toMatchObject({ code: "ESRCH" });
            }
          }
        }
        for (const group of new Set([ready?.group, child.pid])) {
          if (group) {
            try {
              process.kill(-group, "SIGKILL");
            } catch (cause) {
              expect(["ESRCH", "EPERM"]).toContain((cause as NodeJS.ErrnoException).code ?? "");
            }
          }
        }
        await exited;
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }, 12_000);
  }
}

for (const stage of ["build", "host", "run", "cleanup"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`browser cancellation during ${stage} keeps ${signal} nonzero and closes exact ownership`, async () => {
      const cancellation = new AbortController();
      const calls: string[] = [];
      const environment = { FACTORY_TEST_POSTGRES: "unrelated PostgreSQL owner" };
      const result = await runBrowserChecks(
        [],
        environment,
        {
          async build(input) {
            calls.push("build");
            input["FACTORY_BUILD_DIRECTORY"] = "/owned/build";
            if (stage === "build") cancellation.abort(signal);
            return async () => {
              calls.push("dispose-build");
            };
          },
          async host() {
            calls.push("host");
            if (stage === "host") {
              cancellation.abort(signal);
              // A create that was already admitted returns its confirmed owner.
              await Bun.sleep(10);
              calls.push("host-confirmed");
            }
            return {
              base: "http://127.0.0.1:12345",
              databaseURL: "owned",
              email: "owned",
              password: "owned",
              async dispose() {
                calls.push("dispose-host");
                if (stage === "cleanup") cancellation.abort(signal);
              },
            };
          },
          async run() {
            calls.push("run");
            if (stage === "run") cancellation.abort(signal);
            return 0;
          },
        },
        cancellation.signal,
      );
      expect(result).toBe(signal === "SIGINT" ? 130 : 143);
      expect(calls).toEqual(
        stage === "build"
          ? ["build", "dispose-build"]
          : stage === "host"
            ? ["build", "host", "host-confirmed", "dispose-host", "dispose-build"]
            : ["build", "host", "run", "dispose-host", "dispose-build"],
      );
      expect(environment).toEqual({ FACTORY_TEST_POSTGRES: "unrelated PostgreSQL owner" });
    });
  }
}

test("browser cancellation before admission starts no setup or caller command", async () => {
  for (const environment of [{}, { FACTORY_BROWSER_BASE_URL: "http://127.0.0.1:12345" }]) {
    const cancellation = new AbortController();
    cancellation.abort("SIGTERM");
    let admitted = false;
    const result = await runBrowserChecks(
      [],
      environment,
      {
        async build() {
          admitted = true;
          return async () => {};
        },
        async host() {
          admitted = true;
          throw new Error("Must not prepare a cancelled host");
        },
        async run() {
          admitted = true;
          return 0;
        },
      },
      cancellation.signal,
    );
    expect(result).toBe(143);
    expect(admitted).toBe(false);
  }
});

test("caller command cancellation preserves its environment and zero exit remains interrupted", async () => {
  const cancellation = new AbortController();
  const environment = { FACTORY_BROWSER_BASE_URL: "http://127.0.0.1:12345" };
  const result = await runBrowserChecks(
    [],
    environment,
    {
      async build() {
        throw new Error("Caller owns the build");
      },
      async host() {
        throw new Error("Caller owns the host");
      },
      async run(_, input, signal) {
        expect(input).toBe(environment);
        expect(signal).toBe(cancellation.signal);
        cancellation.abort("SIGINT");
        return 0;
      },
    },
    cancellation.signal,
  );
  expect(result).toBe(130);
});

test("cancelled cleanup failures remain observable and still close the owned build", async () => {
  const cancellation = new AbortController();
  let buildDisposed = false;
  await expect(
    runBrowserChecks(
      [],
      {},
      {
        async build() {
          return async () => {
            buildDisposed = true;
          };
        },
        async host() {
          return {
            base: "http://127.0.0.1:12345",
            databaseURL: "owned",
            email: "owned",
            password: "owned",
            async dispose() {
              throw new Error("Host cleanup outcome unknown");
            },
          };
        },
        async run() {
          cancellation.abort("SIGTERM");
          return 0;
        },
      },
      cancellation.signal,
    ),
  ).rejects.toThrow("Host cleanup outcome unknown");
  expect(buildDisposed).toBe(true);
});

test("direct UI checks own their host but discovery, explicit targets and live lanes do not", () => {
  expect(needsOwnedBrowserHost([], {})).toBe(true);
  expect(needsOwnedBrowserHost(["test/browser/usage-settings.spec.ts"], {})).toBe(true);
  for (const arg of ["--list", "--help", "-h"])
    expect(needsOwnedBrowserHost([arg], {})).toBe(false);
  for (const lane of ["native", "paid"])
    expect(needsOwnedBrowserHost([], { FACTORY_BROWSER_LANE: lane })).toBe(false);
  expect(needsOwnedBrowserHost([], { FACTORY_BROWSER_BASE_URL: "http://127.0.0.1:12345" })).toBe(
    false,
  );
});

for (const outcome of ["success", "failure", "throw", "host-failure", "cleanup-failure"] as const) {
  test(`owned browser ${outcome} retains the child verdict and cleans only its host and build`, async () => {
    const calls: string[] = [];
    const environment = {
      DATABASE_URL: "must-not-use-retained-database",
      FACTORY_ADMIN_PASSWORD: "must-not-use-retained-password",
      FACTORY_MODEL_API_KEY: "must-not-reach-child",
      FACTORY_LEARNING_MODEL_LIVE: "1",
      FACTORY_TEST_POSTGRES: "must-not-adopt-another-fixture",
    };
    const args = ["test/browser/usage-settings.spec.ts"];
    const result = runBrowserChecks(args, environment, {
      async build(input) {
        calls.push("build");
        input["FACTORY_BUILD_DIRECTORY"] = "/owned/browser-build";
        return async () => {
          calls.push("dispose-build");
        };
      },
      async host(input) {
        calls.push("host");
        expect(input["FACTORY_TEST_POSTGRES"]).toBeUndefined();
        expect(input["FACTORY_MODEL_API_KEY"]).toBeUndefined();
        expect(input["FACTORY_LEARNING_MODEL_LIVE"]).toBeUndefined();
        expect(input["FACTORY_BUILD_DIRECTORY"]).toBe("/owned/browser-build");
        if (outcome === "host-failure") throw new Error("Host preparation failed");
        return {
          base: "http://127.0.0.1:34567",
          databaseURL: "owned-database",
          email: "owned-admin",
          password: "owned-password",
          async dispose() {
            calls.push("dispose-host");
            if (outcome === "cleanup-failure") throw new Error("Host cleanup failed");
          },
        };
      },
      async run(selection, input) {
        calls.push("run");
        expect(selection).toEqual(args);
        expect(input["FACTORY_BROWSER_BASE_URL"]).toBe("http://127.0.0.1:34567");
        expect(input["DATABASE_URL"]).toBe("owned-database");
        expect(input["FACTORY_ADMIN_EMAIL"]).toBe("owned-admin");
        expect(input["FACTORY_ADMIN_PASSWORD"]).toBe("owned-password");
        expect(input["FACTORY_MODEL_API_KEY"]).toBeUndefined();
        expect(input["FACTORY_LEARNING_MODEL_LIVE"]).toBeUndefined();
        expect(input["FACTORY_BUILD_DIRECTORY"]).toBe("/owned/browser-build");
        if (outcome === "throw") throw new Error("Browser launch failed");
        return outcome === "failure" ? 7 : 0;
      },
    });
    if (outcome === "host-failure") await expect(result).rejects.toThrow("Host preparation failed");
    else if (outcome === "cleanup-failure")
      await expect(result).rejects.toThrow("Host cleanup failed");
    else if (outcome === "throw") await expect(result).rejects.toThrow("Browser launch failed");
    else expect(await result).toBe(outcome === "failure" ? 7 : 0);
    expect(calls).toEqual(
      outcome === "host-failure"
        ? ["build", "host", "dispose-build"]
        : ["build", "host", "run", "dispose-host", "dispose-build"],
    );
    expect(environment.DATABASE_URL).toBe("must-not-use-retained-database");
    expect(environment.FACTORY_ADMIN_PASSWORD).toBe("must-not-use-retained-password");
    expect(environment.FACTORY_MODEL_API_KEY).toBe("must-not-reach-child");
    expect("FACTORY_BUILD_DIRECTORY" in environment).toBe(false);
  });
}

test("an explicit caller keeps its environment and owns its existing host", async () => {
  const environment = {
    FACTORY_BROWSER_BASE_URL: "http://127.0.0.1:12345",
    DATABASE_URL: "caller-database",
    FACTORY_BUILD_DIRECTORY: "/caller/build",
  };
  const code = await runBrowserChecks(["--project=ui"], environment, {
    async build() {
      throw new Error("Must not build for caller");
    },
    async host() {
      throw new Error("Must not replace caller");
    },
    async run(args, input) {
      expect(args).toEqual(["--project=ui"]);
      expect(input).toBe(environment);
      return 3;
    },
  });
  expect(code).toBe(3);
});
