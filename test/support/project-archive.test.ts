import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFixtureProject } from "../fixtures/project-archive";

test("Project fixture archives do not turn Mac metadata into Linux checkout files", async () => {
  const source = await mkdtemp(join(tmpdir(), "factory-project-archive-"));
  try {
    const file = join(source, "source.txt");
    await writeFile(file, "clean Project");
    if (process.platform === "darwin") {
      const metadata = Bun.spawn(["xattr", "-w", "com.factory.fixture", "public", file]);
      expect(await metadata.exited).toBe(0);
    }
    const archive = await archiveFixtureProject(source);
    const names: string[] = [];
    for (let offset = 0; offset + 512 <= archive.length; ) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      names.push(header.subarray(0, 100).toString().split("\0")[0] ?? "");
      const size = Number.parseInt(
        header.subarray(124, 136).toString().replaceAll("\0", "").trim(),
        8,
      );
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid fixture tar header");
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names.some((name) => name.endsWith("/source.txt"))).toBe(true);
    expect(names.filter((name) => name.split("/").some((part) => part.startsWith("._")))).toEqual(
      [],
    );
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("Project fixture archives stop before retaining oversized source input", async () => {
  const source = await mkdtemp(join(tmpdir(), "factory-project-archive-"));
  try {
    await writeFile(join(source, "large.txt"), Buffer.alloc(1024 ** 2));
    await expect(archiveFixtureProject(source)).rejects.toThrow("exceeds its bound");
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
