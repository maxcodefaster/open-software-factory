import { expect, test } from "bun:test";

for (const scenario of [
  "failed",
  "stopped",
  "cleanup-failed",
  "cleanup-retry",
  "switch-ticket",
  "ready",
  "starting",
  "another-ticket",
] as const) {
  test(`Main Preview retry uses its failed replacement's cleanup owner: ${scenario}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        new URL("../../../../test/fixtures/promotion-retry.ts", import.meta.url).pathname,
        scenario,
      ],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }, stdout).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain(`PASS promotion-retry ${scenario}`);
  });
}
