// Process and kubectl helpers for restore-rehearsal.ts.

export type Output = { stdout: string; stderr: string; code: number };
export type RunOptions = {
  input?: string | Uint8Array | Blob;
  allowFailure?: boolean;
  cwd?: string;
};

export async function run(command: string[], options: RunOptions = {}): Promise<Output> {
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
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 && !options.allowFailure)
    throw new Error(
      `${command.slice(0, 5).join(" ")} failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
    );
  return { stdout, stderr, code };
}

// Streams one command's output into another's input without holding it in memory.
export async function pipe(source: string[], sink: string[]) {
  const reader = Bun.spawn(source, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const writer = Bun.spawn(sink, { stdin: reader.stdout, stdout: "pipe", stderr: "pipe" });
  const [readerError, writerOut, writerError, readerCode, writerCode] = await Promise.all([
    new Response(reader.stderr).text(),
    new Response(writer.stdout).text(),
    new Response(writer.stderr).text(),
    reader.exited,
    writer.exited,
  ]);
  if (readerCode !== 0 || writerCode !== 0)
    throw new Error(
      `${source.slice(0, 5).join(" ")} | ${sink.slice(0, 5).join(" ")} failed (${readerCode}/${writerCode}): ${(readerError + writerError).trim().split("\n").slice(-3).join(" | ")}`,
    );
  return writerOut;
}

export async function until<T>(
  label: string,
  timeoutMs: number,
  attempt: () => Promise<T | null | undefined | false>,
) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await attempt();
      if (value) return value;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

export function cluster(context: string) {
  const withContext = (tool: string, flag: string, args: string[]) => [
    tool,
    ...(context ? [flag, context] : []),
    ...args,
  ];
  const kube = (...args: string[]) => withContext("kubectl", "--context", args);
  const helm = (...args: string[]) => withContext("helm", "--kube-context", args);
  return {
    kube,
    helm,
    kubectl: (args: string[], options?: RunOptions) => run(kube(...args), options),
    json: async (args: string[]) => JSON.parse((await run(kube(...args, "-o", "json"))).stdout),
    apply: (manifest: unknown) =>
      run(kube("apply", "-f", "-"), { input: JSON.stringify(manifest) }),
    exists: async (args: string[]) =>
      (await run(kube("get", ...args), { allowFailure: true })).code === 0,
  };
}
export type Cluster = ReturnType<typeof cluster>;
