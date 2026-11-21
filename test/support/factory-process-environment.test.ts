import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { factoryProcessCommand } from "../fixtures/factory-process";

test("owned Factory children cannot load the developer's model or credential environment file", async () => {
  const directory = resolve(".factory/test-results/process-environment", crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, ".env"), "FACTORY_OWNED_ENV_PROBE=must-not-be-loaded\n");
  const env = { ...process.env };
  delete env["FACTORY_OWNED_ENV_PROBE"];
  try {
    const child = Bun.spawn(
      factoryProcessCommand("-e", [
        'process.stdout.write(process.env["FACTORY_OWNED_ENV_PROBE"] ?? "isolated")',
      ]),
      { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
    );
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(output).toBe("isolated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Skill host handles cancellation during setup and disposes its owned resources", async () => {
  const fixture = resolve("test/fixtures/skill-browser-host.ts");
  const processOwner = resolve("test/fixtures/factory-process.ts");
  const postgresOwner = resolve("test/fixtures/postgres-server.ts");
  const script = `
    const { mock } = await import("bun:test");
    const disposed = [];
    mock.module(${JSON.stringify(postgresOwner)}, () => ({
      ownedPostgresServer: async () => ({
        identity: { owner: "owned", url: "owned" },
        dispose: async () => disposed.push("postgres"),
      }),
    }));
    mock.module(${JSON.stringify(processOwner)}, () => ({
      factoryProcess: async () => {
        process.kill(process.pid, "SIGTERM");
        await Bun.sleep(0);
        return {
          startPlanningCache: async () => { throw Error("Cancelled setup must not start cache"); },
          start: async () => { throw Error("Cancelled setup must not start the application"); },
          dispose: async () => disposed.push("factory"),
        };
      },
    }));
    await import(${JSON.stringify(fixture)});
    console.log(JSON.stringify(disposed));
  `;
  const env = { ...process.env };
  delete env["FACTORY_TEST_POSTGRES"];
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe("");
  expect(code).toBe(0);
  expect(output).toContain('["factory","postgres"]');
});
