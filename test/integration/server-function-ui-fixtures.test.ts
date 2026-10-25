import { expect, test } from "bun:test";

test("isolated composer fixtures use native compiled Server Functions for Skill discovery", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "node_modules/@playwright/test/cli.js",
      "test",
      "test/browser/chat-collaboration.spec.ts",
      "test/browser/interaction-feedback.spec.ts",
      "test/browser/skill-library-transport.spec.ts",
      "test/browser/writer-transport.spec.ts",
      "--grep=Skill|slash|editing|Writer|Recording|Review publishes",
      "--reporter=line",
      "--workers=1",
      "--max-failures=1",
    ],
    {
      env: { ...process.env, FACTORY_BROWSER_LANE: "ui" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const logPath = ".factory/test-results/server-functions/skill-picker-browser.log";
  await Bun.write(logPath, "");
  const log = Bun.file(logPath).writer();
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      log.write(chunk);
      await log.flush();
    }
  };
  try {
    const [, , status] = await Promise.all([
      drain(child.stdout),
      drain(child.stderr),
      child.exited,
    ]);
    expect(status).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await log.end();
  }
}, 300_000);
