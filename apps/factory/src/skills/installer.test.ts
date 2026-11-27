import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "../../../../deploy/opencode-server/install-skills.mjs";
import { fixtureValue } from "../../../../test/fixtures/value";
import { nativeSkillManifest } from "./native";
import { requirementsInterviewSkill } from "./reviewed";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function packageManifest() {
  return nativeSkillManifest([
    {
      id: crypto.randomUUID(),
      revision: 1,
      content: {
        ...requirementsInterviewSkill,
        files: [
          { path: "assets/logo.bin", body: "AAECAw==", encoding: "base64" },
          {
            path: "scripts/check.sh",
            body: "#!/bin/sh\nprintf 'owned skill\\n'\n",
            encoding: "utf8",
            executable: true,
          },
        ],
      },
      digest: "a".repeat(64),
      published: true,
    },
  ]);
}

async function unseal(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(path, 0o755);
  for (const name of await readdir(path)) await unseal(join(path, name));
}

async function withStorage(
  run: (root: string, manifest: ReturnType<typeof nativeSkillManifest>) => Promise<void>,
) {
  const own = await mkdtemp(join(tmpdir(), "factory-skills-proof-"));
  try {
    await run(join(own, "admitted"), packageManifest());
  } finally {
    await unseal(own);
    await rm(own, { recursive: true, force: true });
  }
}

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
    const target = join(root, fixtureValue(manifest.files[0], "manifest.files[0]").path);
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
    await unseal(own);
    await rm(own, { recursive: true, force: true });
  }
});

test("native installer seals exact binary, executable and manifest bytes for read-only Work use", async () => {
  await withStorage(async (root, manifest) => {
    await installSkills(manifest, root);
    expect((await lstat(root)).mode & 0o7777).toBe(0o555);
    const metadata = join(root, ".manifest.json");
    expect((await lstat(metadata)).mode & 0o7777).toBe(0o444);
    expect(JSON.parse(await readFile(metadata, "utf8"))).toEqual(manifest);
    for (const file of manifest.files) {
      const target = join(root, file.path);
      const info = await lstat(target);
      expect({ uid: info.uid, gid: info.gid, links: info.nlink }).toEqual({
        uid: fixtureValue(process.getuid?.(), "POSIX owner UID"),
        gid: fixtureValue(process.getgid?.(), "POSIX owner GID"),
        links: 1,
      });
      expect(info.mode & 0o7777).toBe(file.executable ? 0o555 : 0o444);
      expect(await readFile(target)).toEqual(Buffer.from(file.body, "base64"));
    }
    await installSkills(manifest, root);
  });
});

for (const mutation of [
  "manifest-symlink",
  "file-symlink",
  "manifest-hardlink",
  "file-hardlink",
  "writable-root",
  "writable-directory",
  "writable-file",
  "writable-manifest",
  "executable-bit",
  "manifest-files",
  "extra-directory",
] as const)
  test(`native installer refuses retained ${mutation} without repairing it`, async () => {
    await withStorage(async (root, manifest) => {
      await installSkills(manifest, root);
      const file = fixtureValue(
        manifest.files.find((entry) => entry.executable),
        "executable skill file",
      );
      const target = join(root, file.path);
      const metadata = join(root, ".manifest.json");
      if (mutation.endsWith("-symlink") || mutation.endsWith("-hardlink")) {
        const selected = mutation.startsWith("manifest") ? metadata : target;
        const copy = join(root, "..", "replacement");
        await writeFile(copy, await readFile(selected), { mode: 0o444 });
        await chmod(join(selected, ".."), 0o755);
        await rm(selected);
        if (mutation.endsWith("-symlink")) await symlink(copy, selected);
        else await link(copy, selected);
        await chmod(join(selected, ".."), 0o555);
      } else if (mutation === "writable-root") await chmod(root, 0o755);
      else if (mutation === "writable-directory") await chmod(join(target, ".."), 0o755);
      else if (mutation === "writable-file") await chmod(target, 0o755);
      else if (mutation === "writable-manifest") await chmod(metadata, 0o644);
      else if (mutation === "executable-bit") await chmod(target, 0o444);
      else if (mutation === "extra-directory") {
        await chmod(root, 0o755);
        await mkdir(join(root, "unadmitted"), { mode: 0o555 });
        await chmod(root, 0o555);
      } else {
        await chmod(metadata, 0o644);
        await writeFile(metadata, JSON.stringify({ ...manifest, files: [] }));
        await chmod(metadata, 0o444);
      }
      await expect(installSkills(manifest, root)).rejects.toThrow();
    });
  });

test("native installer refuses writable or symlink storage parents without creating storage", async () => {
  await withStorage(async (root, manifest) => {
    const parent = join(root, "..");
    await chmod(parent, 0o777);
    await expect(installSkills(manifest, root)).rejects.toThrow("permissions");
    expect((await lstat(parent)).mode & 0o777).toBe(0o777);
    expect(await readdir(parent)).toEqual([]);
    await chmod(parent, 0o700);
    const alias = join(parent, "alias");
    await symlink(parent, alias);
    await expect(installSkills(manifest, join(alias, "admitted"))).rejects.toThrow(
      "regular directory",
    );
    expect(await readdir(parent)).toEqual(["alias"]);
  });
});

for (const invalid of [
  "traversal",
  "duplicate",
  "file-digest",
  "manifest-digest",
  "file-count",
] as const)
  test(`native installer validates ${invalid} before writing`, async () => {
    await withStorage(async (root, manifest) => {
      const file = fixtureValue(manifest.files[0], "first admitted file");
      if (invalid === "traversal") file.path = file.path.replace("SKILL.md", "../escaped");
      else if (invalid === "duplicate") manifest.files.push(file);
      else if (invalid === "file-digest") file.body = Buffer.from("changed").toString("base64");
      else if (invalid === "file-count") manifest.files = Array.from({ length: 1101 }, () => file);
      manifest.digest =
        invalid === "manifest-digest" ? "a".repeat(64) : hash(JSON.stringify(manifest.files));
      await expect(installSkills(manifest, root)).rejects.toThrow("Invalid admitted skill");
      expect(await readdir(join(root, ".."))).toEqual([]);
    });
  });
