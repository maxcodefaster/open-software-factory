import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startServiceForward } from "./service-forward";

async function fixture(hold = true) {
  const parent = resolve(".factory/test-results/service-forward");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(`${parent}/owned-`);
  const calls = resolve(directory, "arguments");
  const binary = resolve(directory, "kubectl");
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${calls}'\nprintf 'Forwarding from 127.0.0.1:32123 -> service\\n'\nexec /bin/sleep ${hold ? 60 : 0}\n`,
    { flag: "wx" },
  );
  await chmod(binary, 0o700);
  const previous = process.env["PATH"];
  return {
    calls: () => readFile(calls, "utf8"),
    start(namespace: string, pod: string) {
      try {
        process.env["PATH"] = `${directory}:${previous ?? ""}`;
        return startServiceForward(namespace, pod);
      } finally {
        if (previous === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previous;
      }
    },
    startDisconnected(namespace: string, pod: string) {
      const worker = resolve(import.meta.dir, "service-forward-process.ts");
      return Bun.spawn(
        [
          process.execPath,
          "--eval",
          `const { runServiceForward } = await import(${JSON.stringify(worker)});
await new Promise(resolve => {
  process.once("disconnect", resolve);
  process.disconnect();
});
await runServiceForward(${JSON.stringify([namespace, pod])});`,
        ],
        {
          env: { ...process.env, PATH: `${directory}:${previous ?? ""}` },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          ipc() {},
        },
      );
    },
    async close(connection?: ReturnType<typeof startServiceForward>) {
      if (connection?.child.exitCode === null) connection.child.kill("SIGTERM");
      if (connection) await connection.child.exited;
      await rm(directory, { recursive: true });
    },
  };
}

test("a disconnected editor forwarding child cannot start a late kubectl", async () => {
  const f = await fixture(false);
  const child = f.startDisconnected(`factory-editor-${"a".repeat(32)}`, "editor-2");
  try {
    await child.exited;
    await expect(f.calls()).rejects.toThrow();
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await f.close();
  }
});

test("the editor forwarding child retains its existing independent editor boundary", async () => {
  const f = await fixture();
  const namespace = `factory-editor-${"a".repeat(32)}`;
  const pod = "editor-2";
  const connection = f.start(namespace, pod);
  try {
    expect(await connection.endpoint).toBe("http://127.0.0.1:32123");
    expect((await f.calls()).trim().split("\n").slice(-7)).toEqual([
      "port-forward",
      "--address",
      "127.0.0.1",
      "-n",
      namespace,
      `pod/${pod}`,
      "0:4400",
    ]);
  } finally {
    await f.close(connection);
  }
});

test("editor forwarding refuses obsolete Source names and arbitrary Kubernetes targets", async () => {
  for (const [namespace, pod] of [
    [`factory-workspace-${"a".repeat(12)}`, "source-1"],
    [`factory-box-${"a".repeat(32)}`, "source-1"],
    [`factory-box-${"a".repeat(32)}`, "worker"],
    [`factory-box-${"a".repeat(32)}`, `source-${"b".repeat(32)}-0`],
    [`factory-editor-${"a".repeat(32)}`, `source-${"b".repeat(32)}-1`],
    [`factory-editor-${"a".repeat(32)}`, "editor-0"],
    [`factory-editor-${"a".repeat(32)}`, "worker"],
    ["kube-system", `source-${"b".repeat(32)}-1`],
  ] as const) {
    const f = await fixture();
    const connection = f.start(namespace, pod);
    try {
      await expect(connection.endpoint).rejects.toThrow("Developer IDE connection closed");
      await expect(f.calls()).rejects.toThrow();
    } finally {
      await f.close(connection);
    }
  }
});
