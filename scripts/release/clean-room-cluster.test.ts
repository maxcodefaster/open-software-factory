import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cluster,
  pipe,
  removeCleanRoomContainer,
  run,
  testCleanRoomChart,
  until,
} from "./clean-room-cluster";

test("clean-room commands pin the chosen context without selecting another cluster", () => {
  const cl = cluster("owned-context");
  expect(cl.kube("get", "nodes")).toEqual([
    "kubectl",
    "--context",
    "owned-context",
    "get",
    "nodes",
  ]);
  expect(cl.helm("test", "owned")).toEqual([
    "helm",
    "--kube-context",
    "owned-context",
    "test",
    "owned",
  ]);
});

test("the clean-room process helper joins output and nonzero outcomes", async () => {
  const argv = [
    process.execPath,
    "--no-env-file",
    "-e",
    "console.log('owned output');console.error('owned diagnostic');process.exit(7)",
  ];
  expect(await run(argv, { allowFailure: true })).toEqual({
    stdout: "owned output\n",
    stderr: "owned diagnostic\n",
    code: 7,
  });
  await expect(run(argv)).rejects.toThrow("failed (7)");
  expect(
    await run(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        "process.stdout.write((await new Response(Bun.stdin.stream()).text()).toUpperCase())",
      ],
      { input: "owned input" },
    ),
  ).toEqual({ stdout: "OWNED INPUT", stderr: "", code: 0 });
});

test("backup streaming joins both subprocesses and refuses either failed side", async () => {
  const source = (exit: number) => [
    process.execPath,
    "--no-env-file",
    "-e",
    `process.stdout.write('owned backup');process.exit(${exit})`,
  ];
  const sink = (exit: number) => [
    process.execPath,
    "--no-env-file",
    "-e",
    `process.stdout.write(await new Response(Bun.stdin.stream()).text());process.exit(${exit})`,
  ];
  expect(await pipe(source(0), sink(0))).toBe("owned backup");
  await expect(pipe(source(3), sink(0))).rejects.toThrow("failed (3/0)");
  await expect(pipe(source(0), sink(4))).rejects.toThrow("failed (0/4)");
});

