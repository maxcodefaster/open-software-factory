import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startServiceForward } from "./service-forward";

async function fixture() {
  const parent = resolve(".factory/test-results/service-forward");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(`${parent}/owned-`);
  const calls = resolve(directory, "arguments");
  const binary = resolve(directory, "kubectl");
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${calls}'\nprintf 'Forwarding from 127.0.0.1:32123 -> service\\n'\nexec /bin/sleep 60\n`,
    { flag: "wx" },
  );
  await chmod(binary, 0o700);
  const previous = process.env["PATH"];
  return {
    calls: () => readFile(calls, "utf8"),
    start(role: "source" | "editor", namespace: string, pod: string) {
      try {
        process.env["PATH"] = `${directory}:${previous ?? ""}`;
        return startServiceForward(role, namespace, pod);
      } finally {
        if (previous === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previous;
      }
    },
    async close(connection?: ReturnType<typeof startServiceForward>) {
      if (connection?.child.exitCode === null) connection.child.kill("SIGTERM");
      if (connection) await connection.child.exited;
      await rm(directory, { recursive: true });
    },
  };
}

test("the actual Source forwarding child admits a shared Factorybox namespace and full Workspace epoch", async () => {
  const f = await fixture();
  const namespace = `factory-box-${"a".repeat(32)}`;
  const pod = `source-${"b".repeat(32)}-12`;
  const connection = f.start("source", namespace, pod);
  try {
    expect(await connection.endpoint).toBe("http://127.0.0.1:32123");
    const args = (await f.calls()).trim().split("\n");
    expect(args.slice(-7)).toEqual([
      "port-forward",
      "--address",
      "127.0.0.1",
      "-n",
      namespace,
      `pod/${pod}`,
      "0:4600",
    ]);
  } finally {
    await f.close(connection);
  }
});

test("the editor forwarding child retains its existing independent editor boundary", async () => {
  const f = await fixture();
  const connection = f.start("editor", `factory-editor-${"a".repeat(32)}`, "editor-2");
  try {
    expect(await connection.endpoint).toBe("http://127.0.0.1:32123");
    expect((await f.calls()).trim().split("\n").at(-1)).toBe("0:4400");
  } finally {
    await f.close(connection);
  }
});

test("Source forwarding refuses legacy names, another service role and arbitrary exec targets", async () => {
  for (const [namespace, pod] of [
    [`factory-workspace-${"a".repeat(12)}`, "source-1"],
    [`factory-box-${"a".repeat(32)}`, "source-1"],
    [`factory-box-${"a".repeat(32)}`, "worker"],
    [`factory-box-${"a".repeat(32)}`, `source-${"b".repeat(32)}-0`],
    [`factory-editor-${"a".repeat(32)}`, `source-${"b".repeat(32)}-1`],
    ["kube-system", `source-${"b".repeat(32)}-1`],
  ] as const) {
    const f = await fixture();
    const connection = f.start("source", namespace, pod);
    try {
      await expect(connection.endpoint).rejects.toThrow("Source connection closed");
      await expect(f.calls()).rejects.toThrow();
    } finally {
      await f.close(connection);
    }
  }
});
