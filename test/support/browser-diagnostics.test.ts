import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { observeBrowserErrors } from "../fixtures/browser-errors";

test("the browser observer retains structural diagnostics and page errors, not ordinary warnings", () => {
  const page = new EventEmitter();
  const observed = observeBrowserErrors(page as unknown as Page);
  for (const text of [
    "[STRICT_READ_UNTRACKED] stale read",
    "[NO_OWNER_CLEANUP] missing owner",
    "[REACTIVE_WRITE_IN_OWNED_SCOPE] write",
  ])
    page.emit("console", { text: () => text });
  page.emit("console", { text: () => "An ordinary expected warning" });
  page.emit("pageerror", new Error("Uncaught render failure"));
  expect(observed).toEqual([
    "[STRICT_READ_UNTRACKED] stale read",
    "[NO_OWNER_CLEANUP] missing owner",
    "[REACTIVE_WRITE_IN_OWNED_SCOPE] write",
    "Uncaught render failure",
  ]);
});

test("the actual lint rule rejects plain and aliased Playwright test imports but allows the guarded fixture", async () => {
  const parent = resolve(".factory/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "browser-diagnostics-"));
  const command = resolve("node_modules/@biomejs/biome/bin/biome");
  try {
    await mkdir(resolve(directory, "test/browser"), { recursive: true });
    await writeFile(resolve(directory, "biome.json"), await readFile("biome.json"));
    for (const [source, allowed] of [
      ['import { test } from "@playwright/test";', false],
      ['import { test as unchecked } from "@playwright/test";', false],
      ['import * as unchecked from "@playwright/test";', false],
      ['import unchecked from "@playwright/test";', false],
      [
        'import { expect, type Page } from "@playwright/test";\nimport { test } from "../fixtures/browser-test";',
        true,
      ],
    ] as const) {
      await writeFile(resolve(directory, "test/browser/guard.spec.ts"), source);
      const child = Bun.spawn(
        [
          process.execPath,
          command,
          "lint",
          "--only=style/noRestrictedImports",
          "test/browser/guard.spec.ts",
        ],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(status === 0, `${source}\n${error}`).toBe(allowed);
      if (!allowed) expect(error).toContain("browser-test");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
