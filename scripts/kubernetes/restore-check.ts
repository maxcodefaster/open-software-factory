// Restore dry run for a chart backup set. It reads files and writes nothing:
//   bun scripts/kubernetes/restore-check.ts /path/to/20261104T021700Z
//   bun scripts/kubernetes/restore-check.ts /path/to/postgres.dump
// A set directory is checked as a whole. A single file is checked as a pg_dump custom archive.
// pg_restore must match the server's major version (16). Without a local one, run this from the
// Factory image, or point PG_RESTORE at an executable (for example a wrapper around
// `docker run --rm -i postgres:16.14-bookworm pg_restore "$@"`).
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";

type Result = { name: string; ok: boolean; detail: string };

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

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
  pgRestore = process.env["PG_RESTORE"] ?? "pg_restore",
): Promise<Result> {
  const name = basename(file);
  if (!(await exists(file))) return { name, ok: false, detail: "missing or empty" };
  const listed = await run([pgRestore, "--list", file]).catch((cause: unknown) => ({
    stdout: "",
    stderr: String(cause),
    exitCode: 127,
  }));
  if (listed.exitCode !== 0)
    return { name, ok: false, detail: listed.stderr.trim().split("\n")[0] ?? "pg_restore failed" };
  const entries = listed.stdout.split("\n").filter((line) => line && !line.startsWith(";")).length;
  return entries > 0
    ? { name, ok: true, detail: `${entries} archive entries` }
    : { name, ok: false, detail: "archive lists no objects" };
}

async function checkArchive(file: string, member: RegExp, label: string): Promise<Result> {
  const name = basename(file);
  if (!(await exists(file))) return { name, ok: false, detail: "missing or empty" };
  const listed = await run(["tar", "-tzf", file]);
  if (listed.exitCode !== 0) return { name, ok: false, detail: "not a readable gzip archive" };
  return listed.stdout.split("\n").some((line) => member.test(line))
    ? { name, ok: true, detail: `contains ${label}` }
    : { name, ok: false, detail: `${label} is missing` };
}

export async function checkSet(directory: string, pgRestore?: string): Promise<Result[]> {
  const results = [
    await checkDump(join(directory, "postgres.dump"), pgRestore),
    await checkArchive(
      join(directory, "forgejo.tar.gz"),
      /^(\.\/)?forgejo-db\.sql$/,
      "forgejo-db.sql",
    ),
    await checkArchive(
      join(directory, "state.tar.gz"),
      /(^|\/)openbao\/bootstrap\.json$/,
      "openbao/bootstrap.json",
    ),
  ];
  const snapshot = join(directory, "openbao.snap");
  results.push(
    (await exists(snapshot))
      ? await checkArchive(snapshot, /^(\.\/)?meta\.json$/, "meta.json")
      : {
          name: "openbao.snap",
          ok: await present(join(directory, "openbao.skipped")),
          detail: "absent; this set was taken without an OpenBao snapshot token",
        },
  );
  results.push({
    name: "COMPLETE",
    ok: await present(join(directory, "COMPLETE")),
    detail: "marker written after every step succeeded",
  });
  return results;
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: restore-check.ts <backup set directory | postgres.dump>");
    process.exit(2);
  }
  const info = await stat(target).catch(() => null);
  if (!info) {
    console.error(`${target} does not exist`);
    process.exit(2);
  }
  const results = info.isDirectory() ? await checkSet(target) : [await checkDump(target)];
  for (const result of results)
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}: ${result.detail}`);
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}
