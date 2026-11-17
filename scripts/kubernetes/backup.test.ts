import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const source = "deploy/helm/factory";
const evidence = resolve(".factory/test-results/backup-serialization");
const firstSet = "20261115T100000Z";
const secondSet = "20261115T100001Z";

// Use the rendered entrypoints, including the former init-container sequence, so removing
// the runner from the chart makes the concurrent-entry control fail too.
async function renderBackup(extra: string[] = []) {
  const child = Bun.spawn(
    [
      "helm",
      "template",
      "portable",
      source,
      "--set",
      "image=registry.example/factory:fixture",
      "--set",
      "development=true",
      "--set",
      "publicURL=http://127.0.0.1:58000",
      "--set",
      "forgejoPublicURL=https://git.example.com",
      "--set",
      "developmentZeroURL=http://127.0.0.1:58002",
      "--set",
      "substrate.workspaceConfigurationSecret=native-workspaces",
      "--set",
      "substrate.provisionerTokenSecret=native-provisioner",
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  const cron = parseAllDocuments(stdout)
    .map((document) => document.toJSON())
    .find((resource) => resource.kind === "CronJob");
  return cron;
}
const rendered = renderBackup();
const entrypoints = rendered.then((cron) => {
  const pod = cron.spec.jobTemplate.spec.template.spec;
  return [...pod.initContainers, ...pod.containers]
    .map((container) => container.command as string[])
    .filter((command) => command[0] === "sh" && command[1]?.startsWith("/scripts/"))
    .map((command) => command[1] as string);
});

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("backup fixture did not reach its checkpoint");
    await Bun.sleep(10);
  }
}

