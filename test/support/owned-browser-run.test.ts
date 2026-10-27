import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

for (const collision of ["evidence", "build"] as const) {
  test(`owned browser setup refuses an existing ${collision} before creating resources`, async () => {
    const id = crypto.randomUUID();
    const evidence = resolve(".factory/test-results/browser-runs", id);
    const build = resolve(".factory/test-results/application-builds", `browser-${id}`);
    const occupied = collision === "evidence" ? evidence : build;
    await mkdir(occupied, { recursive: true });
    const sentinel = resolve(occupied, "existing.txt");
    await writeFile(sentinel, "Retain the existing run");
    try {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "test/fixtures/owned-browser-run.ts", "setup", id],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(status).not.toBe(0);
      expect(stderr).toContain("EEXIST");
      expect(stdout).not.toContain("Owned test PostgreSQL intended");
      expect(await readFile(sentinel, "utf8")).toBe("Retain the existing run");
    } finally {
      await rm(evidence, { recursive: true, force: true });
      await rm(build, { recursive: true, force: true });
    }
  });
}
