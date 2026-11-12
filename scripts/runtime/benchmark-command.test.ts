import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loggedBenchmarkCommand } from "./benchmark-command";

test("logged commands preserve bounded stdout/stderr and exact status", async () => {
  const dir = await mkdtemp(
    resolve(import.meta.dir, "../../.factory/test-results/command-output-"),
  );
  try {
    const result = await loggedBenchmarkCommand(
      [process.execPath, "-e", "console.log('out');console.error('err');process.exit(3)"],
      dir,
      "sample",
      { timeoutMS: 5000, outputBytes: 1024 },
    );
    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("timeout keeps already received evidence rather than losing native cause", async () => {
  const dir = await mkdtemp(
    resolve(import.meta.dir, "../../.factory/test-results/command-output-"),
  );
  try {
    await expect(
      loggedBenchmarkCommand(
        [process.execPath, "-e", "console.error('before timeout');setInterval(()=>{},1000)"],
        dir,
        "slow",
        { timeoutMS: 100, outputBytes: 1024 },
      ),
    ).rejects.toThrow("unconfirmed");
    expect(await readFile(resolve(dir, "slow.stderr"), "utf8")).toContain("before timeout");
  } finally {
    await rm(dir, { recursive: true });
  }
});
