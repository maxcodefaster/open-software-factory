// Only local clients created by this invocation are ours. Cancelling one never
// substitutes for native Stop or deletes resources managed by another process.
export type Output = { stdout: string; stderr: string; code: number };
export type RunOptions = {
  input?: string | Uint8Array | Blob;
  allowFailure?: boolean;
  cwd?: string;
  signal?: AbortSignal | undefined;
};
type OwnedChild = Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "signalCode" | "kill" | "exited">;

function cancellation(children: OwnedChild[], signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const live = (child: (typeof children)[number]) =>
    child.exitCode === null && child.signalCode === null;
  const stop = () => {
    for (const child of children) if (live(child)) child.kill("SIGTERM");
    timer ??= setTimeout(() => {
      for (const child of children) if (live(child)) child.kill("SIGKILL");
    }, 1000);
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  return {
    stop,
    detach() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    },
  };
}

export async function runBytes(command: string[], options: RunOptions = {}) {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(command, {
    stdin:
      options.input === undefined
        ? "ignore"
        : options.input instanceof Blob
          ? options.input
          : new Blob([options.input as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const cleanup = cancellation([child], options.signal);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    options.signal?.throwIfAborted();
    if (code !== 0 && !options.allowFailure)
      throw new Error(
        `${command.slice(0, 5).join(" ")} failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
      );
    return { stdout, stderr, code };
  } finally {
    cleanup.stop();
    await child.exited;
    cleanup.detach();
  }
}

export async function run(command: string[], options: RunOptions = {}): Promise<Output> {
  const result = await runBytes(command, options);
  return { ...result, stdout: new TextDecoder().decode(result.stdout) };
}

// Streams one command's output into another's input without holding it in memory.
export async function pipe(source: string[], sink: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const reader = Bun.spawn(source, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const children: OwnedChild[] = [reader];
  const cleanup = cancellation(children, signal);
  try {
    const writer = Bun.spawn(sink, { stdin: reader.stdout, stdout: "pipe", stderr: "pipe" });
    children.push(writer);
    const [readerError, writerOut, writerError, readerCode, writerCode] = await Promise.all([
      new Response(reader.stderr).text(),
      new Response(writer.stdout).text(),
      new Response(writer.stderr).text(),
      reader.exited,
      writer.exited,
    ]);
    signal?.throwIfAborted();
    if (readerCode !== 0 || writerCode !== 0)
      throw new Error(
        `${source.slice(0, 5).join(" ")} | ${sink.slice(0, 5).join(" ")} failed (${readerCode}/${writerCode}): ${(readerError + writerError).trim().split("\n").slice(-3).join(" | ")}`,
      );
    return writerOut;
  } finally {
    cleanup.stop();
    await Promise.allSettled(children.map((child) => child.exited));
    cleanup.detach();
  }
}
