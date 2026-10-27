// One bounded subprocess boundary. A timeout is an unconfirmed external outcome,
// never permission to create a replacement resource identity.
import { AsyncLocalStorage } from "node:async_hooks";

const commandDeadline = new AsyncLocalStorage<number>();
export function withCommandDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(deadline)) throw new Error("Invalid infrastructure deadline");
  return commandDeadline.run(Math.min(deadline, commandDeadline.getStore() ?? deadline), operation);
}
export async function runCommand(
  argv: readonly string[],
  input?: string,
  limits = { timeoutMS: 15_000, outputBytes: 4 * 1024 * 1024 },
) {
  return executeCommand(argv, input, limits);
}

export async function runInputStreamCommand(
  argv: readonly string[],
  input: ReadableStream<Uint8Array>,
  limits: { timeoutMS: number; outputBytes: number },
) {
  return executeCommand(argv, input, limits);
}

export async function runEnvironmentCommand(
  argv: readonly string[],
  environment: Record<string, string | undefined>,
  limits: { timeoutMS: number; outputBytes: number },
) {
  return executeCommand(argv, undefined, limits, environment);
}

async function executeCommand(
  argv: readonly string[],
  input: string | ReadableStream<Uint8Array> | undefined,
  limits: { timeoutMS: number; outputBytes: number },
  environment = process.env,
) {
  const remaining = (commandDeadline.getStore() ?? Number.POSITIVE_INFINITY) - performance.now();
  if (remaining <= 0)
    throw new Error("Infrastructure command deadline expired before external work");
  const timeoutMS = Math.min(limits.timeoutMS, remaining);
  const child = Bun.spawn([...argv], {
    // Bun otherwise inherits the process's original environment, ignoring
    // configuration selected during startup, including the ServiceAccount config.
    env: environment,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const readers = [child.stdout.getReader(), child.stderr.getReader()] as const;
  const source = input !== undefined && typeof input !== "string" ? input.getReader() : null;
  let bytes = 0;
  async function read(reader: (typeof readers)[number]) {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limits.outputBytes)
        throw new Error("Infrastructure command output exceeded its bound");
      text += decoder.decode(chunk.value, { stream: true });
    }
  }
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Infrastructure command timed out; outcome is unconfirmed")),
    timeoutMS,
  );
  try {
    const writing = (async () => {
      if (input !== undefined && child.stdin) {
        if (typeof input === "string") {
          child.stdin.write(input);
          await child.stdin.flush();
        } else if (source) {
          for (;;) {
            const chunk = await source.read();
            if (chunk.done) break;
            child.stdin.write(chunk.value);
            await child.stdin.flush();
          }
        }
        child.stdin.end();
      }
    })();
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([read(readers[0]), read(readers[1]), child.exited, writing]),
      deadline.promise,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await source?.cancel().catch(() => {});
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
    await child.exited;
  }
}
