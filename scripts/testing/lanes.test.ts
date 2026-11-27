import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import playwright from "../../playwright.config";
import {
  browserLane,
  controllerNeedsDatabase,
  integrationLane,
  integrationNeedsApplicationBuild,
  laneSelections,
} from "./lanes";

async function laneFixture(phase: string) {
  const root = resolve(import.meta.dirname, "../..");
  const parent = resolve(root, ".factory/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "lane-cancellation-"));
  for (const path of ["scripts/testing", "test/integration", "test/fixtures", "bin"])
    await mkdir(resolve(directory, path), { recursive: true });
  for (const path of [
    "scripts/testing/lanes.ts",
    "scripts/testing/test-prerequisites.ts",
    "scripts/owned-client-process.ts",
  ])
    await writeFile(resolve(directory, path), await readFile(resolve(root, path)));
  await writeFile(resolve(directory, "test/integration/starter.test.ts"), "");
  await mkdir(resolve(directory, "templates/starter-app/.factory"), { recursive: true });
  for (const path of ["package.json", "package-lock.json"])
    await writeFile(resolve(directory, "templates/starter-app", path), "{}");
  await writeFile(
    resolve(directory, "templates/starter-app/.factory/repair-framework-export.mjs"),
    "",
  );
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({ scripts: { "factory:build": "node fixture-process.mjs build" } }),
  );
  await writeFile(
    resolve(directory, "test/fixtures/postgres-server.ts"),
    `import { writeFile, rm } from "node:fs/promises";
const directory = process.env["FIXTURE_DIRECTORY"];
export async function ownedPostgresServer() {
  await writeFile(directory + "/database", "owned");
  if (process.env["FIXTURE_FAIL"] === "database") throw new Error("Database create outcome unknown");
  if (process.env["FIXTURE_PHASE"] === "database") {
    const settled = new Promise(resolve => {
      const settle = () => setTimeout(resolve, 50);
      process.once("SIGINT", settle);
      process.once("SIGTERM", settle);
    });
    await writeFile(directory + "/ready.json", JSON.stringify({ pid: process.pid }));
    await settled;
  }
  return { identity: { owner: "fixture", url: "unused" }, async dispose() {
    if (process.env["FIXTURE_FAIL"] === "cleanup") throw new Error("Database cleanup outcome unknown");
    await rm(directory + "/database");
    await writeFile(directory + "/disposed", "owned database disposed");
  }};
}`,
  );
  await writeFile(
    resolve(directory, "fixture-process.mjs"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const directory = process.env.FIXTURE_DIRECTORY;
const phase = process.argv[2];
await writeFile(directory + "/" + phase + "-started", "started");
if (phase === "build") {
  await mkdir(process.env.FACTORY_BUILD_DIRECTORY, { recursive: true });
  await writeFile(process.env.FACTORY_BUILD_DIRECTORY + "/partial", "owned build");
}
if (process.env.FIXTURE_FAIL === phase) process.exit(7);
if (phase !== process.env.FIXTURE_PHASE) process.exit(0);
const grandchild = spawn("node", ["--input-type=module", "--eval", \`
  import { writeFileSync } from "node:fs";
  process.on("SIGINT", () => writeFileSync(process.env.FIXTURE_DIRECTORY + "/grandchild-signal", "SIGINT"));
  process.on("SIGTERM", () => writeFileSync(process.env.FIXTURE_DIRECTORY + "/grandchild-signal", "SIGTERM"));
  writeFileSync(process.env.FIXTURE_DIRECTORY + "/grandchild.json", JSON.stringify({pid: process.pid}));
  setInterval(() => {}, 1000);
\`], { stdio: "inherit" });
while (true) {
  try { await readFile(directory + "/grandchild.json"); break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
}
// A successful direct-child exit must not hide the interrupt or spare its stubborn descendant.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  writeFileSync(directory + "/child-signal", signal);
  process.exit(0);
});
await writeFile(directory + "/ready.json", JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`,
  );
  for (const [name, stage] of [
    ["mise", "runner"],
    ["npm", "prerequisite"],
  ]) {
    const path = resolve(directory, "bin", name ?? "");
    await writeFile(
      path,
      `#!/bin/sh\nexec node ${JSON.stringify(resolve(directory, "fixture-process.mjs"))} ${stage}\n`,
    );
    await chmod(path, 0o755);
  }
  return { directory, phase };
}

for (const outcome of ["success", "runner", "build", "database", "cleanup"]) {
  test(`lane ${outcome} preserves the verdict and never adopts an uncertain database`, async () => {
    const { directory } = await laneFixture("none");
    const retained = resolve(directory, ".factory/test-results/application-builds/retained");
    await mkdir(retained, { recursive: true });
    await writeFile(resolve(retained, "sentinel"), "other owner's build");
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/testing/lanes.ts", "controllers"],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${resolve(directory, "bin")}:${process.env["PATH"]}`,
          FIXTURE_DIRECTORY: directory,
          FIXTURE_PHASE: "none",
          FIXTURE_FAIL: outcome,
          FACTORY_BUILD_DIRECTORY: retained,
          FACTORY_TEST_POSTGRES: "unrelated identity",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stdout + stderr).toBe(outcome === "success" ? 0 : outcome === "runner" ? 7 : 1);
      expect(await readFile(resolve(retained, "sentinel"), "utf8")).toBe("other owner's build");
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(resolve(directory, ".factory/test-results/application-builds"))).toEqual(
        ["retained"],
      );
      if (outcome === "database" || outcome === "cleanup") {
        expect(stderr).toContain(
          `Database ${outcome === "database" ? "create" : "cleanup"} outcome unknown`,
        );
        expect(await readFile(resolve(directory, "database"), "utf8")).toBe("owned");
        await expect(access(resolve(directory, "disposed"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else if (outcome !== "build") {
        expect(await readFile(resolve(directory, "disposed"), "utf8")).toBe(
          "owned database disposed",
        );
      }
      if (outcome === "build" || outcome === "database")
        await expect(access(resolve(directory, "runner-started"))).rejects.toMatchObject({
          code: "ENOENT",
        });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function eventually<T>(read: () => Promise<T>, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return await read();
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await Bun.sleep(20);
    }
  }
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

for (const phase of ["prerequisite", "build", "database", "runner"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`lane ${signal} during ${phase} reaps its tree, stops admissions and cleans owned output`, async () => {
      const { directory } = await laneFixture(phase);
      const child = spawn(
        process.execPath,
        ["--no-env-file", "scripts/testing/lanes.ts", "controllers"],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${resolve(directory, "bin")}:${process.env["PATH"]}`,
            FIXTURE_DIRECTORY: directory,
            FIXTURE_PHASE: phase,
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
        ready = await eventually(async () =>
          JSON.parse(await readFile(resolve(directory, "ready.json"), "utf8")),
        );
        child.kill(signal);
        const code = await Promise.race([
          exited,
          Bun.sleep(4000).then(() => {
            throw new Error(`Lane did not finish after ${signal}: ${output}`);
          }),
        ]);
        if (ready?.grandchild) {
          const pid = ready.grandchild;
          await eventually(async () => {
            expect(alive(pid), `grandchild ${pid} still running after lane exit`).toBe(false);
          }, 1500);
          expect(await readFile(resolve(directory, "grandchild-signal"), "utf8")).toBe(signal);
          expect(await readFile(resolve(directory, "child-signal"), "utf8")).toBe(signal);
        }
        expect(code, output).toBe(signal === "SIGINT" ? 130 : 143);
        if (phase !== "runner")
          await expect(access(resolve(directory, "runner-started"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        if (phase === "database" || phase === "runner") {
          expect(await readFile(resolve(directory, "disposed"), "utf8")).toBe(
            "owned database disposed",
          );
          await expect(access(resolve(directory, "database"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        const builds = resolve(directory, ".factory/test-results/application-builds");
        const { readdir } = await import("node:fs/promises");
        expect(await readdir(builds).catch(() => [])).toEqual([]);
      } finally {
        for (const pid of [ready?.grandchild, ready?.pid, child.pid]) {
          if (pid && alive(pid)) process.kill(pid, "SIGKILL");
        }
        await exited;
        await rm(directory, { recursive: true, force: true });
      }
    }, 12_000);
  }
}

test("explicit lanes keep paid calls and retained-installation restarts outside defaults", () => {
  expect(integrationLane("test/integration/backup-runner.native.test.ts")).toBe("native");
  expect(controllerNeedsDatabase("test/integration/backup-runner.native.test.ts")).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/backup-runner.native.test.ts")).toBe(
    false,
  );
  expect(integrationLane("test/integration/project-environment.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/native-skill-loading.test.ts")).toBe("native");
  expect(integrationLane("test/integration/substrate-adapter.native.test.ts")).toBe("native");
  expect(integrationLane("test/integration/substrate-workspaces.native.test.ts")).toBe("native");
  expect(integrationLane("test/integration/developer-ide-kubernetes.native.test.ts")).toBe(
    "native",
  );
  expect(integrationLane("test/integration/substrate-workspaces.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/substrate-verification.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/substrate-source.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/substrate-adapter.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/project-environments.live.test.ts")).toBe("live");
  expect(integrationLane("test/integration/openbao.test.ts")).toBe("native");
  expect(browserLane("agent-turn-live.spec.ts")).toBe("paid");
  expect(browserLane("project-agent.spec.ts")).toBe("paid");
  expect(browserLane("runtime-console.spec.ts")).toBe("native");
  expect(browserLane("skill-settings.spec.ts")).toBe("ui");
  expect(() => browserLane("unclassified.live.spec.ts")).toThrow("Unclassified");
});

test("native file sharding is separate from exact test filters and never starts unselected lanes", () => {
  expect(laneSelections(["test/integration/change-agent-turns.test.ts", "--shard=1/2"])).toEqual({
    filters: ["test/integration/change-agent-turns.test.ts"],
    flags: ["--shard=1/2"],
  });
  expect(laneSelections(["--shard=2/2", "--list"])).toEqual({
    filters: [],
    flags: ["--shard=2/2"],
  });
  for (const args of [
    ["--shard=0/2"],
    ["--shard=3/2"],
    ["--shard=1/0"],
    ["--shard=one/two"],
    ["--shard=1/9007199254740992"],
    ["--shard=1/2", "--shard=2/2"],
  ])
    expect(() => laneSelections(args)).toThrow();
});

test("writer input Stop requires native OpenCode but polling-only proofs stay in controllers", () => {
  expect(integrationLane("test/integration/substrate-writer-input-stop.test.ts")).toBe("native");
  for (const name of [
    "candidate-review-delivery",
    "candidate-review",
    "review-recording",
    "session-archive-store",
  ])
    expect(integrationLane(`test/integration/${name}.test.ts`)).toBe("controllers");
});

test("the native adapter owns its database and needs no compiled Factory application", () => {
  const component = "test/integration/substrate-adapter.native.test.ts";
  const product = "test/integration/substrate-workspaces.native.test.ts";
  expect(integrationNeedsApplicationBuild(component)).toBe(false);
  expect(controllerNeedsDatabase(component)).toBe(false);
  expect(integrationNeedsApplicationBuild(product)).toBe(true);
  expect(controllerNeedsDatabase("test/integration/bootstrap.test.ts")).toBe(true);
  expect([component].some(integrationNeedsApplicationBuild)).toBe(false);
  expect([component, product].some(integrationNeedsApplicationBuild)).toBe(true);
});

test("native Browser and usage controllers share only their lane's PostgreSQL server, without an application build", () => {
  for (const name of ["substrate-browser", "substrate-usage"]) {
    const path = `test/integration/${name}.test.ts`;
    expect(integrationLane(path)).toBe("controllers");
    expect(controllerNeedsDatabase(path)).toBe(true);
    expect(integrationNeedsApplicationBuild(path)).toBe(false);
  }
});

test("the default browser selection excludes explicitly paid cases in mixed journey files", () => {
  const filter = playwright.grepInvert;
  expect(filter).toBeInstanceOf(RegExp);
  expect((filter as RegExp).test("ticket journey real Luna @paid")).toBe(true);
  expect((filter as RegExp).test("ticket journey personal rich draft")).toBe(false);
});

test("self-contained protocol and PostgreSQL proofs do not acquire an unused shared database", () => {
  for (const name of ["attachments-store", "conversation-persistence", "review-media"]) {
    const path = `test/integration/${name}.test.ts`;
    expect(controllerNeedsDatabase(path)).toBe(false);
    expect(integrationNeedsApplicationBuild(path)).toBe(false);
  }
  expect(controllerNeedsDatabase("test/integration/substrate-adapter.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-adapter.native.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/developer-ide-kubernetes.native.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/native-project-releases.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/schema-baseline.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-workspaces.native.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/substrate-workspaces.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-verification.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-runtime-list.test.ts")).toBe(false);
  expect(integrationLane("test/integration/substrate-runtime-list.test.ts")).toBe("controllers");
  for (const name of [
    "runtime-app-origins",
    "runtime-declared-apps",
    "verification-cancellation",
    "usage-cleanup",
  ]) {
    const path = `test/integration/${name}.test.ts`;
    expect(integrationLane(path)).toBe("controllers");
    expect(controllerNeedsDatabase(path)).toBe(false);
  }
  expect(controllerNeedsDatabase("test/integration/substrate-source.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/source-startup.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/native-project-entry.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-source-seed.test.ts")).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/substrate-source-seed.test.ts")).toBe(
    false,
  );
  expect(integrationNeedsApplicationBuild("test/integration/substrate-workspaces.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/openbao.test.ts")).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/openbao.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/postgres-baseline.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-knowledge.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-workspaces.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-attachments.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-writer-review.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-mcp-inputs.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-setup.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-skills.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-settings.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-access.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-functions.test.ts")).toBe(true);
  expect(controllerNeedsDatabase("test/integration/bootstrap.test.ts")).toBe(true);
  expect(controllerNeedsDatabase("test/integration/project-setup-observation.test.ts")).toBe(true);
});

test("database-only feature checks skip the application build while endpoint checks keep it", () => {
  for (const name of [
    "schema-baseline",
    "postgres-baseline",
    "project-release-store",
    "project-registration-authority",
    "mcp-library",
    "mcp-oauth",
    "mcp-cancellation",
    "agent-read",
    "agent-turn-store",
    "coding-source-dispatch-fence",
    "retained-stop-maintenance",
    "substrate-input-stop",
    "fixture-cleanup",
    "native-ui-fixture",
    "change-document-drizzle",
    "delivery-controller-drizzle",
    "inbox",
    "skills-controllers-drizzle",
    "substrate-drizzle",
    "substrate-bound-provisioning",
    "substrate-lifecycle-facts",
    "usage-journal",
    "usage-policy",
    "coding-budget",
    "workspace-sharing",
    "workspace-commands",
    "workspace-container-files",
    "substrate-source",
    "substrate-source-access",
    "source-startup",
    "substrate-workspace-generations",
    "developer-ide",
    "developer-ide-access-recovery",
  ])
    expect(integrationNeedsApplicationBuild(`test/integration/${name}.test.ts`)).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/server-function-runtime.test.ts")).toBe(
    true,
  );
  expect(controllerNeedsDatabase("test/integration/project-registration-authority.test.ts")).toBe(
    true,
  );
});

test("structural naming conventions classify new integration proofs without listing every file", () => {
  expect(integrationLane("test/integration/example-feature.native.test.ts")).toBe("native");
  expect(integrationLane("test/integration/example-feature.native.live.test.ts")).toBe("live");
  expect(integrationNeedsApplicationBuild("test/integration/example-drizzle.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/example-drizzle.test.ts")).toBe(true);
  expect(controllerNeedsDatabase("test/integration/example-baseline.test.ts")).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/example-baseline.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-source-example.test.ts")).toBe(false);
  expect(
    integrationNeedsApplicationBuild("test/integration/substrate-source-example.test.ts"),
  ).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-example.test.ts")).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/server-function-example.test.ts")).toBe(
    true,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-mcp-authority.test.ts")).toBe(
    true,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-ticket-sql.test.ts")).toBe(true);
});
