import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runEnvironmentCommand } from "../../packages/runtime-kubernetes/src/command";

test.each(["docker", "input-stop"])(
  "native %s wakeup HTTP remains within the official 250ms deadline without skipping current health",
  async (mode) => {
    const result = await runEnvironmentCommand(
      [
        "python3",
        resolve("test/fixtures/substrate-ready.py"),
        resolve("deploy/substrate/rootless/ready.py"),
        mode,
      ],
      { PATH: process.env["PATH"], HOME: process.env["HOME"] },
      { timeoutMS: 20_000, outputBytes: 64 * 1024 },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode,
      requestDeadlineMS: 250,
      initiallyUnready: true,
      slowHealthyCheck: true,
      deadProcessRefused: true,
      failedAndStaleChecksRefused: true,
    });
  },
  25_000,
);