async function fixture() {
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(`${evidence}/test-`);
  const backup = `${root}/backup`;
  const scripts = `${root}/scripts`;
  const bin = `${root}/bin`;
  for (const directory of [backup, scripts, bin, `${root}/state/openbao`, `${root}/tmp`])
    await mkdir(directory, { recursive: true });
  await writeFile(`${root}/state/openbao/bootstrap.json`, "{}");
  for (const name of await readdir(`${source}/files/backup`)) {
    const text = await readFile(`${source}/files/backup/${name}`, "utf8");
    await writeFile(
      `${scripts}/${name}`,
      text.replace(
        /\/scripts\/|\/backup(?=["/\s])|\/state(?=["/\s])|\/tmp\/|\/openbao-login\/|\/openbao-token\//g,
        (path) => (path === "/scripts/" ? `${scripts}/` : `${root}${path}`),
      ),
    );
  }
  const commands = (await entrypoints).map((path) => path.replace("/scripts/", `${scripts}/`));
  await writeFile(
    `${root}/entry.sh`,
    commands
      .map(
        (path, index) =>
          `${index === commands.length - 1 ? "exec " : ""}sh '${path}'${index === commands.length - 1 ? "" : " || exit $?"}`,
      )
      .join("\n"),
  );
  const executable = (name: string, text: string) =>
    writeFile(`${bin}/${name}`, text, { mode: 0o755 });
  await executable("date", '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_SET"\n');
  // macOS has flock(2), but no flock CLI. This adapter calls the same native syscall on
  // the inherited descriptor. Linux and the separate pinned-image control use real flock.
  if (!Bun.which("flock"))
    await executable(
      "flock",
      `#!/usr/bin/env python3
import fcntl, sys
try:
    fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | (fcntl.LOCK_NB if "-n" in sys.argv else 0))
except BlockingIOError:
    sys.exit(1)
`,
    );
  if (!Bun.which("setsid"))
    await executable(
      "setsid",
      "#!/usr/bin/env python3\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n",
    );
  await writeFile(`${root}/tmp/forgejo-db.sql`, "fixture forgejo database");
  const archive = Bun.spawnSync([
    "tar",
    "-C",
    `${root}/tmp`,
    "-czf",
    `${root}/forgejo.tar.gz`,
    "forgejo-db.sql",
  ]);
  if (archive.exitCode !== 0) throw new Error(archive.stderr.toString());
  await executable(
    "kubectl",
    `#!/bin/sh
container=''
while [ "$1" != -- ]; do
  if [ "$1" = --container ]; then container=$2; shift; fi
  shift
done
shift
printf '%s\\n' "$*" >> "$FIXTURE/kubectl.calls"
stall_exec() {
  echo closed > "$FIXTURE/$FIXTURE_ID.exec-bytes-ended"
  # Model closed output streams without the exec completion status. Keep an
  # uncooperative owned descendant so killing just kubectl is insufficient.
  exec 1>&- 2>&-
  trap '' TERM
  sh -c 'trap "" TERM; echo "$$" >> "$FIXTURE/$FIXTURE_ID.exec-descendant.pid"; while [ ! -f "$FIXTURE/$FIXTURE_ID.release" ]; do sleep 0.02; done' &
  wait
}
if [ "$container" = postgres ]; then
  case "$*" in
    *'exec pg_dump '*) phase=postgres.dump ;;
    *'pg_restore --list'*) phase=postgres.validate ;;
    *'exec psql '*) phase=postgres.orphans ;;
    *) exit 2 ;;
  esac
  if [ "\${STALL_EXEC_PHASE:-}" = "$phase" ]; then
    POSTGRES_PASSWORD=fixture-postgres-password "$@" || exit $?
    stall_exec
    exit 0
  fi
  if [ "$phase" = postgres.validate ] && [ "\${REQUIRE_VALIDATION_EOF:-0}" = 1 ]; then
    POSTGRES_PASSWORD=fixture-postgres-password "$@"
    status=$?
    if [ -n "$(cat)" ]; then
      echo "CONTROL validation left unread input; exec completion is unconfirmed" >&2
      exit 124
    fi
    exit "$status"
  fi
  POSTGRES_PASSWORD=fixture-postgres-password exec "$@"
fi
case "$1" in
  sh)
    printf '%s' "$3" > "$FIXTURE/remote.sh"
    if [ "\${FAIL_FORGEJO:-0}" = 1 ]; then printf invalid; else cat "$FIXTURE/forgejo.tar.gz"; fi
    if [ "\${STALL_EXEC_PHASE:-}" = forgejo.dump ]; then stall_exec; fi ;;
  *) exit 2 ;;
esac
`,
  );
  await executable(
    "pg_dump",
    `#!/bin/sh
[ "$PGPASSWORD" = fixture-postgres-password ] || exit 2
[ "\${FAIL_POSTGRES:-0}" = 0 ] || exit 1
printf 'fixture postgres dump'
`,
  );
  await executable(
    "pg_restore",
    `#!/bin/sh
if [ "\${EARLY_RESTORE_READER:-0}" = 1 ]; then
  # pg_restore --list reads the header/TOC, not all archive data.
  dd bs=1 count=5 of=/dev/null 2>/dev/null
  [ "\${FAIL_POSTGRES_RESTORE:-0}" = 0 ]
  exit $?
fi
[ "\${FAIL_POSTGRES_RESTORE:-0}" = 0 ] && [ "$(cat)" = 'fixture postgres dump' ]
`,
  );
  await executable(
    "psql",
    `#!/bin/sh
[ "$PGPASSWORD" = fixture-postgres-password ] || exit 2
cat > /dev/null
printf 'foreign_key|factory.child|1\\n'
`,
  );
  await executable(
    "rclone",
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE/rclone.calls"
if [ "\${FIXTURE_BLOCK:-}" = "$1" ]; then
  echo "$$" > "$FIXTURE/$FIXTURE_ID.writer.pid"
  trap 'echo terminated > "$FIXTURE/$FIXTURE_ID.terminated"; exit 143' TERM
  echo "CONTROL blocked $1"
  while [ ! -f "$FIXTURE/$FIXTURE_ID.release" ]; do sleep 0.02; done
fi
case "$1" in
  sync)
    mkdir -p "$3"; printf object > "$3/object"
    while [ "$1" != --backup-dir ]; do shift; done
    mkdir -p "$2"; printf prior > "$2/prior-object" ;;
  copy) [ "\${FAIL_REMOTE:-0}" = 0 ] || exit 1 ;;
esac
`,
  );
  await writeFile(`${root}/tmp/meta.json`, "{}");
  const snapshot = Bun.spawnSync([
    "tar",
    "-C",
    `${root}/tmp`,
    "-czf",
    `${root}/snapshot.tar.gz`,
    "meta.json",
  ]);
  if (snapshot.exitCode !== 0) throw new Error(snapshot.stderr.toString());
  await executable(
    "bao",
    `#!/bin/sh
case "$1" in
  write) printf fixture-login-token ;;
  token) exit 0 ;;
  operator) cp "$FIXTURE/snapshot.tar.gz" "$5" ;;
  *) exit 2 ;;
