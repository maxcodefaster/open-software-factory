import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Keep bounded partial output even when an infrastructure caller times out.
// This kills only the local transport; native outcome/recovery remains unconfirmed.
export async function loggedBenchmarkCommand(
  args: readonly string[],
  directory: string,
  name: string,
  limits: { timeoutMS: number; outputBytes: number },
) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid benchmark command name");
  await mkdir(directory, { recursive: true });
  const stdoutPath = resolve(directory, `${name}.stdout`);
  const stderrPath = resolve(directory, `${name}.stderr`);
  const stdout = await open(stdoutPath, "wx", 0o600);
  const stderr = await open(stderrPath, "wx", 0o600);
  const child = Bun.spawn([...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let bytes = 0;
  const copy = async (stream: ReadableStream<Uint8Array>, file: typeof stdout) => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        bytes += chunk.value.byteLength;
        if (bytes > limits.outputBytes)
          throw new Error("Benchmark command output exceeded its original bound");
        await file.write(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  };
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Benchmark command timed out; native outcome is unconfirmed")),
    limits.timeoutMS,
  );
  const readers = [copy(child.stdout, stdout), copy(child.stderr, stderr)] as const;
  try {
    const [, , exitCode] = await Promise.race([
      Promise.all([readers[0], readers[1], child.exited]),
      deadline.promise,
    ]);
    return {
      exitCode,
      stdout: await readFile(stdoutPath, "utf8"),
      stderr: await readFile(stderrPath, "utf8"),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await Promise.allSettled(readers);
    await Promise.all([stdout.close(), stderr.close()]);
  }
}
