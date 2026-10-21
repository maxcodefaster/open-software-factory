import { expect, test } from "bun:test";
import { runCommand } from "./command";

test("commands inherit the current configured environment, not Bun's original startup environment", async () => {
  const key = "FACTORY_OWNED_COMMAND_ENVIRONMENT";
  const previous = process.env[key];
  process.env[key] = "current-owned-configuration";
  try {
    const result = await runCommand([
      process.execPath,
      "-e",
      `process.stdout.write(process.env["${key}"] ?? "missing")`,
    ]);
    expect(result.stdout).toBe("current-owned-configuration");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("a hung infrastructure process releases its caller within the deadline", async () => {
  await expect(
    runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], undefined, {
      timeoutMS: 50,
      outputBytes: 1024,
    }),
  ).rejects.toThrow("timed out; outcome is unconfirmed");
});
test("oversized output cannot exhaust memory or retain the process", async () => {
  await expect(
    runCommand(
      [
        process.execPath,
        "-e",
        'process.stdout.write("x".repeat(8192)); setInterval(() => {},1000)',
      ],
      undefined,
      { timeoutMS: 1000, outputBytes: 1024 },
    ),
  ).rejects.toThrow("output exceeded");
});
test("bounded commands drain both streams, input and nonzero exits", async () => {
  const result = await runCommand(
    [
      process.execPath,
      "-e",
      'const input=await Bun.stdin.text(); process.stdout.write(input); process.stderr.write("failed"); process.exit(7)',
    ],
    "owned input",
  );
  expect(result).toEqual({ stdout: "owned input", stderr: "failed", exitCode: 7 });
});