esac
`,
  );
  const children: Array<{
    child: Pick<Bun.Subprocess, "exitCode" | "kill">;
    result: Promise<[number, string, string]>;
  }> = [];
  function start(id: string, extra: Record<string, string> = {}, command?: string[]) {
    const child = Bun.spawn(command ?? ["sh", `${root}/entry.sh`], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"]}`,
        FIXTURE: root,
        FIXTURE_ID: id,
        FIXTURE_SET: id === "first" ? firstSet : secondSet,
        BACKUP_POD_UID: `uid-${id}`,
        BACKUP_NAMESPACE: "fixture",
        POSTGRES_POD: "portable-postgres-0",
        FORGEJO_POD: "portable-forgejo-0",
        BACKUP_RETENTION: "1",
        BACKUP_REMOTE: "offsite:fixture",
        BACKUP_RETRY_SECONDS: "0",
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let output = "";
    const stdout = (async () => {
      for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
      return output;
    })();
    const result = Promise.all([child.exited, stdout, new Response(child.stderr).text()]);
    const running = {
      child,
      result,
      blocked: () =>
        until(async () => {
          if (child.exitCode !== null) {
            const [code, stdout, stderr] = await result;
            throw new Error(`backup exited before checkpoint: ${code}\n${stdout}\n${stderr}`);
          }
          return output.includes("CONTROL blocked");
        }),
    };
    children.push(running);
    return running;
  }
  const exists = (path: string) => Bun.file(`${backup}/${path}`).exists();
  const release = (id: string) => writeFile(`${root}/${id}.release`, "");
  const unlocked = async () => {
    const probe = start("probe", {}, ["sh", "-c", `exec 9>>'${backup}/.lock'; flock 9`]);
    expect((await probe.result)[0]).toBe(0);
  };
  return {
    root,
    backup,
    scripts,
    bin,
    start,
    exists,
    release,
    unlocked,
    current: () => readFile(`${backup}/.current`, "utf8"),
    async close() {
      await Promise.all(["first", "second"].map(release));
      for (const running of children) {
        if (running.child.exitCode === null) running.child.kill("SIGTERM");
      }
      await Promise.all(children.map((running) => running.result));
      await unlocked();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each(["sync", "copy"])(
  "overlapping backup entry cannot change .current or objects during %s",
  async (phase) => {
    const f = await fixture();
    try {
      const first = f.start("first", { FIXTURE_BLOCK: phase });
      await first.blocked();
      const second = await f.start("second").result;
      expect(second[0]).not.toBe(0);
      expect(await f.current()).toBe(firstSet);
      expect(await f.exists(`${secondSet}/COMPLETE`)).toBe(false);
      await f.release("first");
      expect((await first.result)[0]).toBe(0);
      expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(true);
    } finally {
      await f.close();
    }
  },
  15_000,
);

test("a surviving local child keeps the backup lock after the runner is killed", async () => {
  const f = await fixture();
  try {
    const first = f.start("first", { FIXTURE_BLOCK: "sync" });
    await first.blocked();
    const writer = Number(await readFile(`${f.root}/first.writer.pid`, "utf8"));
    first.child.kill("SIGKILL");
    await first.child.exited;
    expect(() => process.kill(writer, 0)).not.toThrow();
    expect((await f.start("second").result)[0]).not.toBe(0);
    expect(await f.current()).toBe(firstSet);
    await f.release("first");
    await first.result;
    await f.unlocked();
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(false);
    expect((await f.start("second").result)[0]).toBe(0);
  } finally {
    await f.close();
  }
}, 15_000);

test("runner termination signals its step and leaves an incomplete set without upload", async () => {
  const f = await fixture();
  try {
    const first = f.start("first", { FIXTURE_BLOCK: "sync" });
    await first.blocked();
    first.child.kill("SIGTERM");
    expect((await first.result)[0]).toBe(143);
    expect(await Bun.file(`${f.root}/first.terminated`).exists()).toBe(true);
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(false);
    expect(await readFile(`${f.root}/rclone.calls`, "utf8")).not.toContain("copy ");
    await f.unlocked();
  } finally {
    await f.close();
  }
}, 15_000);

test.each([false, true])(
  "validation drains early-reader stdin without hiding pg_restore failure=%p",
  async (fail) => {
    const f = await fixture();
    try {
      const [code, , diagnostics] = await f.start("first", {
        REQUIRE_VALIDATION_EOF: "1",
        EARLY_RESTORE_READER: "1",
        FAIL_POSTGRES_RESTORE: fail ? "1" : "0",
      }).result;
      expect(diagnostics).not.toContain("CONTROL validation left unread input");
      expect(code === 0).toBe(!fail);
      expect(await f.exists(`${firstSet}/postgres.ok`)).toBe(!fail);
      expect(await f.exists(`${firstSet}/postgres.failed`)).toBe(fail);
      expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(!fail);
      await f.unlocked();
    } finally {
      await f.close();
    }
  },
  10_000,
);

test.each([
  ["postgres.dump", "postgres", 5],
  ["postgres.validate", "postgres", 5],
  ["postgres.orphans", "postgres", 1],
  ["forgejo.dump", "forgejo", 3],
] as const)(
  "closed %s bytes without exec completion terminate owned descendants and fail closed",
  async (phase, step, attempts) => {
    const f = await fixture();
    const unrelated = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const first = f.start("first", {
        STALL_EXEC_PHASE: phase,
        BACKUP_EXEC_TIMEOUT_SECONDS: "1",
      });
      await until(() => Bun.file(`${f.root}/first.exec-descendant.pid`).exists());
      const outcome = await Promise.race([first.result, Bun.sleep(8_500).then(() => null)]);
      expect(outcome).not.toBeNull();
      expect(outcome?.[0]).not.toBe(0);
      const descendants = (await readFile(`${f.root}/first.exec-descendant.pid`, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      expect(descendants).toHaveLength(attempts);
      for (const descendant of descendants) expect(() => process.kill(descendant, 0)).toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(outcome?.[2]).toContain(`Backup exec ${phase} timed out after 1s`);
      if (attempts > 1)
        expect(outcome?.[2]).toContain(`Attempt ${attempts - 1} of ${attempts} failed`);
      expect(await f.exists(`${firstSet}/${step}.failed`)).toBe(true);
      expect(await f.exists(`${firstSet}/${step}.ok`)).toBe(false);
      if (phase === "postgres.dump" || phase === "postgres.validate") {
        expect(await f.exists(`${firstSet}/postgres.dump`)).toBe(false);
        expect(await readFile(`${f.backup}/${firstSet}/postgres.dump.part`, "utf8")).toBe(
          "fixture postgres dump",
        );
      }
      if (step === "postgres") expect(await f.exists(`${firstSet}/forgejo.tar.gz`)).toBe(true);
      expect(await f.exists(`${firstSet}/state.tar.gz`)).toBe(true);
      expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(false);
      expect(await readFile(`${f.root}/rclone.calls`, "utf8")).not.toContain("copy ");
      await f.unlocked();
    } finally {
      unrelated.kill("SIGKILL");
      await unrelated.exited;
      await f.close();
    }
  },
  15_000,
);

test("a larger exec deadline allows delayed confirmed completion without a success fallback", async () => {
  const f = await fixture();
  try {
    const first = f.start("first", {
      STALL_EXEC_PHASE: "postgres.dump",
      BACKUP_EXEC_TIMEOUT_SECONDS: "3",
    });
    await until(() => Bun.file(`${f.root}/first.exec-descendant.pid`).exists());
    await Bun.sleep(1_100);
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(false);
    await f.release("first");
    const [code, , stderr] = await first.result;
    expect(code).toBe(0);
    expect(stderr).toContain("Backup exec postgres.dump started; deadline 3s");
    expect(stderr).toContain("Backup exec postgres.dump exited with status 0");
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(true);
    await f.unlocked();
  } finally {
    await f.close();
  }
}, 10_000);

test("runner cancellation bounds an exec with a TERM-ignoring descendant", async () => {
  const f = await fixture();
  try {
    const first = f.start("first", { STALL_EXEC_PHASE: "postgres.dump" });
    await until(() => Bun.file(`${f.root}/first.exec-descendant.pid`).exists());
    first.child.kill("SIGTERM");
    const outcome = await Promise.race([first.result, Bun.sleep(1_500).then(() => null)]);
    expect(outcome?.[0]).toBe(143);
    const descendant = Number(await readFile(`${f.root}/first.exec-descendant.pid`, "utf8"));
    expect(() => process.kill(descendant, 0)).toThrow();
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(false);
    expect(await f.exists(`${firstSet}/postgres.ok`)).toBe(false);
    expect(await Bun.file(`${f.root}/rclone.calls`).exists()).toBe(false);
    await f.unlocked();
  } finally {
    await f.close();
  }
}, 10_000);

test("the chart exposes a positive per-exec deadline without changing the Job ceiling", async () => {
  const job = (await rendered).spec.jobTemplate.spec;
  expect(job.activeDeadlineSeconds).toBe(21600);
  expect(job.template.spec.containers[0].env).toContainEqual({
    name: "BACKUP_EXEC_TIMEOUT_SECONDS",
    value: "1800",
  });
  const custom = await renderBackup(["--set", "backup.execTimeoutSeconds=7200"]);
  expect(custom.spec.jobTemplate.spec.template.spec.containers[0].env).toContainEqual({
    name: "BACKUP_EXEC_TIMEOUT_SECONDS",
    value: "7200",
  });
  for (const invalid of ["0", "-1", "1.5", "never", ""]) {
    await expect(
      renderBackup(["--set-string", `backup.execTimeoutSeconds=${invalid}`]),
    ).rejects.toThrow("backup.execTimeoutSeconds must be a positive whole number");
  }
});

test("backup failure retains later archives but cannot complete, prune or upload", async () => {
  const f = await fixture();
  try {
    await mkdir(`${f.backup}/20261114T100000Z`);
    await writeFile(`${f.backup}/20261114T100000Z/COMPLETE`, "");
    expect((await f.start("first", { FAIL_POSTGRES: "1" }).result)[0]).not.toBe(0);
    expect(await f.exists(`${firstSet}/postgres.failed`)).toBe(true);
    expect(await f.exists(`${firstSet}/forgejo.tar.gz`)).toBe(true);
    expect(await f.exists(`${firstSet}/state.tar.gz`)).toBe(true);
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(false);
    expect(await f.exists("20261114T100000Z/COMPLETE")).toBe(true);
    expect(await readFile(`${f.root}/rclone.calls`, "utf8")).not.toContain("copy ");
  } finally {
    await f.close();
  }
});

test("a complete backup keeps archive checks, retention, orphan warnings and offsite copies", async () => {
  const f = await fixture();
  try {
    for (const set of ["20261113T100000Z", "20261114T100000Z"]) {
      await mkdir(`${f.backup}/${set}`);
      await mkdir(`${f.backup}/objects-changed/${set}`, { recursive: true });
    }
    await writeFile(`${f.backup}/20261113T100000Z/COMPLETE`, "");
    const [code, , stderr] = await f.start("first").result;
    expect(code).toBe(0);
    expect(stderr).toContain("database has rows without a parent");
    expect(await f.exists(`${firstSet}/postgres.dump`)).toBe(true);
    expect(await f.exists(`${firstSet}/forgejo.tar.gz`)).toBe(true);
    expect(await f.exists(`${firstSet}/state.tar.gz`)).toBe(true);
    expect(await f.exists(`${firstSet}/openbao.skipped`)).toBe(true);
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(true);
    expect(await readdir(f.backup)).not.toContain("20261113T100000Z");
    expect(await readdir(f.backup)).not.toContain("20261114T100000Z");
    expect(await readdir(`${f.backup}/objects-changed`)).toEqual([firstSet]);
    const calls = await readFile(`${f.root}/rclone.calls`, "utf8");
    expect(calls).toContain(`copy ${f.backup}/${firstSet} offsite:fixture/${firstSet}`);
    expect(calls).toContain(`copy ${f.backup}/objects offsite:fixture/objects`);
    expect(calls).toContain(
      `copy ${f.backup}/objects-changed/${firstSet} offsite:fixture/objects-changed/${firstSet}`,
    );
    const pg = await readFile(`${f.root}/kubectl.calls`, "utf8");
    expect(pg).toContain("pg_dump --format=custom");
    expect(pg).toContain("pg_restore --list");
  } finally {
    await f.close();
  }
});

test("failed offsite copy fails the Job without losing its complete local set", async () => {
  const f = await fixture();
  try {
    const [code, , stderr] = await f.start("first", { FAIL_REMOTE: "1" }).result;
    expect(code).not.toBe(0);
    expect(stderr).toContain("complete locally but the upload to the remote failed");
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(true);
  } finally {
    await f.close();
  }
});

test.each([
  ["postgres", "FAIL_POSTGRES_RESTORE"],
  ["forgejo", "FAIL_FORGEJO"],
] as const)("an invalid %s archive still fails closed", async (step, flag) => {
  const f = await fixture();
  try {
    expect((await f.start("first", { [flag]: "1" }).result)[0]).not.toBe(0);
    expect(await f.exists(`${firstSet}/${step}.failed`)).toBe(true);
    expect(await f.exists(`${firstSet}/${step}.ok`)).toBe(false);
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(false);
    expect(await readFile(`${f.root}/rclone.calls`, "utf8")).not.toContain("copy ");
  } finally {
    await f.close();
  }
});

test("the runner keeps OpenBao snapshot validation and the retained state archive", async () => {
  const f = await fixture();
  try {
    await mkdir(`${f.root}/openbao-login`);
    await writeFile(`${f.root}/openbao-login/secret-id`, "fixture-credential");
    expect((await f.start("first").result)[0]).toBe(0);
    expect(await f.exists(`${firstSet}/openbao.snap`)).toBe(true);
    expect(await f.exists(`${firstSet}/openbao.ok`)).toBe(true);
    expect(await f.exists(`${firstSet}/openbao.skipped`)).toBe(false);
    expect(await f.exists(`${firstSet}/state.tar.gz`)).toBe(true);
    expect(await f.exists(`${firstSet}/COMPLETE`)).toBe(true);
  } finally {
    await f.close();
  }
});

test("an existing timestamp cannot redirect .current or overwrite a completed archive", async () => {
  const f = await fixture();
  try {
    expect((await f.start("first").result)[0]).toBe(0);
    const calls = await readFile(`${f.root}/rclone.calls`, "utf8");
    const archive = await Bun.file(`${f.backup}/${firstSet}/postgres.dump`).bytes();
    expect((await f.start("first").result)[0]).not.toBe(0);
    expect(await f.current()).toBe(firstSet);
    expect(await readFile(`${f.root}/rclone.calls`, "utf8")).toBe(calls);
    expect(await Bun.file(`${f.backup}/${firstSet}/postgres.dump`).bytes()).toEqual(archive);
  } finally {
    await f.close();
  }
});

test.each(["uid-first", "uid-second"])(
  "a surviving remote Forgejo dump cannot share temp files with a retry or Job using %s",
  async (nextUID) => {
    const f = await fixture();
    try {
      expect((await f.start("capture").result)[0]).toBe(0);
      const remote = (await readFile(`${f.root}/remote.sh`, "utf8")).replace(
        "/var/lib/gitea/git/repositories",
        `${f.root}/repositories`,
      );
      await writeFile(`${f.root}/remote.sh`, remote);
      await writeFile(
        `${f.bin}/forgejo`,
        `#!/bin/sh
while [ "$1" != --tempdir ]; do shift; done
temporary=$2
printf '%s' "$temporary" > "$FIXTURE/$FIXTURE_ID.remote-dir"
printf '%s' "$BACKUP_POD_UID" > "$temporary/forgejo-db.sql"
if [ "$FIXTURE_ID" = first ]; then
  echo "CONTROL blocked remote dump"
  while [ ! -f "$FIXTURE/first.release" ]; do sleep 0.02; done
fi
`,
        { mode: 0o755 },
      );
      const first = f.start("first", {}, ["sh", `${f.root}/remote.sh`, "uid-first"]);
      await first.blocked();
      const firstDirectory = await readFile(`${f.root}/first.remote-dir`, "utf8");
      expect(
        (
          await f.start("second", { BACKUP_POD_UID: nextUID }, [
            "sh",
            `${f.root}/remote.sh`,
            nextUID,
          ]).result
        )[0],
      ).toBe(0);
      const nextDirectory = await readFile(`${f.root}/second.remote-dir`, "utf8");
      expect(nextDirectory).not.toBe(firstDirectory);
      expect(firstDirectory).toContain("factory-backup.uid-first.");
      expect(nextDirectory).toContain(`factory-backup.${nextUID}.`);
      expect(await readFile(`${firstDirectory}/forgejo-db.sql`, "utf8")).toBe("uid-first");
      expect(await Bun.file(`${nextDirectory}/forgejo-db.sql`).exists()).toBe(false);
      await f.release("first");
      expect((await first.result)[0]).toBe(0);
      expect(await Bun.file(`${firstDirectory}/forgejo-db.sql`).exists()).toBe(false);
    } finally {
      await f.close();
    }
  },
  15_000,
);
