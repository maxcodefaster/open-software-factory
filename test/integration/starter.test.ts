import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";

test("turnkey Starter installs its Drizzle schema and verifies real Better Auth sessions", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    await database.client`CREATE DATABASE starter`;
    const url = new URL(process.databaseURL);
    url.pathname = "/starter";
    for (const script of ["db:migrate", "db:migrate", "check"]) {
      const child = Bun.spawn(["npm", "run", script], {
        cwd: "templates/starter-app",
        env: {
          ...globalThis.process.env,
          DATABASE_URL: url.toString(),
          BETTER_AUTH_SECRET: "owned-starter-auth-secret-not-production",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(`Starter ${script} failed: ${stdout}\n${stderr}`);
      expect(status).toBe(0);
    }
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 60_000);
