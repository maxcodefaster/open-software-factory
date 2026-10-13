import { test, expect } from "bun:test";
import { mkdtemp, readFile, chmod, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeSkillManifest } from "./native";
import { requirementsInterviewSkill } from "./reviewed";
import { installSkills } from "../../../../deploy/opencode-server/install-skills.mjs";

test("native installer is idempotent, refuses replacement, corruption, missing metadata and symlinks", async () => {
  const own = await mkdtemp(join(tmpdir(), "factory-skills-proof-"));
  const revision = {
    id: crypto.randomUUID(),
    revision: 1,
    content: requirementsInterviewSkill,
    digest: "a".repeat(64),
    published: true,
  };
  const manifest = nativeSkillManifest([revision]);
  const root = join(own, "skills");
  try {
    await installSkills(manifest, root);
    await installSkills(manifest, root);
    const target = join(root, manifest.files[0]!.path);
    expect(await readFile(target, "utf8")).toContain(requirementsInterviewSkill.instructions);
    await expect(installSkills(nativeSkillManifest([]), root)).rejects.toThrow("another");
    await chmod(target, 0o644);
    await writeFile(target, "changed");
    await expect(installSkills(manifest, root)).rejects.toThrow("changed");
    const link = join(own, "link");
    await symlink(root, link);
    await expect(installSkills(manifest, link)).rejects.toThrow("regular directory");
    await chmod(root, 0o755);
    await rm(join(root, ".manifest.json"));
    await expect(installSkills(manifest, root)).rejects.toThrow();
  } finally {
    async function unseal(path: string) {
      const { readdir, lstat } = await import("node:fs/promises");
      await chmod(path, 0o755);
      for (const name of await readdir(path)) {
        const child = join(path, name);
        if ((await lstat(child)).isDirectory()) await unseal(child);
      }
    }
    await unseal(own);
    await rm(own, { recursive: true, force: true });
  }
});
