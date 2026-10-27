// The receiver is Linux Python, not macOS tar. AppleDouble entries would
// become untracked files there instead of restoring Finder metadata.
export async function archiveFixtureProject(source: string): Promise<Buffer> {
  const child = Bun.spawn(["tar", "-C", source, "-cf", "-", "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;
      if (bytes > 768 * 1024) throw new Error("Owned source archive exceeds its bound");
      chunks.push(chunk);
    }
    if ((await child.exited) !== 0) throw new Error("Owned source archive failed");
    return Buffer.concat(chunks);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
}
