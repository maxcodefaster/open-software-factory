import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "@playwright/test";

test("prepare one immutable build and owned PostgreSQL baseline for this browser run", async () => {
  test.setTimeout(180_000);
  await promisify(execFile)(
    "mise",
    [
      "exec",
      "--",
      "bun",
      "--no-env-file",
      "test/fixtures/owned-browser-run.ts",
      "setup",
      process.env["FACTORY_BROWSER_RUN_ID"] ?? "",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
});
