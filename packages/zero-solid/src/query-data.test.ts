import { expect, test } from "bun:test";
test("Solid 2 query stores update only changed subscribers and reconcile compound keys", async () => {
  // Bun's default Solid entry is SSR. Exercise the shipped browser reactive
  // engine, not its intentionally non-reactive server stubs.
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", "--no-env-file", "test/fixtures/zero-query-data.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(error);
  expect(output).toContain("unchangedRowEffects=1");
  expect(output).toContain("compoundKeys=correct");
  expect(output).toContain("sameQuerySubscriptions=1");
});
