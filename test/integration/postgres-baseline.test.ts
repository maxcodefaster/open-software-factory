import { expect, test } from "bun:test";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";

test("the PostgreSQL invariant command owns a fresh baseline instead of using the development database", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/integration/postgres.ts"], {
    env: {
      ...verificationEnvironment(process.env),
      DATABASE_URL: "postgresql://not-a-retained-database@127.0.0.1:1/not-a-target",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(stdout).toContain("Owned test PostgreSQL intended:");
  expect(stdout).toContain("PostgreSQL clean baseline invariants passed");
});
