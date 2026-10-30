import { expect, test } from "bun:test";

for (const [scenario, behavior] of [
  ["first", "shows the first Planning result without a reload and keeps its admission pending"],
  ["before-mode", "does not commission after another context is selected during preparation"],
  ["before-completion", "does not replace a context selected before the response completes"],
  [
    "recovered",
    "recovers a completed first response without replaying inference or claiming failure",
  ],
  ["recovered-failed", "reports a recorded failed response after stream disconnection"],
  ["recovered-stopped", "reports a recorded Stop after stream disconnection"],
  ["recovered-uncertain", "preserves an uncertain response outcome after stream disconnection"],
  ["recovered-running", "keeps observing admitted work after stream disconnection"],
  ["recovered-missing", "does not invent a response result when retained outcome is missing"],
  ["recovered-other", "does not use another command's result for a disconnected response"],
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
