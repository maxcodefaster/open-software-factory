// Restore dry run for a chart backup set. It reads files and writes nothing:
//   bun scripts/kubernetes/restore-check.ts /path/to/20261104T021700Z
//   bun scripts/kubernetes/restore-check.ts /path/to/postgres.dump
// A set directory is checked as a whole. A single file is checked as a pg_dump custom archive.
// pg_restore must match the server's major version (16). Without a local one, run this from the
// Factory image, or point PG_RESTORE at an executable (for example a wrapper around
// `docker run --rm -i postgres:16.14-bookworm pg_restore "$@"`).
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { run, runBytes } from "../owned-client-process";

type Result = { name: string; ok: boolean; detail: string };
export type PgRestore = string | readonly string[];

async function present(file: string) {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

async function exists(file: string) {
  return stat(file).then(
    (info) => info.isFile() && info.size > 0,
    () => false,
  );
}

export async function checkDump(
  file: string,
  pgRestore: PgRestore = process.env["PG_RESTORE"] ?? "pg_restore",
  signal?: AbortSignal,
): Promise<Result> {
  signal?.throwIfAborted();
  const name = basename(file);
  if (!(await exists(file))) return { name, ok: false, detail: "missing or empty" };
  const command = typeof pgRestore === "string" ? [pgRestore] : [...pgRestore];
  const listed = await run([...command, "--list", file], { signal, allowFailure: true }).catch(
    (cause: unknown) => {
      signal?.throwIfAborted();
      return { stdout: "", stderr: String(cause), code: 127 };
    },
  );
  if (listed.code !== 0)
    return { name, ok: false, detail: listed.stderr.trim().split("\n")[0] ?? "pg_restore failed" };
  const entries = listed.stdout.split("\n").filter((line) => line && !line.startsWith(";")).length;
  return entries > 0
    ? { name, ok: true, detail: `${entries} archive entries` }
    : { name, ok: false, detail: "archive lists no objects" };
}

async function checkArchive(
  file: string,
  member: RegExp,
  label: string,
  signal?: AbortSignal,
): Promise<Result> {
  signal?.throwIfAborted();
  const name = basename(file);
  if (!(await exists(file))) return { name, ok: false, detail: "missing or empty" };
  const listed = await run(["tar", "-tzf", file], { signal, allowFailure: true });
  if (listed.code !== 0) return { name, ok: false, detail: "not a readable gzip archive" };
  return listed.stdout.split("\n").some((line) => member.test(line))
    ? { name, ok: true, detail: `contains ${label}; full restore rehearsal still required` }
    : { name, ok: false, detail: `${label} is missing` };
}

const snapshotMinimumBytes = 512;

// A raft snapshot is a gzip tar of meta.json, state.bin and SHA256SUMS. The sums are checked, so
// a truncated or corrupted copy fails here instead of at restore time.
export async function checkSnapshot(file: string, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  const name = basename(file);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) return { name, ok: false, detail: "missing or empty" };
  if (info.size < snapshotMinimumBytes)
    return { name, ok: false, detail: `only ${info.size} bytes; too small to be a snapshot` };
  const header = new Uint8Array(await Bun.file(file).slice(0, 2).arrayBuffer());
  if (header[0] !== 0x1f || header[1] !== 0x8b)
    return { name, ok: false, detail: "does not start with a gzip header" };
  const listed = await run(["tar", "-tzf", file], { signal, allowFailure: true });
  if (listed.code !== 0) return { name, ok: false, detail: "not a readable gzip archive" };
  // GNU tar matches the stored name exactly, so keep the "./" prefix some archives carry.
  const members = new Map(
    listed.stdout.split("\n").map((line) => [line.replace(/^\.\//, ""), line]),
  );
  for (const member of ["meta.json", "state.bin", "SHA256SUMS"])
    if (!members.has(member)) return { name, ok: false, detail: `${member} is missing` };
  async function read(member: string) {
    const result = await runBytes(["tar", "-xzOf", file, members.get(member) ?? member], {
      signal,
      allowFailure: true,
    });
    return result.code === 0 ? result.stdout : null;
  }
  const sums = await read("SHA256SUMS");
  if (!sums) return { name, ok: false, detail: "SHA256SUMS is unreadable" };
  const expected = new Map(
    new TextDecoder()
      .decode(sums)
      .split("\n")
      .flatMap((line) => {
        const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
        return match?.[1] && match[2] ? [[match[2], match[1]] as const] : [];
      }),
  );
  for (const member of ["meta.json", "state.bin"]) {
    const bytes = await read(member);
    if (!bytes) return { name, ok: false, detail: `${member} is unreadable` };
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected.get(member))
      return { name, ok: false, detail: `${member} does not match SHA256SUMS` };
  }
  return { name, ok: true, detail: `${info.size} bytes; meta.json and state.bin match SHA256SUMS` };
}

export async function checkSet(
  directory: string,
  pgRestore?: PgRestore,
  signal?: AbortSignal,
): Promise<Result[]> {
  signal?.throwIfAborted();
  const results = [
    await checkDump(join(directory, "postgres.dump"), pgRestore, signal),
    await checkArchive(
      join(directory, "forgejo.tar.gz"),
      /^(\.\/)?forgejo\.sqlite3$/,
      "forgejo.sqlite3",
      signal,
    ),
    await checkArchive(
      join(directory, "state.tar.gz"),
      /(^|\/)openbao\/bootstrap\.json$/,
      "openbao/bootstrap.json",
      signal,
    ),
  ];
  const snapshot = join(directory, "openbao.snap");
  results.push(
    (await exists(snapshot))
      ? await checkSnapshot(snapshot, signal)
      : {
          name: "openbao.snap",
          ok: await present(join(directory, "openbao.skipped")),
          detail: "absent; this set was taken without an OpenBao snapshot credential",
        },
  );
  results.push({
    name: "COMPLETE",
    ok: await present(join(directory, "COMPLETE")),
    detail: "marker written after every step succeeded",
  });
  signal?.throwIfAborted();
  return results;
}

async function main(signal: AbortSignal) {
  signal.throwIfAborted();
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: restore-check.ts <backup set directory | postgres.dump>");
    return 2;
  }
  const info = await stat(target).catch(() => null);
  if (!info) {
    console.error(`${target} does not exist`);
    return 2;
  }
  const results = info.isDirectory()
    ? await checkSet(target, undefined, signal)
    : [await checkDump(target, undefined, signal)];
  signal.throwIfAborted();
  for (const result of results)
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}: ${result.detail}`);
  return results.every((result) => result.ok) ? 0 : 1;
}

if (import.meta.main) {
  const controller = new AbortController();
  let interrupted: number | undefined;
  const stop = (code: number) => {
    interrupted ??= code;
    controller.abort(new Error("Backup validation interrupted"));
  };
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    process.exitCode = await main(controller.signal);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = interrupted ?? 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
