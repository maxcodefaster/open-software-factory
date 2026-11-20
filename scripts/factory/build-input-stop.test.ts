import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInputStop } from "./build-input-stop";

test("native input Stop bundles its exact SDK into one executable module and refuses invalid or oversized assignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-input-stop-build-"));
  try {
    const file = await buildInputStop(directory);
    expect(file).toBe(join(directory, "input-stop.mjs"));
    expect((await stat(file)).size).toBeGreaterThan(0);
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(await readFile(file, "utf8"));
    expect(imports.filter(({ path }) => !isBuiltin(path) && !path.startsWith("bun:"))).toEqual([]);
    for (const assignment of ["{}", "x".repeat(8193)]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", file], {
        stdin: new Blob([assignment]),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Native input Stop could not be confirmed");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
