import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDump, checkSet, checkSnapshot } from "./restore-check";

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

function sha256(content: string) {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

// The layout OpenBao 2.7 writes for `bao operator raft snapshot save`.
function snapshotFiles(overrides: Record<string, string> = {}) {
  const meta = '{"Version":1,"ID":"bolt-snapshot","Index":145,"Term":4}';
  // Incompressible, so the gzip size is the same on every platform.
  const state = randomBytes(2048).toString("hex");
  return {
    "meta.json": meta,
    "state.bin": state,
    SHA256SUMS: `${sha256(meta)}  meta.json\n${sha256(state)}  state.bin\n`,
    ...overrides,
  };
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
    await tar(set, "openbao.snap", snapshotFiles());
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

test("a raft snapshot needs its gzip header, size, members and matching checksums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restore-check-"));
  try {
    await tar(directory, "good.snap", snapshotFiles());
    expect(await checkSnapshot(join(directory, "good.snap"))).toMatchObject({
      ok: true,
      detail: expect.stringContaining("match SHA256SUMS"),
    });
    await tar(
      directory,
      "corrupt.snap",
      snapshotFiles({ "state.bin": randomBytes(2048).toString("hex") }),
    );
    expect(await checkSnapshot(join(directory, "corrupt.snap"))).toMatchObject({
      ok: false,
      detail: "state.bin does not match SHA256SUMS",
    });
    await tar(directory, "nosums.snap", { ...snapshotFiles(), SHA256SUMS: "" });
    expect(await checkSnapshot(join(directory, "nosums.snap"))).toMatchObject({ ok: false });
    await tar(directory, "nostate.snap", {
      "meta.json": Buffer.from(crypto.getRandomValues(new Uint8Array(2048))).toString("hex"),
    });
    expect(await checkSnapshot(join(directory, "nostate.snap"))).toMatchObject({
      ok: false,
      detail: "state.bin is missing",
    });
    await writeFile(join(directory, "tiny.snap"), "\x1f\x8b");
    expect(await checkSnapshot(join(directory, "tiny.snap"))).toMatchObject({
      ok: false,
      detail: expect.stringContaining("too small"),
    });
    await writeFile(join(directory, "plain.snap"), "x".repeat(2048));
    expect(await checkSnapshot(join(directory, "plain.snap"))).toMatchObject({
      ok: false,
      detail: "does not start with a gzip header",
    });
    expect(await checkSnapshot(join(directory, "absent.snap"))).toMatchObject({ ok: false });
  } finally {
    await rm(directory, { recursive: true });
  }
});
