import { expect, test } from "bun:test";

for (const [scenario, behavior] of [
  ["first", "shows the first Planning result without a reload and keeps its admission pending"],
  ["before-mode", "does not commission after another context is selected during preparation"],
  ["before-completion", "does not replace a context selected before the response completes"],
  [
    "recovered",
    "recovers a completed first response without replaying inference or claiming failure",
  ],
] as const) {
  test(behavior, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        new URL("../../../../test/fixtures/first-conversation.ts", import.meta.url).pathname,
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
    expect(stdout).toContain(`PASS first-conversation ${scenario}`);
  });
}
