import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = await readFile(new URL("./export-rootfs.sh", import.meta.url), "utf8");
const writer = script.match(/<<'FACTORY_EXPORT'\n([\s\S]*?)\nFACTORY_EXPORT/)?.[1];
if (!writer) throw new Error("Missing production streaming archive writer");
const node = Bun.which("node");
if (!node) throw new Error("Use the repository-pinned Node runtime");

test.each([0, 42])(
  "streaming export preserves producer exit %i without buffering the archive",
  async (code) => {
    const directory = await mkdtemp(join(tmpdir(), "factory-export-"));
    const destination = join(directory, "rootfs.partial");
    try {
      await writeFile(
        join(directory, "tar"),
        `#!/bin/sh\nexec ${JSON.stringify(node)} -e 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 65)); process.exitCode = ${code};'\n`,
        { mode: 0o700 },
      );
      const process = Bun.spawn(
        [
          node,
          "--input-type=module",
          "-e",
          writer.replaceAll("/factory-seed/rootfs.partial", destination),
        ],
        { env: { PATH: directory }, stdout: "ignore", stderr: "pipe" },
      );
      const [exit, error] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      expect(exit === 0).toBe(code === 0);
      if (code) expect(error).toContain(`Runtime archive failed: ${code}`);
      const content = await readFile(destination);
      expect(content.byteLength).toBe(17 * 1024 * 1024);
      expect(content.every((value) => value === 65)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("streaming export refuses an existing output before starting its producer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-export-"));
  const destination = join(directory, "rootfs.partial");
  const marker = join(directory, "producer-started");
  try {
    await writeFile(destination, "retained original");
    await writeFile(join(directory, "tar"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, {
      mode: 0o700,
    });
    const process = Bun.spawn(
      [
        node,
        "--input-type=module",
        "-e",
        writer.replaceAll("/factory-seed/rootfs.partial", destination),
      ],
      { env: { PATH: directory }, stdout: "ignore", stderr: "pipe" },
    );
    const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect(exit).not.toBe(0);
    expect(error).toContain("EEXIST");
    expect(await readFile(destination, "utf8")).toBe("retained original");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
