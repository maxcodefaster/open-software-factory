import { expect, test } from "bun:test";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import upstream from "../../upstream.json";

test("pinned Linux backup exec preserves writer stdin and isolates watchdog descriptors", async () => {
  const id = crypto.randomUUID();
  const name = `factory-backup-stdin-${id}`;
  const input = Buffer.concat([
    Buffer.from("PGDMP\0"),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  ]);
  const label = "factory.backup-stdin-proof";
  const errors: unknown[] = [];
  function cleanup() {
    const inspect = Bun.spawnSync(["docker", "inspect", name], { stdout: "pipe", stderr: "pipe" });
    if (inspect.exitCode === 0) {
      const [container] = JSON.parse(inspect.stdout.toString());
      if (container?.Config?.Labels?.[label] !== id)
        throw new Error("Backup stdin fixture ownership changed; container was not removed");
      const remove = Bun.spawnSync(["docker", "rm", "--force", name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (remove.exitCode !== 0) throw new Error("Owned backup stdin fixture cleanup failed");
    } else if (!/no such (object|container):/i.test(inspect.stderr.toString()))
      throw new Error("Backup stdin fixture cleanup could not be confirmed");
  }
  try {
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--interactive",
        "--name",
        name,
        "--label",
        `${label}=${id}`,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--user",
        "1000:1000",
        "--pids-limit",
        "32",
        "--cpus",
        "0.25",
        "--memory",
        "32m",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=8m,uid=1000,gid=1000",
        "--mount",
        `type=bind,src=${resolve("deploy/helm/factory/files/backup")},dst=/scripts,readonly`,
        "--entrypoint",
        "sh",
        upstream.rclone.image,
        "-c",
        `set -eu
       exec 9>/tmp/writer.lock
       flock -n 9
       cat > /tmp/input
       sh /scripts/run.sh exec binary-input sh -c 'test -e /proc/self/fd/9; cat' < /tmp/input
       sh /scripts/run.sh exec watchdog-fds sh -c 'touch /tmp/ready; while ! test -f /tmp/release; do sleep 0.02; done' > /tmp/output 2> /tmp/diagnostics &
       call=$!
       timer=''
       n=0
       while [ -z "$timer" ]; do
         n=$((n + 1)); test "$n" -lt 200
         for pid in $(cat "/proc/$call/task/$call/children"); do
           case "$(tr '\\0' ' ' < "/proc/$pid/cmdline")" in
             *'sleep "$1"; kill -USR1 "$2"'*) timer=$pid ;;
           esac
         done
         [ -n "$timer" ] || sleep 0.02
       done
       test ! -e "/proc/$timer/fd/9"
       test "$(readlink "/proc/$timer/fd/1")" = /dev/null
       test "$(readlink "/proc/$timer/fd/2")" = /dev/null
       touch /tmp/release
       wait "$call"`,
      ],
      { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    const [code, output, diagnostics] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(Buffer.from(output)).toEqual(input);
    expect(diagnostics).toContain("Backup exec binary-input exited with status 0");
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Pinned backup stdin proof failed");
}, 20_000);

const sqliteFile = process.env["FACTORY_BACKUP_SQLITE_FILE"];
(sqliteFile ? test : test.skip)(
  "staged static SQLite preserves WAL-only data and original Forgejo migration history",
  async () => {
    if (!sqliteFile || !isAbsolute(sqliteFile) || (await realpath(sqliteFile)) !== sqliteFile)
      throw new Error("Supply an owned, canonical FACTORY_BACKUP_SQLITE_FILE for this native lane");
    const info = await lstat(sqliteFile);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || info.mode & 0o022)
      throw new Error("Unsafe static SQLite proof input");
    const script = await readFile("deploy/helm/factory/files/backup/forgejo.sh", "utf8");
    const begin = script.indexOf('     cat > "$temporary/sqlite"');
    const end = script.indexOf("     mkdir -p /var/lib/gitea/git/repositories");
    if (begin < 0 || end <= begin) throw new Error("Production SQLite export boundary changed");
    const snapshot = script.slice(begin, end);
    const owner = crypto.randomUUID(),
      name = `factory-backup-sqlite-${owner}`;
    const label = "factory.backup-sqlite-proof";
    const errors: unknown[] = [];
    let cid: string | undefined;
    const docker = async (args: string[], input?: Uint8Array) => {
      const child = Bun.spawn(["docker", ...args], {
        stdin: input ? new Blob([new Uint8Array(input)]) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30000,
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0)
        throw new Error(
          // This process sees only the test's fixed, non-secret seed rows and binary.
          `Owned SQLite native fixture failed with status ${code}\n${err.slice(-2000)}`,
        );
      return { out, err };
    };
    try {
      cid = (
        await docker([
          "create",
          "--interactive",
          "--name",
          name,
          "--pull",
          "never",
          "--label",
          `${label}=${owner}`,
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user",
          "1000:1000",
          "--pids-limit=64",
          "--cpus=1",
          "--memory=128m",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,exec,size=16m,uid=1000,gid=1000",
          "--tmpfs",
          "/var/lib/gitea:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000",
          "--mount",
          `type=bind,src=${sqliteFile},dst=/proof-sqlite,readonly`,
          "--entrypoint",
          "sh",
          "codeberg.org/forgejo/forgejo:17.0.0-rootless@sha256:6554520f7574602100b7d6620c6ac5b18cec30325f823777497eac36234f5cf8",
          "-ec",
          `set -o pipefail
writer=''
stage=seed
finish() {
 status=$?
 trap - EXIT
 if [ -n "$writer" ]; then kill "$writer" 2>/dev/null || true; wait "$writer" 2>/dev/null || true; fi
 if [ "$status" -ne 0 ]; then printf 'SQLite proof phase: %s\\n' "$stage" >&2; fi
 exit "$status"
}
trap finish EXIT
test "$(/proof-sqlite --version | cut -d " " -f 1)" = ${upstream.sqlite.version}
mkdir -p /var/lib/gitea/data
db=/var/lib/gitea/data/forgejo.db
/proof-sqlite "$db" "CREATE TABLE forgejo_version(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO forgejo_version VALUES(1,42);
CREATE TABLE forgejo_migration(id TEXT PRIMARY KEY,created INTEGER); INSERT INTO forgejo_migration VALUES('original-migration',1700000000);
CREATE TABLE wal_sentinel(id INTEGER PRIMARY KEY,value TEXT);"
mkfifo /tmp/writer
stage=writer
exec 7<>/tmp/writer
/proof-sqlite -batch -bail "$db" < /tmp/writer > /tmp/writer-output 2>&1 &
writer=$!
printf '%s\\n' 'PRAGMA journal_mode=WAL;' 'PRAGMA wal_autocheckpoint=0;' \
 "INSERT INTO wal_sentinel VALUES(1,'committed-only-in-WAL');" '.shell touch /tmp/writer-ready' >&7
n=0
while ! test -f /tmp/writer-ready; do n=$((n+1)); test "$n" -lt 100; sleep 0.02; done
test -s "$db-wal"
temporary="$(mktemp -d /tmp/factory-backup.native.XXXXXX)"
stage=export
${snapshot}
stage=validate-sentinel
test "$("$temporary/sqlite" -readonly "$temporary/forgejo.sqlite3" "SELECT value FROM wal_sentinel WHERE id=1;")" = committed-only-in-WAL
stage=validate-migration
test "$("$temporary/sqlite" -readonly "$temporary/forgejo.sqlite3" "SELECT id||':'||created FROM forgejo_migration;")" = original-migration:1700000000
test "$("$temporary/sqlite" -readonly "$temporary/forgejo.sqlite3" "SELECT id||':'||version FROM forgejo_version;")" = 1:42
stage=validate-source
test "$(/proof-sqlite -readonly "$db" "PRAGMA journal_mode;")" = wal
test -s "$db-wal"
printf 'WAL snapshot and original migration records retained\\n'`,
        ])
      ).out.trim();
      if (!/^[a-f0-9]{64}$/.test(cid)) throw new Error("Native SQLite create was not acknowledged");
      const result = await docker(
        ["start", "--attach", "--interactive", cid],
        await Bun.file(sqliteFile).bytes(),
      );
      expect(result.out.trim()).toBe("WAL snapshot and original migration records retained");
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (cid) {
          const [current] = JSON.parse((await docker(["inspect", cid])).out);
          if (current.Id !== cid || current.Config.Labels[label] !== owner) {
            errors.push(new Error("Native SQLite cleanup ownership changed"));
          } else await docker(["rm", "--force", cid]);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Native SQLite snapshot proof failed");
  },
  45000,
);
