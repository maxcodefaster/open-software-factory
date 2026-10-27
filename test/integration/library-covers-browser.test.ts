import { expect, test } from "bun:test";

test("cover selection uses the real authenticated Factory and retains unconfirmed saves", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "node_modules/@playwright/test/cli.js",
      "test",
      "test/browser/library-covers.spec.ts",
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
  const path = ".factory/test-results/library-covers/browser.log";
  await Bun.write(path, "");
  const log = Bun.file(path).writer();
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
    if (status !== 0) console.error(await Bun.file(path).text());
    expect(status).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await log.end();
  }
}, 420_000);
