import { expect, test } from "bun:test";
import { starterApplication } from "../fixtures/starter-application";

test("turnkey Starter installs its Drizzle schema and verifies real Better Auth sessions", async () => {
  const starter = await starterApplication();
  try {
    for (const script of ["db:migrate", "db:migrate", "check"]) {
      const output = await starter.command(["npm", "run", script]);
      if (script === "check") expect(output).toContain("fail 0");
    }
  } finally {
    await starter.dispose();
  }
}, 60_000);
