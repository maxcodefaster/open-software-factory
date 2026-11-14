import { expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

async function waitingPgRestore(directory: string) {
  const ready = join(directory, "ready"),
    joined = join(directory, "joined"),
    pgRestore = join(directory, "pg_restore");
  await writeFile(
    pgRestore,
    `#!${process.execPath}
    const parent = process.ppid;
    let stopping = false;
    async function finish(mode, code) {
      if (stopping) return;
      stopping = true;
      await Bun.write(${JSON.stringify(joined)}, mode);
      process.stdout.write("215; TABLE public owned factory\\n");
      process.exit(code);
    }
    process.once("SIGTERM", () => { void finish("joined", 0); });
    await Bun.write(${JSON.stringify(ready)}, "ready");
    setInterval(() => {
      try { process.kill(parent, 0); }
      catch { void finish("orphaned", 1); }
    }, 20);
    `,
    { mode: 0o700 },
  );
  return { ready, joined, pgRestore };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(file).exists()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await Bun.file(file).exists()).toBe(true);
}

async function waitForCalls(spawn: { mock: { calls: unknown[] } }, count: number) {
  const deadline = Date.now() + 5000;
  while (spawn.mock.calls.length < count && Date.now() < deadline) await Bun.sleep(5);
  expect(spawn.mock.calls).toHaveLength(count);
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

test("backup cancellation joins pg_restore even when its signal handler exits successfully", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restore-check-cancel-"));
  const { ready, joined, pgRestore } = await waitingPgRestore(directory);
  const dump = join(directory, "postgres.dump");
  await writeFile(dump, "PGDMP-owned-archive");
  const child = Bun.spawn([pgRestore, "--list", dump], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const controller = new AbortController();
  const reason = new Error("Owned backup check interrupted");
  let spawn: ReturnType<typeof spyOn> | undefined;
  let completion: Promise<unknown> | undefined;
  try {
    await waitForFile(ready);
    spawn = spyOn(Bun, "spawn").mockImplementationOnce(() => child);
    completion = checkSet(directory, pgRestore, controller.signal).then(
      () => ({ status: "resolved" }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    // Let checkSet enter its actual subprocess boundary before cancellation.
    await waitForCalls(spawn, 1);
    controller.abort(reason);
    expect(
      await Promise.race([completion, Bun.sleep(2000).then(() => ({ status: "pending" }))]),
    ).toEqual({ status: "rejected", error: reason });
    expect(await Bun.file(joined).text()).toBe("joined");
    expect(child.exitCode).toBe(0);
    expect(spawn.mock.calls).toHaveLength(1);
  } finally {
    controller.abort(reason);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await completion;
    spawn?.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["SIGINT", "SIGTERM"] as const)(
  "the real backup CLI joins its validation client on %s and never exits successfully",
  async (signal) => {
    const directory = await mkdtemp(join(tmpdir(), "restore-check-cli-"));
    const { ready, joined, pgRestore } = await waitingPgRestore(directory);
    const dump = join(directory, "postgres.dump");
    await writeFile(dump, "PGDMP-owned-archive");
    const checker = Bun.spawn(
      [process.execPath, "--no-env-file", resolve(import.meta.dir, "restore-check.ts"), dump],
      {
        env: { ...process.env, PG_RESTORE: pgRestore },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const result = Promise.all([
      new Response(checker.stdout).text(),
      new Response(checker.stderr).text(),
      checker.exited,
    ]);
    try {
      await waitForFile(ready);
      checker.kill(signal);
      const completed = await Promise.race([result, Bun.sleep(2000).then(() => null)]);
      expect(completed).not.toBeNull();
      expect(completed?.[2]).toBe(signal === "SIGINT" ? 130 : 143);
      expect(completed?.[1]).toContain("Backup validation interrupted");
      expect(await Bun.file(joined).text()).toBe("joined");
      expect(completed?.[0]).not.toContain("ok  ");
    } finally {
      if (checker.exitCode === null && checker.signalCode === null) checker.kill("SIGKILL");
      await result;
      // The fixture also self-terminates if a broken CLI orphaned it.
      if (await Bun.file(ready).exists()) await waitForFile(joined);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["list", "extract"] as const)(
  "snapshot cancellation joins the actual %s client before returning",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "restore-check-cancel-"));
    const { ready, joined, pgRestore } = await waitingPgRestore(directory);
    const snapshot = join(directory, "openbao.snap");
    await tar(directory, "openbao.snap", snapshotFiles());
    const waiting = Bun.spawn([pgRestore], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const children = [
      ...(phase === "extract"
        ? [
            Bun.spawn(["tar", "-tzf", snapshot], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ]
        : []),
      waiting,
    ];
    const controller = new AbortController();
    const reason = new Error("Owned snapshot validation interrupted");
    let spawn: ReturnType<typeof spyOn> | undefined;
    let completion: Promise<unknown> | undefined;
    try {
      await waitForFile(ready);
      spawn = spyOn(Bun, "spawn");
      for (const child of children) spawn.mockImplementationOnce(() => child);
      completion = checkSnapshot(snapshot, controller.signal).then(
        () => ({ status: "resolved" }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      await waitForCalls(spawn, children.length);
      controller.abort(reason);
      expect(
        await Promise.race([completion, Bun.sleep(2000).then(() => ({ status: "pending" }))]),
      ).toEqual({ status: "rejected", error: reason });
      expect(await Bun.file(joined).text()).toBe("joined");
      expect(waiting.exitCode).toBe(0);
      expect(spawn.mock.calls).toHaveLength(children.length);
    } finally {
      controller.abort(reason);
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      await completion;
      spawn?.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("an already cancelled backup check performs no external validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restore-check-cancel-"));
  const controller = new AbortController();
  const reason = new Error("Already interrupted");
  controller.abort(reason);
  try {
    await expect(checkSet(directory, "missing-pg-restore", controller.signal)).rejects.toBe(reason);
    await expect(
      checkDump(join(directory, "missing.dump"), undefined, controller.signal),
    ).rejects.toBe(reason);
    await expect(checkSnapshot(join(directory, "missing.snap"), controller.signal)).rejects.toBe(
      reason,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
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
