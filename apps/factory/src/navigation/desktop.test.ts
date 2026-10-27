import { expect, test } from "bun:test";

test("the browser reactive engine restores history, fences races and retains workspace drafts", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--conditions=browser",
      "test/fixtures/desktop-navigation.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(error);
  expect(output).toContain("desktop navigation passed");
});
