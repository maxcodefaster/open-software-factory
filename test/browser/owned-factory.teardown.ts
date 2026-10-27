import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "@playwright/test";

test("remove only this browser run's owned build, database and network", async () => {
  test.setTimeout(60_000);
  await promisify(execFile)(
    "mise",
    [
      "exec",
      "--",
      "bun",
      "--no-env-file",
      "test/fixtures/owned-browser-run.ts",
      "close",
      process.env["FACTORY_BROWSER_RUN_ID"] ?? "",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
});