test("a failed backup sink start terminates and joins its already-started source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-cleanroom-pipe-start-"));
  const ready = join(directory, "ready"),
    joined = join(directory, "joined");
  const source = [
    process.execPath,
    "--no-env-file",
    "-e",
    `
      process.once("SIGTERM", () => {
        require("node:fs").writeFileSync(${JSON.stringify(joined)}, "joined");
        process.exit(0);
      });
      await Bun.write(${JSON.stringify(ready)}, "ready");
      setInterval(() => {}, 1000);
    `,
  ];
  const reader = Bun.spawn(source, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let spawn: ReturnType<typeof spyOn> | undefined;
  try {
    await until("owned source", 3000, async () => await Bun.file(ready).exists());
    // Keep the source at the real post-spawn boundary while the real sink
    // executable lookup fails. No other process is substituted or stopped.
    spawn = spyOn(Bun, "spawn").mockImplementationOnce(() => reader);
    await expect(pipe(source, [join(directory, "missing-sink")])).rejects.toThrow();
    expect(await Promise.race([reader.exited, Bun.sleep(250).then(() => null)])).toBe(0);
    expect(await readFile(joined, "utf8")).toBe("joined");
  } finally {
    spawn?.mockRestore();
    if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL");
    await reader.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact cleanup deletes the observed container ID, never a later occupant of its name", async () => {
  const name = "factory-cleanroom-artifacts-1234abcd";
  const id = "a".repeat(64);
  const calls: string[][] = [];
  let replacementDeleted = false;
  await removeCleanRoomContainer(name, "1234abcd", async (command) => {
    calls.push(command);
    if (command.includes("inspect"))
      return { code: 0, stdout: JSON.stringify({ id, owner: "1234abcd" }), stderr: "" };
    // The original has been observed. The same name is now held by an
    // unrelated replacement; only the original immutable ID is ours.
    replacementDeleted = command.at(-1) === name;
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(calls.at(-1)).toEqual(["docker", "rm", "--force", id]);
  expect(replacementDeleted).toBe(false);
});

test.each([
  { code: 0, identity: { id: "a".repeat(64), owner: "another-owner" }, stderr: "" },
  { code: 0, identity: { id: "short-id", owner: "1234abcd" }, stderr: "" },
  { code: 0, identity: {}, stderr: "" },
  { code: 1, identity: null, stderr: "Docker daemon unavailable" },
  { code: 1, identity: null, stderr: "dial unix docker.sock: connect: no such file or directory" },
])("artifact cleanup refuses changed or unconfirmed ownership: %j", async (input) => {
  const calls: string[][] = [];
  await expect(
    removeCleanRoomContainer(
      "factory-cleanroom-artifacts-1234abcd",
      "1234abcd",
      async (command) => {
        calls.push(command);
        return { code: input.code, stdout: JSON.stringify(input.identity), stderr: input.stderr };
      },
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("an absent artifact reader needs no destructive cleanup", async () => {
  const calls: string[][] = [];
  await removeCleanRoomContainer(
    "factory-cleanroom-artifacts-1234abcd",
    "1234abcd",
    async (command) => {
      calls.push(command);
      return { code: 1, stdout: "", stderr: "No such container" };
    },
  );
  expect(calls).toHaveLength(1);
});

test("a successful observation returns once, while an expired wait performs no work", async () => {
  let calls = 0;
  expect(
    await until("owned observation", 100, async () => {
      calls++;
      return "observed";
    }),
  ).toBe("observed");
  expect(calls).toBe(1);
  await expect(
    until("expired observation", 0, async () => {
      calls++;
      return true;
    }),
  ).rejects.toThrow("Timed out waiting for expired observation");
  expect(calls).toBe(1);
});

test("cancellation joins the exact owned command even when it exits gracefully with zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-cleanroom-cancel-"));
  const ready = join(directory, "ready"),
    joined = join(directory, "joined");
  const controller = new AbortController();
  const command = [
    process.execPath,
    "--no-env-file",
    "-e",
    `
      process.once("SIGTERM", async () => {
        await Bun.sleep(25);
        await Bun.write(${JSON.stringify(joined)}, "joined");
        process.exit(0);
      });
      await Bun.write(${JSON.stringify(ready)}, "ready");
      setInterval(() => {}, 1000);
    `,
  ];
  const result = run(command, { signal: controller.signal }).then(
    () => false,
    () => true,
  );
  try {
    await until("owned command", 5000, async () => await Bun.file(ready).exists());
    controller.abort();
    expect(await result).toBe(true);
    expect(await readFile(joined, "utf8")).toBe("joined");
  } finally {
    controller.abort();
    await result;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation joins both owned backup-pipe processes without replaying either side", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-cleanroom-pipe-cancel-"));
  const controller = new AbortController();
  const child = (name: string) => [
    process.execPath,
    "--no-env-file",
    "-e",
    `
      process.once("SIGTERM", () => {
        require("node:fs").writeFileSync(${JSON.stringify(join(directory, `${name}-joined`))}, "joined");
        process.exit(0);
      });
      await Bun.write(${JSON.stringify(join(directory, `${name}-ready`))}, "ready");
      setInterval(() => {}, 1000);
    `,
  ];
  const result = pipe(child("reader"), child("writer"), controller.signal).then(
    () => false,
    () => true,
  );
  try {
    await until(
      "owned pipe",
      3000,
      async () =>
        (await Bun.file(join(directory, "reader-ready")).exists()) &&
        (await Bun.file(join(directory, "writer-ready")).exists()),
    );
    controller.abort();
    expect(await result).toBe(true);
    for (const name of ["reader", "writer"])
      expect(await readFile(join(directory, `${name}-joined`), "utf8")).toBe("joined");
  } finally {
    controller.abort();
    await result;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelled observations stop instead of swallowing cancellation and polling again", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(
    until(
      "cancelled observation",
      60000,
      async () => {
        calls++;
        controller.abort();
        return null;
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test.each([
  { exit: 0, stdout: "", logs: "", accepted: true },
  { exit: 1, stdout: "", logs: "FAIL node.budget no capacity", accepted: false },
  { exit: 1, stdout: "passed", logs: "WARN capacity observation unavailable", accepted: false },
  { exit: 1, stdout: "passed", logs: "", accepted: false },
])(
  "Helm test accepts only its real zero exit, not an old capacity exemption: %j",
  async (input) => {
    const calls: unknown[] = [];
    const cl = {
      ...cluster("owned-context"),
      helm(...args: string[]) {
        calls.push(["helm", ...args]);
        return [
          process.execPath,
          "--no-env-file",
          "-e",
          `process.stdout.write(${JSON.stringify(input.stdout)});process.exit(${input.exit})`,
        ];
      },
      async kubectl(...args: Parameters<ReturnType<typeof cluster>["kubectl"]>) {
        calls.push(["kubectl", ...args]);
        return { stdout: input.logs, stderr: "owned diagnostic", code: input.logs ? 0 : 1 };
      },
    };
    if (input.accepted) {
      await expect(testCleanRoomChart(cl, "factory", "owned-namespace")).resolves.toContain(
        "helm test passed",
      );
      expect(calls).toHaveLength(1);
    } else {
      await expect(testCleanRoomChart(cl, "factory", "owned-namespace")).rejects.toThrow(
        "helm test failed",
      );
      expect(calls[1]).toEqual([
        "kubectl",
        ["-n", "owned-namespace", "logs", "job/factory-preflight"],
        { allowFailure: true },
      ]);
    }
    expect(calls[0]).toEqual([
      "helm",
      "test",
      "factory",
      "-n",
      "owned-namespace",
      "--timeout",
      "25m",
    ]);
  },
);
