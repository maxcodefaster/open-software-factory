import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { factoryProcess } from "../fixtures/factory-process";

test("actual Factory chat groups retained activity and preserves native disclosure through reconnect", async () => {
  const owned = await factoryProcess();
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    // Reuse the lane's immutable Start client/server build, served by this
    // owned process. A separate SPA build no longer produces index.html.
    await owned.startPlanningCache();
    await owned.start();
    const base = owned.base;
    child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "node_modules/@playwright/test/cli.js",
        "test",
        "test/browser/implementation-journey.spec.ts",
        "test/browser/chat-conversations.spec.ts",
        "--grep",
        "tool activity is one collapsed line|Coding uses one live read|personal conversation history|shared Coding keeps",
        "--reporter=line",
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: owned.databaseURL,
          FACTORY_BROWSER_BASE_URL: base,
          FACTORY_ADMIN_EMAIL: `owned-${owned.id}@factory.local`,
          FACTORY_ADMIN_PASSWORD: "owned-process-password-not-a-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, result] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    await mkdir(".factory/test-results/chat-collaboration", { recursive: true });
    await writeFile(".factory/test-results/chat-collaboration/factory-browser.log", output + error);
    if (result !== 0) console.error((output + error).slice(-12000));
    expect(result).toBe(0);
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await owned.dispose();
  }
}, 300_000);
