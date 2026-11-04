import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDump, checkSet } from "./restore-check";

async function tar(directory: string, name: string, files: Record<string, string>) {
  const source = await mkdtemp(join(tmpdir(), "restore-source-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), content);
  }
  const child = Bun.spawn(["tar", "-czf", join(directory, name), "-C", source, "."]);
  expect(await child.exited).toBe(0);
  await rm(source, { recursive: true });
}

// Stands in for pg_restore: it accepts only files that start like a custom-format archive.
async function fakePgRestore(directory: string) {
  const file = join(directory, "pg_restore");
  await writeFile(
    file,
    '#!/bin/sh\nhead -c 5 "$2" | grep -q PGDMP || { echo "pg_restore: error: unsupported version" >&2; exit 1; }\nprintf ";\\n; Selected TOC Entries:\\n215; 1259 16385 TABLE public t factory\\n"\n',
  );
  await chmod(file, 0o755);
  return file;
}

test("a readable pg_dump archive passes and a truncated one fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restore-check-"));
  try {
    const pgRestore = await fakePgRestore(directory);
    await writeFile(join(directory, "good.dump"), "PGDMP-archive");
    await writeFile(join(directory, "bad.dump"), "garbage");
    await writeFile(join(directory, "empty.dump"), "");
    expect(await checkDump(join(directory, "good.dump"), pgRestore)).toMatchObject({ ok: true });
    expect(await checkDump(join(directory, "bad.dump"), pgRestore)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("unsupported version"),
    });
    expect(await checkDump(join(directory, "empty.dump"), pgRestore)).toMatchObject({ ok: false });
    expect(await checkDump(join(directory, "none.dump"), pgRestore)).toMatchObject({ ok: false });
    expect(await checkDump(join(directory, "good.dump"), join(directory, "absent"))).toMatchObject({
      ok: false,
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a backup set is complete only with every part and the completion marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restore-check-"));
  try {
    const pgRestore = await fakePgRestore(directory);
    const set = join(directory, "20261104T021700Z");
    await mkdir(set);
    await writeFile(join(set, "postgres.dump"), "PGDMP-archive");
    await tar(set, "forgejo.tar.gz", { "forgejo-db.sql": "select 1;", "data/git": "" });
    await tar(set, "state.tar.gz", { "openbao/bootstrap.json": "{}" });
    await tar(set, "openbao.snap", { "meta.json": "{}", "state.bin": "x" });
    const partial = await checkSet(set, pgRestore);
    expect(partial.filter((result) => !result.ok).map((result) => result.name)).toEqual([
      "COMPLETE",
    ]);
    await writeFile(join(set, "COMPLETE"), "");
    expect((await checkSet(set, pgRestore)).every((result) => result.ok)).toBe(true);
    await rm(join(set, "openbao.snap"));
    expect(
      (await checkSet(set, pgRestore)).filter((result) => !result.ok).map((result) => result.name),
    ).toEqual(["openbao.snap"]);
    await writeFile(join(set, "openbao.skipped"), "");
    expect((await checkSet(set, pgRestore)).every((result) => result.ok)).toBe(true);
    await tar(set, "forgejo.tar.gz", { "other.txt": "x" });
    expect(
      (await checkSet(set, pgRestore)).filter((result) => !result.ok).map((result) => result.name),
    ).toEqual(["forgejo.tar.gz"]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
