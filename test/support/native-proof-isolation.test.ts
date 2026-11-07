import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("owned UI hosts and compiled-function browser runners disable implicit workspace dotenv loading", async () => {
  for (const file of [
    "test/browser/mcp-library.spec.ts",
    "test/browser/monitoring-settings.spec.ts",
    "test/browser/skill-settings.spec.ts",
    "test/browser/project-backgrounds.spec.ts",
  ]) {
    const source = await readFile(file, "utf8");
    expect(/"bun",\s*"--no-env-file",\s*"test\/fixtures\/skill-browser-host.ts"/.test(source)).toBe(
      true,
    );
  }
  for (const file of [
    "test/integration/server-functions.test.ts",
    "test/integration/chat-factory-browser.test.ts",
  ]) {
    const source = await readFile(file, "utf8");
    expect(
      /process.execPath,\s*"--no-env-file",\s*"node_modules\/@playwright\/test\/cli.js"/.test(
        source,
      ),
    ).toBe(true);
  }
});
