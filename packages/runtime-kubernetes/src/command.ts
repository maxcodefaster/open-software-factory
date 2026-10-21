// One bounded subprocess boundary. A timeout is an unconfirmed external outcome,
// never permission to create a replacement resource identity.
export async function runCommand(
  argv: readonly string[],
  input?: string,
  limits = { timeoutMS: 15_000, outputBytes: 4 * 1024 * 1024 },
) {
  const child = Bun.spawn([...argv], {
    // Bun otherwise inherits the process's original environment, ignoring
    // configuration selected during startup, including the ServiceAccount config.
    env: process.env,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
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
    limits.timeoutMS,
  );
  try {
    const writing = (async () => {
      if (input !== undefined && child.stdin) {
        child.stdin.write(input);
        await child.stdin.flush();
        child.stdin.end();
      }
    })();
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([read(readers[0]!), read(readers[1]!), child.exited, writing]),
      deadline.promise,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
    await child.exited;
  }
}
