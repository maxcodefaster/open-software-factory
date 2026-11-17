import { expect, test } from "bun:test";
import { resolve } from "node:path";
import upstream from "../../upstream.json";

test("pinned Linux backup exec preserves binary stdin and the inherited writer lock", async () => {
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
       sh /scripts/run.sh exec binary-input sh -c 'test -e /proc/self/fd/9; cat' < /tmp/input`,
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
