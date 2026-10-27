import { expect, test } from "bun:test";
import { runCommand, runInputStreamCommand } from "./command";

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

test("binary Project source streams use stdin without converting or buffering the entire archive", async () => {
  const chunks = [new Uint8Array([0, 1, 255]), new Uint8Array([17, 0, 128])];
  const result = await runInputStreamCommand(
    [
      process.execPath,
      "-e",
      'process.stdout.write(Buffer.from(await Bun.stdin.arrayBuffer()).toString("base64"))',
    ],
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { timeoutMS: 1000, outputBytes: 1024 },
  );
  expect(result.stdout).toBe(Buffer.concat(chunks).toString("base64"));
});

test("a stalled source stream releases its caller and cancels input on the original deadline", async () => {
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    runInputStreamCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], input, {
      timeoutMS: 50,
      outputBytes: 1024,
    }),
  ).rejects.toThrow("timed out; outcome is unconfirmed");
  expect(cancelled).toBe(true);
});
