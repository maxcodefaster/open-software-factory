import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
