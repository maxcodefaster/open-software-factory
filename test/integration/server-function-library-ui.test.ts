import { expect, test } from "bun:test";

test("MCP and Inputs browser fixtures use the compiled handler for private drafts, lost responses and explicit decisions", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "node_modules/@playwright/test/cli.js",
      "test",
      "test/browser/project-inputs-ui.spec.ts",
      "test/browser/mcp-transport.spec.ts",
      "--reporter=line",
      "--workers=1",
      "--max-failures=1",
    ],
    { env: { ...process.env, FACTORY_BROWSER_LANE: "ui" }, stdout: "pipe", stderr: "pipe" },
  );
  const path = ".factory/test-results/server-functions/mcp-input-browser.log";
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
    expect(status).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await log.end();
  }
}, 360_000);
