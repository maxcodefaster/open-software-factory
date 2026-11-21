import { spawn, spawnSync } from "node:child_process";

// Only local clients created by this invocation are ours. Cancelling one never
// substitutes for native Stop or deletes resources managed by another process.
export type Output = { stdout: string; stderr: string; code: number };
export type RunOptions = {
  input?: string | Uint8Array | Blob;
  allowFailure?: boolean;
  cwd?: string;
  signal?: AbortSignal | undefined;
};
type OwnedChild = Pick<
  ReturnType<typeof Bun.spawn>,
  "exitCode" | "signalCode" | "kill" | "exited"
> & {
  running?: () => boolean;
};

function cancellation(children: OwnedChild[], signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signalled = new Set<OwnedChild>();
  const live = (child: (typeof children)[number]) =>
    child.running?.() ?? (child.exitCode === null && child.signalCode === null);
  const stop = () => {
    const forwarded = signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
    for (const child of children)
      if (!signalled.has(child) && live(child)) {
        child.kill(forwarded);
        signalled.add(child);
      }
    timer ??= setTimeout(() => {
      for (const child of children) if (live(child)) child.kill("SIGKILL");
    }, 1000);
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  return {
    stop,
    async reap(closed: Promise<void>) {
      stop();
      const deadline = Date.now() + 2000;
      let limit: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, fail) => {
        limit = setTimeout(() => fail(new Error("Owned client process cleanup unconfirmed")), 2000);
      });
      try {
        await Promise.race([Promise.allSettled(children.map((child) => child.exited)), expired]);
        while (children.some(live)) {
          if (Date.now() >= deadline) throw new Error("Owned client process cleanup unconfirmed");
          await new Promise((complete) => setTimeout(complete, 20));
        }
        await Promise.race([closed, expired]);
      } finally {
        clearTimeout(limit);
      }
    },
    detach() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    },
  };
}

// Some fixture owners publish a mutable list before starting their local clients.
// Keep that same list so cancellation also joins clients admitted during startup.
export function ownClientProcesses(children: OwnedChild[], signal?: AbortSignal) {
  const cleanup = cancellation(children, signal);
  return async () => {
    try {
      await cleanup.reap(Promise.resolve());
    } finally {
      cleanup.detach();
    }
  };
}

// Test commands can spawn runners and compilers. Own their process group even
// when its leader exits successfully before a descendant acknowledges Stop.
export async function runProcess(
  command: string[],
  options: Pick<RunOptions, "cwd" | "signal" | "allowFailure"> & {
    env?: Record<string, string | undefined>;
    output?: "inherit" | "pipe";
  } = {},
): Promise<Output> {
  options.signal?.throwIfAborted();
  const [executable, ...args] = command;
  if (!executable) throw new Error("Owned client command is empty");
  const grouped = process.platform !== "win32";
  const child = spawn(executable, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    detached: grouped,
    stdio: ["ignore", options.output ?? "pipe", options.output ?? "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise<void>((complete) => child.once("close", () => complete()));
  const exited = new Promise<number>((complete, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => complete(code ?? 1));
  });
  const running = () => {
    if (!child.pid) return false;
    if (!grouped) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (cause) {
      // Observe membership when Darwin reports EPERM for an exiting group.
      // A permission error alone never confirms that its descendants stopped.
      if ((cause as NodeJS.ErrnoException).code === "EPERM") {
        const observed = spawnSync("ps", ["-axo", "pgid="], { encoding: "utf8" });
        if (observed.status !== 0) throw cause;
        return observed.stdout.split(/\s+/).some((group) => Number(group) === child.pid);
      }
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      return false;
    }
  };
  const cleanup = cancellation(
    [
      {
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
        exited,
        running,
        kill(signal) {
          try {
            if (grouped && child.pid) process.kill(-child.pid, signal ?? "SIGTERM");
            else child.kill(signal);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "EPERM" && !running()) return;
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
          }
        },
      },
    ],
    options.signal,
  );
  let code: number;
  try {
    code = await exited;
  } finally {
    try {
      await cleanup.reap(closed);
    } finally {
      cleanup.detach();
    }
  }
  options.signal?.throwIfAborted();
  if (code !== 0 && !options.allowFailure)
    throw new Error(
      `${command.slice(0, 5).join(" ")} failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
    );
  return { stdout, stderr, code };
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
