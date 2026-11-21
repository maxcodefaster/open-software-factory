import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRuntimeSourceArchive } from "../../apps/factory/src/runtime/git-http";

test("clean template source preserves its exact Git commit without carrying transport credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-template-source-test-"));
  const projectID = crypto.randomUUID();
  let archive: Awaited<ReturnType<typeof cleanRuntimeSourceArchive>> | undefined;
  async function git(args: string[]) {
    const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
    const value = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error("Owned source setup failed");
    return value.trim();
  }
  try {
    await writeFile(join(root, "source.txt"), "retained source");
    await git(["init", "-b", "main"]);
    await git(["config", "http.extraHeader", "Authorization: transport-secret-must-not-copy"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "source",
    ]);
    const revision = await git(["rev-parse", "HEAD"]);
    archive = await cleanRuntimeSourceArchive(`file://${root}`, revision, projectID);
    const bytes = Buffer.from(await archive.file.arrayBuffer());
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bytes.includes(Buffer.from("transport-secret-must-not-copy"))).toBe(false);
    expect(bytes.includes(Buffer.from(`https://unassigned.invalid/${projectID}.git`))).toBe(true);
    expect(bytes.includes(Buffer.from(revision))).toBe(true);
    expect(await git(["rev-parse", "HEAD"])).toBe(revision);
    expect(await git(["status", "--porcelain"])).toBe("");
  } finally {
    await archive?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime fixture observes successive atomic Source saves through its native WebSocket", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-runtime-watch-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let socket: WebSocket | undefined;
  try {
    await mkdir(join(root, "src"));
    const source = await readFile("test/fixtures/runtime-project/src/server.mjs", "utf8");
    expect(source).toContain('server.listen(4300, "0.0.0.0");');
    await writeFile(
      join(root, "src/server.mjs"),
      source.replace(
        'server.listen(4300, "0.0.0.0");',
        `server.listen(0, "127.0.0.1", () => console.log(server.address().port));`,
      ),
    );
    await writeFile(join(root, "src/version.txt"), "one\n");
    const server = Bun.spawn(["node", join(root, "src/server.mjs")], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    child = server;
    const reader = server.stdout.getReader();
    const first = await reader.read();
    const port = Number(
      Buffer.from(first.value ?? [])
        .toString()
        .trim(),
    );
    expect(port).toBeGreaterThan(0);
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const ws = socket;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(Error("Owned fixture socket failed")), {
        once: true,
      });
    });
    for (const version of ["two", "one", "three"]) {
      const observation = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.removeEventListener("message", observed);
          reject(Error(`Fixture lost atomic Source save ${version}`));
        }, 1000);
        const observed = (event: MessageEvent) => {
          const value = JSON.parse(String(event.data));
          if (value.type !== "hot-update" || value.version !== version) return;
          clearTimeout(timer);
          ws.removeEventListener("message", observed);
          resolve();
        };
        ws.addEventListener("message", observed);
      });
      const temporary = join(root, `src/next-${version}`);
      await writeFile(temporary, `${version}\n`);
      await rename(temporary, join(root, "src/version.txt"));
      await observation;
      const response = await fetch(`http://127.0.0.1:${port}/source`);
      expect((await response.json()).version).toBe(version);
    }
  } finally {
    socket?.close();
    if (child?.exitCode === null) child.kill("SIGTERM");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
